import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TraycerApp, hostRpcRegistry } from "@traycer-clients/gui-app";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import "./index.css";
import { MobileRunnerHost } from "../mobile-runner-host";

const config = __TRAYCER_GUI_APP_DEV_CONFIG__;
const remoteFetcher: RemoteHostFetcher = async () => [config.host];

function bootstrap(): void {
  document.documentElement.classList.add("traycer-mobile-client");
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
