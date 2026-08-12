import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { RemoteHostFetchOutcome } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { HostReadinessControllerProvider } from "@/components/layout/host-readiness-controller";
// Route-facing gate name, not the inner component underneath it - the
// regression this file pins is in the wiring, and asserting on the inner
// component would leave that wiring unpinned.
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { HostStatusStrip } from "@/components/layout/host-status-strip";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The invariant this file pins end to end, through the REAL provider chain: a
 * relay-only shell (no local host) with one live tab open, whose directory
 * read comes back `signed-out`, keeps its app mounted.
 *
 * `signed-out` is what the remote fetcher returns for a bearer the registry
 * rejected - the fetch adapter deliberately does NOT turn that into a GUI
 * sign-out, because a background poll racing a token rotation is not
 * evidence the user's session ended (see `createRemoteHostFetcher`). But
 * `HostDirectoryService.performRefresh` treats it exactly like an
 * authoritative empty listing: it clears the remote entries, un-observes the
 * listing, and `reconcileSelection` then nulls the selection - and
 * `HostRuntime` unbinds the client on that null, synchronously, with no
 * sign-out in sight. So a LIVE session - editors, terminals, everything a user
 * had open - reaches one of the relay-only no-selection readiness kinds. Those
 * are `directory` states (`postLatchSurfaceFor`), reported by the strip inside
 * a mounted app; classifying any of them full-screen would unmount the whole
 * window to ask a question about host selection.
 *
 * Exercised through the same production chain `local-boot-intent.test.tsx`
 * uses rather than a stubbed controller, because the wiring between the
 * fetcher and the gate is the part that has to hold.
 */

const routerState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

// The real header mounts the tab strip, notifications and menus - none of
// which this file is about, and all of which need their own provider stack.
vi.mock("@/components/layout/header/app-header", () => ({
  AppHeader: (props: { readonly variant: string }) => (
    <header data-variant={props.variant} />
  ),
}));

function messengerFactory(): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {},
    });
}

/**
 * A fetcher whose answer can be flipped mid-test, the way a real bearer
 * rotation would: the same function object, a different outcome on the next
 * call. `HostDirectoryService` never re-reads it except through `refresh()`,
 * so flipping the mode alone changes nothing until a refresh actually runs.
 */
function controllableRemoteFetcher(): {
  readonly fetcher: () => Promise<RemoteHostFetchOutcome>;
  readonly setSignedOut: () => void;
} {
  let outcome: RemoteHostFetchOutcome = {
    kind: "hosts",
    entries: [mockRemoteHostEntry],
  };
  return {
    fetcher: () => Promise.resolve(outcome),
    setSignedOut: () => {
      outcome = { kind: "signed-out" };
    },
  };
}

/**
 * A signed-in, relay-only shell: no local host at all, so the default-host
 * surface takes the relay-only branch (`relayOnlyDirectoryReadiness`) rather
 * than falling back to a local bootstrap. The token store needs a real
 * session or every readiness answer collapses to
 * `restoring-request-context` and the scenario is never reached.
 */
function buildRunnerHost(): MockRunnerHost {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: false,
    traycerCli: undefined,
  });
  void runnerHost.tokenStore.signIn(
    { token: "test-token", refreshToken: "test-refresh-token" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  return runnerHost;
}

/**
 * The production chain (`traycer-app.tsx`), plus the route-facing gate and
 * strip: `RunnerHostProvider` -> `QueryClientProvider` -> `HostRuntimeProvider`
 * (with a controllable `remoteFetcher`) -> `HostCompatibilityProvider` ->
 * `HostReadinessControllerProvider` -> `HostReadyGate` + `HostStatusStrip`.
 * Nothing between the fetcher and the strip is stubbed - the defect lived in
 * that wiring.
 */
function mountRealChain(fetcher: () => Promise<RemoteHostFetchOutcome>): void {
  const runnerHost = buildRunnerHost();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={fetcher}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostCompatibilityProvider>
            <HostReadinessControllerProvider
              onConfigureShell={() => undefined}
              onOpenSettings={() => undefined}
            >
              <HostReadyGate>
                <main>app</main>
                <HostStatusStrip />
              </HostReadyGate>
            </HostReadinessControllerProvider>
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

/** The directory the runtime actually built - the live refresh authority. */
function activeDirectory(): HostDirectoryService {
  const directory = getHostBindingSnapshot()?.directory ?? null;
  if (directory === null) throw new Error("expected a started host runtime");
  return directory;
}

/**
 * The runtime hydrates the signed-in user before it publishes a binding; an
 * unanswered `/api/v3/user` leaves the whole chain on its loading fallback,
 * which would make every assertion below vacuous.
 */
function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "test-user",
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
                userID: "test-user",
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
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in relay-directory test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  routerState.pathname = "/";
  restoreFetch = installAuthFetch();
  window.localStorage.clear();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "test-user", userName: "Test User", email: "test@example.com" },
      { userId: "test-user", username: "Test User" },
      [],
    );
});

afterEach(() => {
  cleanup();
  restoreFetch();
  window.localStorage.clear();
  useAuthStore.getState().setSignedOut();
});

describe("a relay-directory clear keeps the app mounted", () => {
  it("swaps the gate for the directory strip on a rejected bearer, without unmounting the app", async () => {
    const { fetcher, setSignedOut } = controllableRemoteFetcher();
    mountRealChain(fetcher);

    // Settle on the one dialable remote host: the gate latches, and the app
    // is what's on screen - not the setup card.
    await waitFor(() => {
      expect(screen.getByRole("main")).toBeTruthy();
    });
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    const mainBefore = screen.getByRole("main");

    setSignedOut();
    await act(async () => {
      await activeDirectory().refresh();
    });

    // Same node - not a fresh one that merely looks the same. A remount here
    // is exactly what threw away editors, terminals and scroll position.
    expect(screen.getByRole("main")).toBe(mainBefore);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();

    const strip = await screen.findByTestId("host-status-strip");
    expect(strip.dataset.state).toBe("directory");
    expect(strip.textContent).toContain("Looking for your hosts…");
  });
});
