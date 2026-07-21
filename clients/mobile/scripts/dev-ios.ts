import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeDevDesktopSlot } from "@traycer-clients/shared/platform/dev-desktop-slot";

interface DevIosOptions {
  readonly slot: string;
  readonly target: string;
}

interface DevRunUrls {
  readonly authnBaseUrl: string;
  readonly cloudUiBaseUrl: string;
  readonly guiAppBaseUrl: URL;
}

const mobileRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readFlag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requiredValue(
  args: readonly string[],
  flag: string,
  envName: string,
): string {
  const value = readFlag(args, flag) ?? process.env[envName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} or ${envName} is required`);
  }
  return value.trim();
}

function bootedSimulatorId(): string {
  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Could not read booted Simulator devices");
  }
  const devices = (parsed as Record<string, unknown>).devices;
  if (devices === null || typeof devices !== "object") {
    throw new Error("Could not read booted Simulator devices");
  }
  const ids = Object.values(devices)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === "object",
    )
    .filter((value) => value.state === "Booted")
    .map((value) => value.udid)
    .filter((value): value is string => typeof value === "string");
  if (ids.length !== 1) {
    throw new Error(
      "Boot exactly one iOS Simulator or pass --target/IOS_SIMULATOR_UDID",
    );
  }
  return ids[0];
}

function parseOptions(args: readonly string[]): DevIosOptions {
  if (args.includes("--help")) {
    console.log("bun run dev:ios -- --slot <slot> [--target <simulator-udid>]");
    process.exit(0);
  }
  const rawSlot = requiredValue(args, "--slot", "DEV_DESKTOP_SLOT");
  const slot = sanitizeDevDesktopSlot(rawSlot);
  if (slot.length === 0) {
    throw new Error("DEV_DESKTOP_SLOT must contain a usable slot name");
  }
  return {
    slot,
    target:
      readFlag(args, "--target") ??
      process.env.IOS_SIMULATOR_UDID ??
      bootedSimulatorId(),
  };
}

function readDevRunUrls(slot: string): DevRunUrls {
  const runMetadataPath = join(
    homedir(),
    ".traycer",
    "host",
    "dev-runs",
    slot,
    "run.json",
  );
  const parsed: unknown = JSON.parse(readFileSync(runMetadataPath, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid dev run metadata at ${runMetadataPath}`);
  }
  const metadata = parsed as Record<string, unknown>;
  const urls = metadata.urls;
  if (urls === null || typeof urls !== "object") {
    throw new Error(
      `Dev run ${slot} does not publish a GUI App URL; restart make dev-desktop`,
    );
  }
  const urlRecord = urls as Record<string, unknown>;
  const authnBaseUrl = urlRecord.authnBaseUrl;
  const cloudUiBaseUrl = urlRecord.cloudUiBaseUrl;
  const guiAppBaseUrl = urlRecord.guiAppBaseUrl;
  if (
    typeof authnBaseUrl !== "string" ||
    typeof cloudUiBaseUrl !== "string" ||
    typeof guiAppBaseUrl !== "string"
  ) {
    throw new Error(
      `Dev run ${slot} does not publish GUI App development URLs; restart make dev-desktop`,
    );
  }
  const url = new URL(guiAppBaseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`Invalid GUI App URL in ${runMetadataPath}`);
  }
  return { authnBaseUrl, cloudUiBaseUrl, guiAppBaseUrl: url };
}

async function waitForGuiApp(url: URL): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`GUI App dev server did not become ready at ${url.origin}`);
}

function ensureWebAssets(slot: string, urls: DevRunUrls): void {
  if (existsSync(join(mobileRoot, "dist", "web", "index.html"))) return;
  console.log("[gui-app] building initial local web assets for Capacitor");
  const build = spawnSync("bun", ["run", "build:web"], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      DEV_DESKTOP_SLOT: slot,
      PORT: urls.guiAppBaseUrl.port,
      TRAYCER_DEV_AUTHN_BASE_URL: urls.authnBaseUrl,
      TRAYCER_DEV_CLOUD_UI_BASE_URL: urls.cloudUiBaseUrl,
    },
    stdio: "inherit",
  });
  if (build.error !== undefined) throw build.error;
  if (build.status !== 0) {
    throw new Error(`GUI App web build failed with exit ${build.status}`);
  }
}

const options = parseOptions(process.argv.slice(2));
const urls = readDevRunUrls(options.slot);
await waitForGuiApp(urls.guiAppBaseUrl);
ensureWebAssets(options.slot, urls);
console.log(
  `[gui-app] slot=${options.slot} simulator=${options.target} url=${urls.guiAppBaseUrl.origin}`,
);
const capacitor = spawn(
  "bun",
  [
    "x",
    "cap",
    "run",
    "ios",
    "--target",
    options.target,
    "--live-reload",
    "--host",
    urls.guiAppBaseUrl.hostname,
    "--port",
    urls.guiAppBaseUrl.port,
  ],
  {
    cwd: mobileRoot,
    env: process.env,
    stdio: "inherit",
  },
);
const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
  capacitor.once("error", rejectExit);
  capacitor.once("exit", (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log(
  "[gui-app] Capacitor is connected to the shared live-reload server",
);
