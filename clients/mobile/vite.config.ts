import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import { sanitizeDevDesktopSlot } from "../shared/platform/dev-desktop-slot";
import { devRelayBaseUrlFromEnv } from "../shared/platform/dev-backend-urls";

// Dev-server endpoint that re-reads the host's pid.json on every request. The
// baked define config only captures the host port as of Vite startup; the dev
// host allocates a fresh port each stack restart and often comes up AFTER
// Vite has read the previous run's file, so the client must be able to ask
// for the current address at runtime.
//
// BROWSER-TESTING SCAFFOLDING: this exists only for driving the web entry
// against a local `make dev-desktop` host. The shipped mobile client reaches
// remote hosts through real host discovery and must not depend on this.
const DEV_HOST_PATH = "/__traycer/dev-host";
/** Mirrors the desktop's baked value (`clients/desktop/src/config.ts`). */
const RELAY_BASE_URL = "wss://relay.traycer.ai/attach";

interface DevHostPid {
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
}

const mobileRoot = __dirname;
const clientsRoot = resolve(mobileRoot, "..");
const guiAppRoot = resolve(clientsRoot, "gui-app");
const sharedRoot = resolve(clientsRoot, "shared");
const protocolRoot = resolve(clientsRoot, "..", "protocol");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for the GUI App dev server`);
  }
  return value.trim();
}

function parseHttpBaseUrl(name: string, raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.origin;
}

function devHostPidPath(slot: string): string {
  return join(homedir(), ".traycer", "host", "dev-runs", slot, "pid.json");
}

async function readDevHost(slot: string): Promise<DevHostPid> {
  const pidPath = devHostPidPath(slot);
  const deadline = Date.now() + 30_000;
  let raw: string | null = null;
  while (raw === null && Date.now() < deadline) {
    try {
      raw = readFileSync(pidPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  if (raw === null) {
    throw new Error(`Timed out waiting for host metadata at ${pidPath}`);
  }
  return parseDevHostPid(raw, pidPath);
}

function parseDevHostPid(raw: string, pidPath: string): DevHostPid {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid host metadata at ${pidPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const hostId = record.hostId;
  const version = record.version;
  const websocketUrl = record.websocketUrl;
  if (
    typeof hostId !== "string" ||
    hostId.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof websocketUrl !== "string" ||
    websocketUrl.length === 0
  ) {
    throw new Error(`Incomplete host metadata at ${pidPath}`);
  }
  const parsedWebsocketUrl = new URL(websocketUrl);
  if (
    parsedWebsocketUrl.protocol !== "ws:" &&
    parsedWebsocketUrl.protocol !== "wss:"
  ) {
    throw new Error(`Host metadata at ${pidPath} has a non-WebSocket URL`);
  }
  return { hostId, version, websocketUrl };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function devHostEndpoint(slot: string): Plugin {
  return {
    name: "traycer-dev-host-endpoint",
    configureServer(server) {
      server.middlewares.use(DEV_HOST_PATH, (_request, response) => {
        const pidPath = devHostPidPath(slot);
        let host: DevHostPid;
        try {
          host = parseDevHostPid(readFileSync(pidPath, "utf8"), pidPath);
        } catch {
          response.statusCode = 503;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(host));
      });
    },
  };
}

async function guiAppDevConfig(): Promise<TraycerGuiAppDevConfig> {
  const rawSlot = requiredEnv("DEV_DESKTOP_SLOT");
  const slot = sanitizeDevDesktopSlot(rawSlot);
  if (slot.length === 0) {
    throw new Error("DEV_DESKTOP_SLOT must contain a usable slot name");
  }
  const authnBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_AUTHN_BASE_URL",
    requiredEnv("TRAYCER_DEV_AUTHN_BASE_URL"),
  );
  const cloudUiBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_CLOUD_UI_BASE_URL",
    requiredEnv("TRAYCER_DEV_CLOUD_UI_BASE_URL"),
  );
  const host = await readDevHost(slot);
  return {
    authnBaseUrl,
    signInUrl: new URL("/sign-in", cloudUiBaseUrl).toString(),
    // Same dev-gated posture as the desktop's `config.ts`: the shipped relay
    // endpoint unless this run exports its own (`make dev-remote` does). This
    // config only ever builds in dev, so the environment argument is fixed.
    relayBaseUrl: devRelayBaseUrlFromEnv(
      "dev",
      "TRAYCER_DEV_RELAY_BASE_URL",
      RELAY_BASE_URL,
      process.env,
    ),
    devHostPath: DEV_HOST_PATH,
    host: {
      hostId: host.hostId,
      label: slot,
      kind: "remote",
      websocketUrl: host.websocketUrl,
      version: host.version,
      status: "available",
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  const devConfig = await guiAppDevConfig();
  const portRaw = requiredEnv("PORT");
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }

  return {
    root: resolve(mobileRoot, "src", "web"),
    define: {
      __TRAYCER_GUI_APP_DEV_CONFIG__: JSON.stringify(devConfig),
    },
    plugins: [
      devHostEndpoint(devConfig.host.label),
      tanstackRouter({
        enableRouteGeneration: false,
        target: "react",
        quoteStyle: "double",
        semicolons: true,
        autoCodeSplitting: true,
        routeFileIgnorePattern: "__tests__|route-components|route-search",
        routesDirectory: resolve(guiAppRoot, "src", "routes"),
        generatedRouteTree: resolve(guiAppRoot, "src", "routeTree.gen.ts"),
      }),
      react(),
      tailwindcss(),
      babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
        ...plugin,
        enforce: "post" as const,
      })),
    ],
    resolve: {
      alias: {
        "@traycer/protocol/utils": resolve(protocolRoot, "utils"),
        "@traycer/protocol": resolve(protocolRoot, "src"),
        "@traycer-clients/gui-app": guiAppRoot,
        "@traycer-clients/shared": sharedRoot,
        "@": resolve(guiAppRoot, "src"),
      },
    },
    build: {
      target: "es2022",
      emptyOutDir: true,
      outDir: resolve(mobileRoot, "dist", "web"),
      sourcemap: false,
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  };
});
