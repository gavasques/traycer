import {
  mintLinkLoginCodeResponseSchema,
  redeemLinkLoginCodeResponseSchema,
  type MintLinkLoginCodeResponse,
  type RedeemLinkLoginCodeResponse,
} from "@traycer/protocol/auth/link-login";

/**
 * Link-login ("link a phone") HTTP client: a signed-in surface mints a
 * one-time code and renders it as a QR; the phone redeems it once for its own
 * token pair. Zero DI, ambient `fetch` only — runs in the browser shell, the
 * Electron renderer, and the Capacitor WebView identically, like the
 * device-flow client.
 */

const LINK_LOGIN_FETCH_TIMEOUT_MS = 10_000;

/**
 * QR payload format, version 1.
 *
 * The QR encodes `traycer://link-login?code=<code>` — URL-shaped so the
 * `traycer` custom scheme the mobile app already registers can adopt it as a
 * real deep link later (OS camera → app), while the in-app scanner simply
 * parses the `code` query parameter. The raw code is also accepted on the
 * manual-entry path, so a user can type what the desktop shows under the QR.
 */
const LINK_LOGIN_QR_SCHEME = "traycer:";
const LINK_LOGIN_QR_HOST = "link-login";
// base64url of 32 random bytes, as authn mints it. Anchored so the manual
// path cannot mistake arbitrary pasted prose for a code.
const RAW_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type MintLinkLoginCodeFetchResult =
  | { readonly kind: "ok"; readonly response: MintLinkLoginCodeResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type RedeemLinkLoginCodeFetchResult =
  | { readonly kind: "ok"; readonly response: RedeemLinkLoginCodeResponse }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "network-error" };

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

export function buildLinkLoginQrPayload(code: string): string {
  return `${LINK_LOGIN_QR_SCHEME}//${LINK_LOGIN_QR_HOST}?code=${encodeURIComponent(code)}`;
}

/**
 * Extracts a link-login code from scanned or pasted text: the v1 QR payload
 * URL, or the bare code itself (the manual-entry path). Returns `null` when
 * the text carries no plausible code — never a guess.
 */
export function parseLinkLoginInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (RAW_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== LINK_LOGIN_QR_SCHEME) {
    return null;
  }
  // Custom-scheme URLs parse host-vs-path differently across engines; accept
  // the payload wherever `link-login` landed.
  if (
    url.host !== LINK_LOGIN_QR_HOST &&
    url.pathname.replace(/^\/+/, "") !== LINK_LOGIN_QR_HOST
  ) {
    return null;
  }
  const code = url.searchParams.get("code");
  return code !== null && RAW_CODE_PATTERN.test(code) ? code : null;
}

/** Mints a one-time link-login code under the caller's bearer. */
export async function mintLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<MintLinkLoginCodeFetchResult> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(LINK_LOGIN_FETCH_TIMEOUT_MS);
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/auth/link/mint"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: signal === null ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = mintLinkLoginCodeResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return parsed.success
    ? { kind: "ok", response: parsed.data }
    : { kind: "network-error" };
}

/**
 * Redeems a code for a token pair. Unauthenticated: the code is the whole
 * authorization. A 401 here means the code is unknown, expired, or already
 * used — the server deliberately does not say which.
 */
export async function redeemLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  code: string,
): Promise<RedeemLinkLoginCodeFetchResult> {
  let response: Response;
  try {
    response = await fetch(
      authnApiUrl(authnBaseUrl, "api/v3/auth/link/redeem"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(LINK_LOGIN_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    return { kind: "network-error" };
  }
  if (response.status === 401) {
    return { kind: "invalid-code" };
  }
  if (response.status === 429) {
    return { kind: "rate-limited" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = redeemLinkLoginCodeResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return parsed.success
    ? { kind: "ok", response: parsed.data }
    : { kind: "network-error" };
}
