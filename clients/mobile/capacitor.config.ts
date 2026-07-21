import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration for the Traycer mobile runner.
 *
 * `webDir` points at `dist/web/` - the output folder produced by Vite when
 * building `src/web/index.html`. The mobile renderer consumes the `gui-app`
 * workspace library directly, so there is no separate staging step; `cap
 * sync` copies the built `dist/web/` into the native Android/iOS projects.
 *
 * This first client-only milestone targets the iOS Simulator. The `http`
 * scheme gives the packaged WebView an origin accepted by the existing
 * loopback WebSocket guard, while CapacitorHttp patches `fetch` so auth calls
 * are performed by the native layer rather than being decided by WKWebView
 * CORS.
 */
const config: CapacitorConfig = {
  appId: "com.traycer.app",
  appName: "Traycer",
  webDir: "dist/web",
  ios: {
    contentInset: "always",
  },
  server: {
    iosScheme: "http",
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
