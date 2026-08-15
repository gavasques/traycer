import {
  claimLinkLoginCodeResponseSchema,
  linkLoginStatusResponseSchema,
  linkLoginTokenResponseSchema,
  mintLinkLoginCodeResponseSchema,
  respondLinkLoginResponseSchema,
  type LinkLoginStatusResponse,
  type LinkLoginTokenResponse,
  type MintLinkLoginCodeResponse,
} from "@traycer/protocol/auth/link-login";
import type { z } from "zod";

/**
 * Link-login ("link a phone") HTTP client for the confirm-gated flow: the
 * desktop mints and approves; the phone claims and polls with the private
 * secret its claim returned. Zero DI, ambient `fetch` only — runs in the
 * browser shell, the Electron renderer, and the Capacitor WebView
 * identically, like the device-flow client.
 */

const LINK_LOGIN_FETCH_TIMEOUT_MS = 10_000;

/**
 * QR payload format, version 1.
 *
 * The QR encodes `traycer://link-login?code=<XXXXX-XXXXX>` — URL-shaped so
 * the `traycer` custom scheme the mobile app already registers can adopt it
 * as a real deep link later (OS camera → app), while the in-app scanner
 * simply parses the `code` query parameter. The bare code is also accepted
 * on the manual-entry path, with the device flow's normalization (case,
 * dashes, the I/L→1 and O→0 visual folds).
 */
const LINK_LOGIN_QR_SCHEME = "traycer:";
const LINK_LOGIN_QR_HOST = "link-login";
// The public code's canonical shape: 10 Crockford base32 chars (no I/L/O/U),
// matched AFTER normalization.
const NORMALIZED_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export type MintLinkLoginCodeFetchResult =
  | { readonly kind: "ok"; readonly response: MintLinkLoginCodeResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type ClaimLinkLoginCodeFetchResult =
  | {
      readonly kind: "claimed";
      readonly secret: string;
      readonly pollIntervalSeconds: number;
    }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "network-error" };

export type LinkLoginTokenFetchResult =
  | { readonly kind: "authorized"; readonly response: LinkLoginTokenResponse }
  | { readonly kind: "authorization-pending" }
  | { readonly kind: "slow-down"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "access-denied" }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "network-error" };

export type LinkLoginStatusFetchResult =
  | { readonly kind: "ok"; readonly response: LinkLoginStatusResponse }
  | { readonly kind: "gone" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type RespondLinkLoginFetchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "already-decided" }
  | { readonly kind: "gone" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

/**
 * Client-side mirror of the server's user_code normalization: uppercase,
 * dashes/whitespace stripped, `I`/`L` → `1`, `O` → `0`.
 */
export function normalizeLinkLoginCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function buildLinkLoginQrPayload(code: string): string {
  return `${LINK_LOGIN_QR_SCHEME}//${LINK_LOGIN_QR_HOST}?code=${encodeURIComponent(code)}`;
}

/**
 * Extracts a public link code from scanned or pasted text: the v1 QR payload
 * URL, or the typed code itself (any dash/case variation the normalization
 * accepts). Returns the NORMALIZED code, or `null` when the text carries no
 * plausible code — never a guess.
 */
export function parseLinkLoginInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const direct = normalizeLinkLoginCodeInput(trimmed);
  if (NORMALIZED_CODE_PATTERN.test(direct)) {
    return direct;
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
  if (code === null) {
    return null;
  }
  const normalized = normalizeLinkLoginCodeInput(code);
  return NORMALIZED_CODE_PATTERN.test(normalized) ? normalized : null;
}

async function postJson(
  authnBaseUrl: string,
  path: string,
  bearerToken: string | null,
  body: object,
  signal: AbortSignal | null,
): Promise<Response | null> {
  const timeout = AbortSignal.timeout(LINK_LOGIN_FETCH_TIMEOUT_MS);
  try {
    return await fetch(authnApiUrl(authnBaseUrl, path), {
      method: "POST",
      headers: {
        ...(bearerToken === null
          ? {}
          : { Authorization: `Bearer ${bearerToken}` }),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal === null ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch {
    return null;
  }
}

async function parseOk<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Mints a public link code under the caller's bearer. */
export async function mintLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<MintLinkLoginCodeFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/mint",
    bearerToken,
    {},
    signal,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, mintLinkLoginCodeResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

/**
 * The phone attaches itself to a scanned/typed code. First scan wins and
 * ONLY that response carries the polling secret; claiming grants nothing
 * else. A 401 means the code is unknown, expired, or already
 * claimed/decided; the server deliberately does not say which.
 */
export async function claimLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  code: string,
): Promise<ClaimLinkLoginCodeFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/claim",
    null,
    { code },
    null,
  );
  if (response === null) {
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
  const parsed = await parseOk(response, claimLinkLoginCodeResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : {
        kind: "claimed",
        secret: parsed.secret,
        pollIntervalSeconds: parsed.interval,
      };
}

/**
 * One result poll BY SECRET after a claim. Non-terminal states mirror the
 * device flow's token endpoint: 428 pending, 429 pacing; 400 is the
 * desktop's explicit rejection.
 */
export async function linkLoginTokenViaHttp(
  authnBaseUrl: string,
  secret: string,
): Promise<LinkLoginTokenFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/token",
    null,
    { secret },
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 428) {
    return { kind: "authorization-pending" };
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    // A body-less 429 from the outer rate limiter and the engine's paced
    // slow_down both land here; the caller just waits.
    return {
      kind: "slow-down",
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    };
  }
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => null);
    const error =
      body !== null && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : null;
    return error === "access_denied"
      ? { kind: "access-denied" }
      : { kind: "network-error" };
  }
  if (response.status === 401) {
    return { kind: "invalid-code" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, linkLoginTokenResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "authorized", response: parsed };
}

/** The minting desktop's view of its own code (bearer, owner-only). */
export async function linkLoginStatusViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  code: string,
  signal: AbortSignal | null,
): Promise<LinkLoginStatusFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/status",
    bearerToken,
    { code },
    signal,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "gone" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, linkLoginStatusResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

/** The desktop's decision on its own claimed code (bearer, owner-only). */
export async function respondLinkLoginViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  code: string,
  approve: boolean,
): Promise<RespondLinkLoginFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/respond",
    bearerToken,
    { code, approve },
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "gone" };
  }
  if (response.status === 409) {
    return { kind: "already-decided" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, respondLinkLoginResponseSchema);
  return parsed === null ? { kind: "network-error" } : { kind: "ok" };
}
