import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import {
  TraycerApp,
  hostRpcRegistry,
  setMobileApp,
} from "@traycer-clients/gui-app";
import type {
  RemoteHostFetcher,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  registerDevicePushTokenViaHttp,
  removeDevicePushTokenViaHttp,
} from "@traycer-clients/shared/auth/push-token-fetcher";
import "./index.css";
import { MobileRunnerHost } from "../mobile-runner-host";
import {
  MobilePushRegistration,
  pushRegistrationTarget,
} from "../push-registration";

/**
 * OS push exists only inside the native shells - the dev web entry has no
 * push plugin, so `pushRegistrationTarget` returns `null` for it and the
 * runner host's click sink stays the familiar no-op. The per-platform
 * `(platform, environment)` rule, including why Android is always
 * `production`, lives with that function.
 */
function buildPushRegistration(
  authnBaseUrl: string,
): MobilePushRegistration | null {
  const target = pushRegistrationTarget(
    Capacitor.getPlatform(),
    import.meta.env.DEV,
  );
  if (target === null) {
    return null;
  }
  return new MobilePushRegistration({
    plugin: PushNotifications,
    authnBaseUrl,
    platform: target.platform,
    environment: target.environment,
    registerToken: registerDevicePushTokenViaHttp,
    removeToken: removeDevicePushTokenViaHttp,
  });
}

const config = __TRAYCER_GUI_APP_DEV_CONFIG__;

// The baked `config.host` captures the port as of Vite startup, which goes
// stale whenever the dev host restarts; the dev-server endpoint re-reads the
// host's pid.json per request, so each directory refresh gets the live port.
// BROWSER-TESTING SCAFFOLDING (dev web entry only): superseded by real
// remote-host discovery in the shipped mobile client.
const bakedHost: RemoteHostFetchOutcome = {
  kind: "hosts",
  entries: [config.host],
};

const remoteFetcher: RemoteHostFetcher = async () => {
  try {
    const response = await fetch(config.devHostPath);
    if (!response.ok) return bakedHost;
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object") return bakedHost;
    const record = parsed as Record<string, unknown>;
    const { hostId, version, websocketUrl } = record;
    if (
      typeof hostId !== "string" ||
      typeof version !== "string" ||
      typeof websocketUrl !== "string"
    ) {
      return bakedHost;
    }
    return {
      kind: "hosts",
      entries: [{ ...config.host, hostId, version, websocketUrl }],
    };
  } catch {
    // The baked entry, not `failed`: this scaffolding's whole point is that the
    // dev host is reachable at a known port even when the pid re-read misses.
    return bakedHost;
  }
};

function bootstrap(): void {
  document.documentElement.classList.add("traycer-mobile-client");
  // PRODUCT flag, not layout: unlocks mobile-app-only UX policy such as the
  // single-composer draft model. See gui-app's `src/lib/mobile-app.ts` for
  // how this differs from the viewport signal.
  setMobileApp(true);
  const pushRegistration = buildPushRegistration(config.authnBaseUrl);
  const host = new MobileRunnerHost({
    signInUrl: config.signInUrl,
    authnBaseUrl: config.authnBaseUrl,
    hostLabel: config.host.label,
    relayBaseUrl: config.relayBaseUrl,
    pushRegistration,
  });
  // After the host exists: registration follows the token store (sign-in,
  // app start while signed in, sign-out), and the plugin listeners attach
  // now so a cold-start tap is captured before the GUI mounts.
  pushRegistration?.start(host.tokenStore);
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
