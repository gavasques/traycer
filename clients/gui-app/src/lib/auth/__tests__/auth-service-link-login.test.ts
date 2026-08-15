/**
 * The link-login attempt fence: link claim/poll runs inside the SAME
 * `Attempt` lifecycle as device sign-in, so a link attempt superseded by a
 * newer sign-in is a silent no-op — its late approval can never overwrite
 * the newer session, and its late denial can never project a global
 * failure over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const CLAIM_URL = "http://localhost:5005/api/v3/auth/link/claim";
const TOKEN_URL = "http://localhost:5005/api/v3/auth/link/token";

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface LinkFetchScript {
  /** Mutable: the next token-poll outcome. */
  tokenResponse: () => Response;
  readonly tokenPolls: string[];
}

function installLinkFetch(): { script: LinkFetchScript; restore: () => void } {
  const script: LinkFetchScript = {
    tokenResponse: () => json({ error: "authorization_pending" }, 428),
    tokenPolls: [],
  };
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url === CLAIM_URL) {
        return Promise.resolve(
          json({ status: "claimed", secret: "S".repeat(43), interval: 1 }, 200),
        );
      }
      if (url === TOKEN_URL) {
        script.tokenPolls.push(url);
        return Promise.resolve(script.tokenResponse());
      }
      // Anything else (validation, refresh) answering 401 keeps stray calls
      // from accidentally signing anything in.
      return Promise.resolve(new Response(null, { status: 401 }));
    },
  });
  return {
    script,
    restore: () => {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useAuthStore.getState().setSignedOut();
});

afterEach(() => {
  for (const service of trackedServices.splice(0)) {
    service.dispose();
  }
  useAuthStore.getState().setSignedOut();
  vi.useRealTimers();
});

describe("link-login attempt fence", () => {
  it("a late approval of a superseded link attempt is discarded, never applied", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      // Let the claim land and one pending poll pass.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(script.tokenPolls.length).toBeGreaterThan(0);
      expect(useAuthStore.getState().status).toBe("signing-in");

      // A newer sign-in supersedes the link attempt.
      const deviceSignIn = service.signIn();

      // The next link poll would come back authorized — but the attempt is
      // no longer current, so the tokens must be dropped without ever being
      // validated or persisted.
      script.tokenResponse = () =>
        json(
          {
            token: "stolen-token",
            refreshToken: "stolen-refresh",
            familyId: "f",
          },
          200,
        );
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await linkResult;
      expect(result.kind).toBe("failed");

      const stored = service.getCurrentSessionSnapshot();
      expect(stored.token).not.toBe("stolen-token");
      await deviceSignIn;
    } finally {
      restore();
    }
  });

  it("a late denial of a superseded link attempt cannot project a global failure", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);

      const deviceSignIn = service.signIn();
      const statusAfterSupersede = useAuthStore.getState().status;

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await linkResult;
      // Silent no-op: no error surfaced, the superseding flow owns the state.
      expect(result.kind).toBe("failed");
      expect(service.getLastError()).toBeNull();
      expect(useAuthStore.getState().status).toBe(statusAfterSupersede);
      await deviceSignIn;
    } finally {
      restore();
    }
  });

  it("terminal denial of the CURRENT attempt projects the ordinary failure", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      const resultPromise = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;
      expect(result.kind).toBe("denied");
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).not.toBeNull();
    } finally {
      restore();
    }
  });
});
