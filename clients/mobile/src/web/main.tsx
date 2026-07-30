import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  TraycerApp,
  hostRpcRegistry,
  setMobileApp,
} from "@traycer-clients/gui-app";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import "./index.css";
import { MobileRunnerHost } from "../mobile-runner-host";

const config = __TRAYCER_GUI_APP_DEV_CONFIG__;

// The baked `config.host` captures the port as of Vite startup, which goes
// stale whenever the dev host restarts; the dev-server endpoint re-reads the
// host's pid.json per request, so each directory refresh gets the live port.
// BROWSER-TESTING SCAFFOLDING (dev web entry only): superseded by real
// remote-host discovery in the shipped mobile client.
const remoteFetcher: RemoteHostFetcher = async () => {
  try {
    const response = await fetch(config.devHostPath);
    if (!response.ok) return [config.host];
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object") return [config.host];
    const record = parsed as Record<string, unknown>;
    const { hostId, version, websocketUrl } = record;
    if (
      typeof hostId !== "string" ||
      typeof version !== "string" ||
      typeof websocketUrl !== "string"
    ) {
      return [config.host];
    }
    return [{ ...config.host, hostId, version, websocketUrl }];
  } catch {
    return [config.host];
  }
};

function bootstrap(): void {
  document.documentElement.classList.add("traycer-mobile-client");
  // PRODUCT flag, not layout: unlocks mobile-app-only UX policy such as the
  // single-composer draft model. See gui-app's `src/lib/mobile-app.ts` for
  // how this differs from the viewport signal.
  setMobileApp(true);
  const host = new MobileRunnerHost({
    signInUrl: config.signInUrl,
    authnBaseUrl: config.authnBaseUrl,
    hostLabel: config.host.label,
  });
  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }
  createRoot(container).render(
    <StrictMode>
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={remoteFetcher}
      />
    </StrictMode>,
  );
}

bootstrap();
