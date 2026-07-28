import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

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
  server: {
    iosScheme: "http",
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    // Without the Keyboard plugin WKWebView leaves the webview full-height
    // and overlays the soft keyboard, hiding the terminal key bar behind it.
    // "native" resizes the whole webview on show/hide, so the h-dvh app shell
    // (key bar included) tracks the visible area and the gui-app's
    // visualViewport inset fallback measures 0 here.
    Keyboard: {
      resize: KeyboardResize.Native,
      // Tint the strip iOS exposes behind the keyboard during show/hide from
      // the DOM body background; the default ("off") flashes white against a
      // dark theme on every keyboard animation.
      autoBackdropColor: "dom",
    },
  },
};

export default config;
