/**
 * The link-login attempt fence: link claim/poll runs inside the SAME
 * `Attempt` lifecycle as device sign-in, so a link attempt superseded by a
 * newer sign-in is a silent no-op — its late approval can never overwrite
 * the newer session, and its late denial can never project a global
 * failure over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ITokenStore,
  StoredCredentials,
  StoredCredentialsIdentity,
} from "@traycer-clients/shared/platform/runner-host";
import {
  AUTH_ERROR_STORE_UNAVAILABLE,
  AuthService,
} from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const CLAIM_URL = "http://localhost:5005/api/v3/auth/link/claim";
const TOKEN_URL = "http://localhost:5005/api/v3/auth/link/token";
const VALIDATION_URL = "http://localhost:5005/api/v3/user";

const PROFILE_BODY = {
  user: {
    id: "user-1",
    name: "Test User",
    providerId: "gh-1",
    providerHandle: "test-user",
    providerType: "GITHUB",
    email: "test@example.com",
    avatarUrl: null,
    activatedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: null,
    privacyMode: false,
    isLearningEnabled: true,
  },
  userSubscription: {
    id: "sub-1",
    userID: "user-1",
    orgID: null,
    teamID: null,
    customerId: "cus-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "FREE",
    hasPaymentMethod: false,
    isInTrial: false,
    rechargeRateSeconds: 0,
  },
  teamSubscriptions: [],
  payAsYouGoUsage: { allowPayAsYouGo: false },
};

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
  /** Mutable: the /api/v3/user identity-validation outcome. */
  validationResponse: () => Response;
  readonly tokenPolls: string[];
}

function installLinkFetch(): { script: LinkFetchScript; restore: () => void } {
  const script: LinkFetchScript = {
    tokenResponse: () => json({ error: "authorization_pending" }, 428),
    validationResponse: () => new Response(null, { status: 401 }),
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
      if (url === VALIDATION_URL) {
        return Promise.resolve(script.validationResponse());
      }
      // Anything else (refresh, sessions) answering 401 keeps stray calls
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

  /** Pauses the credential save at the durable-store boundary. */
  function pauseStoreSignIn(realStore: ITokenStore): {
    saveEnteredPromise: Promise<void>;
    releaseSave: () => void;
  } {
    let releaseSave: () => void = () => undefined;
    let saveEntered: () => void = () => undefined;
    const saveEnteredPromise = new Promise<void>((resolve) => {
      saveEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const originalSignIn = realStore.signIn.bind(realStore);
    Object.defineProperty(realStore, "signIn", {
      configurable: true,
      value: async (
        tokens: { readonly token: string; readonly refreshToken: string },
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        saveEntered();
        await gate;
        return originalSignIn(tokens, identity);
      },
    });
    return { saveEnteredPromise, releaseSave };
  }

  it("a supersession landing MID-SAVE undoes the durable credential write", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      // Reach the paused save: claim, one poll (authorized), validation.
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      // B starts (superseding A mid-save) and immediately fails to launch.
      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      // A's paused write now lands — and must be undone, not persisted.
      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("failed");
      const stored: StoredCredentials | null = await realStore.get();
      expect(stored).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("a FAILED undo is surfaced, and recovery completes it before adopting — the zombie never returns", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    // The undo's atomic conditional delete faults — the stale pair stays
    // durable. That must fire the shared store-fault seam AND fence the
    // recovery loop: until the delete lands, nothing durable may be adopted.
    let deleteIfTokenBroken = true;
    const realDeleteIfToken = realStore.deleteIfToken.bind(realStore);
    Object.defineProperty(realStore, "deleteIfToken", {
      configurable: true,
      value: (expectedToken: string): Promise<"deleted" | "kept"> =>
        deleteIfTokenBroken
          ? Promise.reject(new Error("EIO: credentials file unwritable"))
          : realDeleteIfToken(expectedToken),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("failed");
      // Observable: the store-unavailable projection is the surfaced error,
      // and the stale pair is indeed still durable.
      expect(service.getLastError()).toBe(AUTH_ERROR_STORE_UNAVAILABLE);
      expect((await realStore.get())?.token).toBe("attempt-a-token");

      // Recovery ticks while the conditional delete still fails: the stale
      // token WOULD validate (the /user stub says 200), but the pending-undo
      // fence must keep the loop from adopting it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");

      // The store heals. Recovery completes the pending conditional delete
      // FIRST, then finds no stored session — the zombie never signs back in.
      deleteIfTokenBroken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await realStore.get()).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("a watcher self-write echo cannot re-adopt the stale pair while its undo is pending", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    let deleteIfTokenBroken = true;
    const realDeleteIfToken = realStore.deleteIfToken.bind(realStore);
    Object.defineProperty(realStore, "deleteIfToken", {
      configurable: true,
      value: (expectedToken: string): Promise<"deleted" | "kept"> =>
        deleteIfTokenBroken
          ? Promise.reject(new Error("EIO: credentials file unwritable"))
          : realDeleteIfToken(expectedToken),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      // STARTED service: the credentials-store change subscription is live,
      // so the superseded save's own durable write fires the reconcile path
      // — the adoption route the recovery-only fence used to miss.
      await service.start();
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("failed");
      // The write's change notification has fired and the reconcile has had
      // every chance to run — with the undo still failing, it must adopt
      // NOTHING, even though the stale token would validate (stubbed 200).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");
      expect((await realStore.get())?.token).toBe("attempt-a-token");

      // The store heals: the pending delete completes first, so neither the
      // reconcile nor the recovery loop ever signs the zombie back in.
      deleteIfTokenBroken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await realStore.get()).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
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
