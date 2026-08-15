/**
 * Physical-iPhone dev lane (`bun run dev:ios:device`, or `make dev-ios-device`
 * from the internal repository).
 *
 * The Simulator lane (`dev-ios.ts`) leans on the Simulator sharing the Mac's
 * loopback; a real phone shares only the LAN. So this lane:
 *
 *   1. reads the running slot's `run.json` exactly like the Simulator lane,
 *   2. re-addresses the authn / cloud-ui URLs from `127.0.0.1` to the Mac's
 *      LAN IPv4 (the services already listen on all interfaces),
 *   3. starts its OWN Vite dev server bound to that LAN address (the slot's
 *      browser server stays on loopback and is untouched), and
 *   4. hands Capacitor a live-reload target at the LAN address, installing
 *      the app over cable on first run.
 *
 * Debug builds carry `Info-Dev.plist`, whose ATS exception is what lets the
 * WebView and native fetches use plain http against the LAN; release builds
 * keep the exception-free `Info.plist`. The app shell needs installing once —
 * afterwards each launch loads straight from this Vite server, so the loop is
 * "run this lane, open the app".
 *
 * The dev host's RPC socket stays loopback-only, so host-backed surfaces show
 * offline on the phone; account surfaces (sign-in, sessions, link-login) are
 * the point of this lane. Camera-less testing needs no lane at all — use
 * `make dev-ios` and the typed-code path in the Simulator.
 */
import { execFileSync, spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  mobileRoot,
  readDevRun,
  readFlag,
  requireSlot,
  waitForGuiApp,
  type DevRunUrls,
} from "./dev-run";

const DEFAULT_DEVICE_VITE_PORT = 5814;

function detectLanIpv4(): string {
  for (const iface of ["en0", "en1"]) {
    try {
      const ip = execFileSync("ipconfig", ["getifaddr", iface], {
        encoding: "utf8",
      }).trim();
      if (ip.length > 0) return ip;
    } catch {
      // Interface without an address — try the next one.
    }
  }
  throw new Error(
    "Could not detect a LAN IPv4 (tried en0/en1); pass --lan-ip <address>",
  );
}

function withLanHost(rawUrl: string, lanIp: string): string {
  const url = new URL(rawUrl);
  url.hostname = lanIp;
  return url.origin;
}

function parsePort(raw: string | null): number {
  if (raw === null) return DEFAULT_DEVICE_VITE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  return port;
}

function deviceLaneEnv(
  slot: string,
  lanUrls: DevRunUrls,
  lanIp: string,
  port: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEV_DESKTOP_SLOT: slot,
    PORT: String(port),
    TRAYCER_DEV_VITE_HOST: lanIp,
    TRAYCER_DEV_AUTHN_BASE_URL: lanUrls.authnBaseUrl,
    TRAYCER_DEV_CLOUD_UI_BASE_URL: lanUrls.cloudUiBaseUrl,
    TRAYCER_DEV_ALLOW_LAN_BACKEND: "1",
  };
}

/** Bake `dist/web` with the LAN addresses so even the offline fallback bundle points at reachable services. */
function buildLanWebAssets(env: NodeJS.ProcessEnv): void {
  console.log("[device] building web assets against the LAN addresses");
  const build = spawnSync("bun", ["run", "build:web"], {
    cwd: mobileRoot,
    env,
    stdio: "inherit",
  });
  if (build.error !== undefined) throw build.error;
  if (build.status !== 0) {
    throw new Error(`web build failed with exit ${build.status}`);
  }
}

const args = process.argv.slice(2);
const slot = requireSlot(args);
const lanIp = readFlag(args, "--lan-ip") ?? detectLanIpv4();
const port = parsePort(readFlag(args, "--port"));
const target = readFlag(args, "--target");

const run = readDevRun(slot);
const lanUrls: DevRunUrls = {
  authnBaseUrl: withLanHost(run.urls.authnBaseUrl, lanIp),
  cloudUiBaseUrl: withLanHost(run.urls.cloudUiBaseUrl, lanIp),
  guiAppBaseUrl: new URL(`http://${lanIp}:${port}/`),
};
const env = deviceLaneEnv(slot, lanUrls, lanIp, port);

buildLanWebAssets(env);

console.log(`[device] slot=${slot}`);
console.log(`[device] vite:   ${lanUrls.guiAppBaseUrl.origin}`);
console.log(`[device] authn:  ${lanUrls.authnBaseUrl}`);
console.log(`[device] cloud:  ${lanUrls.cloudUiBaseUrl}`);

const vite = spawn("bun", ["x", "vite", "--config", "vite.config.ts"], {
  cwd: mobileRoot,
  env,
  stdio: "inherit",
});
vite.once("exit", (code) => {
  // The phone loads everything from this server; without it the lane is over.
  process.exit(code ?? 1);
});
const stopVite = () => {
  vite.kill("SIGINT");
};
process.once("SIGINT", stopVite);
process.once("SIGTERM", stopVite);

await waitForGuiApp(lanUrls.guiAppBaseUrl);

const capacitorArgs = [
  "x",
  "cap",
  "run",
  "ios",
  ...(target === null ? [] : ["--target", target]),
  "--live-reload",
  "--host",
  lanIp,
  "--port",
  String(port),
];
// Without --target Capacitor lists simulators AND cable-connected devices and
// prompts; pick the physical phone there, or pass --target <udid> (find it
// via `xcrun xctrace list devices`).
const capacitor = spawn("bun", capacitorArgs, {
  cwd: mobileRoot,
  env,
  stdio: "inherit",
});
const capExit = await new Promise<number>((resolveExit, rejectExit) => {
  capacitor.once("error", rejectExit);
  capacitor.once("exit", (code) => resolveExit(code ?? 1));
});
if (capExit !== 0) {
  stopVite();
  process.exit(capExit);
}

console.log(
  "[device] app installed and pointed at this server; leave this running.",
);
console.log(
  "[device] loop: desktop Settings → Link a phone → scan (or type the code) in the app.",
);
// Keep serving until Ctrl-C: the installed app loads from this Vite server on
// every launch.
await new Promise(() => undefined);
