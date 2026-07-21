/// <reference types="vite/client" />

interface TraycerGuiAppDevConfig {
  readonly authnBaseUrl: string;
  readonly signInUrl: string;
  readonly host: {
    readonly hostId: string;
    readonly label: string;
    readonly kind: "remote";
    readonly websocketUrl: string;
    readonly version: string;
    readonly status: "available";
  };
}

declare const __TRAYCER_GUI_APP_DEV_CONFIG__: TraycerGuiAppDevConfig;
