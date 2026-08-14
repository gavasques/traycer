import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { HostStatusStrip } from "@/components/layout/host-status-strip";
import { deriveHostStatusStripState } from "@/components/layout/host-status-strip-state";
import {
  hostStatusProbeQueryKey,
  HostCompatibilityContext,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import type { HostSessionConnectivity } from "@/lib/host/session-connectivity";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const SETTLED_TRANSPORT_FAILURE = new HostTransportFailureError({
  code: "RPC_ERROR",
  message: "still dialing",
  requestId: "req-1",
  method: "host.status",
  fatalDetails: null,
});

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
}));

const connectivityRef = vi.hoisted(
  (): { connectivity: HostSessionConnectivity; wake: Mock } => ({
    connectivity: "unknown",
    wake: vi.fn(),
  }),
);

// Keeps the real module - including `isAnnouncedInterruption`, which the
// strip also imports from here - and overrides only the two hooks. Hand
// rolling a stub predicate would let a test agree with itself while
// disagreeing with the production mapping from connectivity to "announced".
vi.mock("@/lib/host/session-connectivity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/host/session-connectivity")>(
    "@/lib/host/session-connectivity",
  )),
  useHostSessionConnectivity: () => connectivityRef.connectivity,
  useHostSessionWake: () => connectivityRef.wake,
}));

const BASE_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  directoryRefreshing: false,
  openHostPicker: () => undefined,
  openSettings: () => undefined,
  anyHostDialable: false,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
  };
}

function renderStrip(args: {
  readonly compatibility: HostCompatibility | null;
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): void {
  bindingRef.value =
    args.hostClient === null ? null : { hostClient: args.hostClient };
  render(
    <QueryClientProvider client={buildQueryClient()}>
      <HostCompatibilityContext.Provider value={args.compatibility}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(args.readiness, args.presentation)}
        >
          <HostStatusStrip />
        </HostReadinessControllerContext.Provider>
      </HostCompatibilityContext.Provider>
    </QueryClientProvider>,
  );
}

function queryStrip(): HTMLElement | null {
  return screen.queryByTestId("host-status-strip");
}

afterEach(() => {
  cleanup();
  bindingRef.value = null;
  connectivityRef.connectivity = "unknown";
  connectivityRef.wake = vi.fn();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

describe("deriveHostStatusStripState", () => {
  // Pure unit table for the full D3 precedence: directory > switching >
  // sessionInterrupted (disconnected) > checking (as switching) > error >
  // degraded > hidden. sessionInterrupted is the SESSION plane; every arm
  // below it is fed by the DIRECTORY plane's own read of the last compat
  // probe, which a dropped session is what produces in the first place -
  // so sessionInterrupted outranks all of them.
  const compatibleLive = {
    status: "compatible" as const,
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  };
  const compatibleDegraded = { ...compatibleLive, degraded: true };
  const failed = {
    ...compatibleLive,
    status: "failed" as const,
    unreachable: true,
    errorMessage: "dial failed",
  };
  const incompatible = {
    ...compatibleLive,
    status: "incompatible" as const,
    errorMessage: "version mismatch",
  };
  const checking = {
    ...compatibleLive,
    status: "checking" as const,
  };

  it("orders switching over error and degraded, and treats checking as switching", () => {
    expect(
      deriveHostStatusStripState({
        switching: true,
        sessionInterrupted: false,
        readinessKind: "ready",
        compatibility: failed,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: true,
        sessionInterrupted: false,
        readinessKind: "incompatible-host",
        compatibility: incompatible,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "ready",
        compatibility: checking,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "loading-host",
        compatibility: compatibleLive,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "compatibility-error",
        compatibility: failed,
      }),
    ).toBe("error");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "ready",
        compatibility: incompatible,
      }),
    ).toBe("error");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "ready",
        compatibility: compatibleDegraded,
      }),
    ).toBe("degraded");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "ready",
        compatibility: compatibleLive,
      }),
    ).toBe("hidden");
  });

  it("puts directory ahead of every other precedence, including a live switch", () => {
    // `directory` is the one state where the app is pointed at NOTHING - no
    // selection, and no row to select. The arms it outranks all describe the
    // host the app WAS pointed at, and that host may no longer exist by the
    // time a directory kind is live - so none of them may win here.
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "searching-hosts",
        compatibility: failed,
      }),
    ).toBe("directory");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "choose-host",
        compatibility: incompatible,
      }),
    ).toBe("directory");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: false,
        readinessKind: "mobile-no-host",
        compatibility: checking,
      }),
    ).toBe("directory");
    expect(
      deriveHostStatusStripState({
        switching: true,
        sessionInterrupted: false,
        readinessKind: "searching-hosts",
        compatibility: compatibleLive,
      }),
    ).toBe("directory");
  });

  it("ranks sessionInterrupted below directory and a live switch, but above every checking/error/degraded arm underneath", () => {
    // Every case above passes `sessionInterrupted: false`; these pass `true`
    // to prove the SESSION plane sits exactly where the arm order says:
    // below the two arms that describe what the app is POINTED AT (directory,
    // switching), above everything that describes what the last compat probe
    // ANSWERED (checking, error, degraded, or even a healthy compatible
    // verdict) - a dropped session is what produces those answers in the
    // first place, so none of them may explain the row instead.
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "searching-hosts",
        compatibility: compatibleLive,
      }),
    ).toBe("directory");
    expect(
      deriveHostStatusStripState({
        switching: true,
        sessionInterrupted: true,
        readinessKind: "ready",
        compatibility: compatibleLive,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "loading-host",
        compatibility: compatibleLive,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "ready",
        compatibility: checking,
      }),
    ).toBe("disconnected");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "compatibility-error",
        compatibility: failed,
      }),
    ).toBe("disconnected");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "ready",
        compatibility: incompatible,
      }),
    ).toBe("disconnected");
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "ready",
        compatibility: compatibleDegraded,
      }),
    ).toBe("disconnected");
    // The whole point: a healthy directory plane (compatible, ready) plus a
    // dropped session still has to say something, and it must be
    // `disconnected` rather than `hidden`.
    expect(
      deriveHostStatusStripState({
        switching: false,
        sessionInterrupted: true,
        readinessKind: "ready",
        compatibility: compatibleLive,
      }),
    ).toBe("disconnected");
  });
});

describe("<HostStatusStrip />", () => {
  it("says the connection is degraded while a compatible verdict is held", () => {
    // Absorbs HostConnectionDegradedBanner: same amber strip + working Retry.
    const retry = vi.fn();
    renderStrip({
      compatibility: {
        status: "compatible",
        degraded: true,
        retry,
        hostStatus: {
          busy: false,
          busySessionCount: 0,
          hostVersion: "1.0.0",
        },
      },
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "compatible",
          degraded: true,
          retry,
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("degraded");
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way on a live connection", () => {
    renderStrip({
      compatibility: {
        status: "compatible",
        degraded: false,
        retry: () => undefined,
        hostStatus: {
          busy: false,
          busySessionCount: 0,
          hostVersion: "1.0.0",
        },
      },
      readiness: { kind: "ready" },
      presentation: BASE_PRESENTATION,
      hostClient: null,
    });

    expect(queryStrip()).toBeNull();
  });

  it("renders nothing outside the compatibility provider", () => {
    // The context decides whether the strip exists at all - null is how
    // test harnesses and the gui-app dev preview mount surfaces without one.
    renderStrip({
      compatibility: null,
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "compatible",
          degraded: true,
        },
      },
      hostClient: null,
    });
    expect(queryStrip()).toBeNull();
  });

  /**
   * Mounts the strip under a live client + query client so the composite
   * switch signal can be driven end to end: bind, then settle (or unbind)
   * the new host's probe slot the way the real probe would.
   */
  function mountSwitchSurface(args: {
    readonly compatibility: HostCompatibility;
    readonly presentation: DefaultHostReadinessPresentation;
  }): {
    readonly hostClient: HostClient<HostRpcRegistry>;
    readonly queryClient: QueryClient;
  } {
    const hostClient = buildHostClient();
    hostClient.bind(mockLocalHostEntry);
    bindingRef.value = { hostClient };
    const queryClient = buildQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <HostCompatibilityContext.Provider value={args.compatibility}>
          <HostReadinessControllerContext.Provider
            value={controllerFor({ kind: "ready" }, args.presentation)}
          >
            <HostStatusStrip />
          </HostReadinessControllerContext.Provider>
        </HostCompatibilityContext.Provider>
      </QueryClientProvider>,
    );
    return { hostClient, queryClient };
  }

  it("clears switching once the new host's probe settles with data", () => {
    // The switch is held until the host we moved TO has answered - and then
    // it must actually let go. A latch that never clears would leave the app
    // saying "Switching to…" for the rest of the session.
    const live: HostCompatibility = {
      status: "compatible",
      degraded: false,
      retry: () => undefined,
      hostStatus: { busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
    };
    const { hostClient, queryClient } = mountSwitchSurface({
      compatibility: live,
      presentation: BASE_PRESENTATION,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    act(() => {
      queryClient.setQueryData(
        hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
        { ready: true, busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
      );
    });
    expect(queryStrip()).toBeNull();
  });

  it("lets a settled failure paint red once the switch has cleared", () => {
    // The other half of the anti-flash rule. Suppressing the red variant
    // during a switch is only safe if it is NOT suppressed afterwards -
    // otherwise a host that genuinely failed to answer would go unreported.
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };
    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "host did not answer",
      },
    };
    const { hostClient, queryClient } = mountSwitchSurface({
      compatibility: failedCompat,
      presentation,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    // A settled failure for the NEW host: no data, error state, and the error
    // is not pending-class - exactly what `hasSettledHostStatusProbe` treats
    // as an answer.
    act(() => {
      queryClient.setQueryData(
        hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
        () => undefined,
      );
      const cache = queryClient.getQueryCache();
      const query = cache.build(queryClient, {
        queryKey: hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
      });
      query.setState({
        status: "error",
        error: SETTLED_TRANSPORT_FAILURE,
        fetchStatus: "idle",
      });
    });
    expect(queryStrip()?.dataset.state).toBe("error");
  });

  it("drops the switch when the host it was switching to is unbound", () => {
    // A host removed mid-switch (its directory row disappears, or the user
    // clears the selection) used to leave "Switching to B…" latched forever,
    // and `switching` precedence then suppressed every settled error behind
    // it. Unbinding ENDS the switch.
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };
    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "host did not answer",
      },
    };
    const { hostClient } = mountSwitchSurface({
      compatibility: failedCompat,
      presentation,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    act(() => {
      hostClient.bind(null);
    });
    // The suppressed error is now visible instead of a permanent amber lie.
    expect(queryStrip()?.dataset.state).toBe("error");
  });

  it("does not paint the red error variant while a host switch is in flight", () => {
    // Anti-flash rule: switching > error. A still-settling probe (or a
    // readiness kind that maps to error) must not blink red under an active
    // host-bound switch - that amber → red → hidden blink is what every
    // remote switch used to show.
    const hostClient = buildHostClient();
    hostClient.bind(mockLocalHostEntry);
    bindingRef.value = { hostClient };

    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "still dialing",
      },
    };
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };

    const queryClient = buildQueryClient();
    // Mount first so useHostSwitchTarget's onChange subscription is armed,
    // then bind the remote host - the composite switch signal is the only
    // thing that can fire switching for a remote target (readiness stays
    // ready).
    render(
      <QueryClientProvider client={queryClient}>
        <HostCompatibilityContext.Provider value={failedCompat}>
          <HostReadinessControllerContext.Provider
            value={controllerFor({ kind: "ready" }, presentation)}
          >
            <HostStatusStrip />
          </HostReadinessControllerContext.Provider>
        </HostCompatibilityContext.Provider>
      </QueryClientProvider>,
    );

    // Without a live switch the strip is already red (failed compat, ready
    // readiness). After host-bound it must go amber.
    expect(queryStrip()?.dataset.state).toBe("error");

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("switching");
  });

  // The amber strip covers two unrelated situations, and Retry has to mean the
  // right one in each. A stalled/dead LOCAL host needs its process back; the
  // full-screen cards this strip replaced put `requestRespawn` behind Retry for
  // exactly these three readiness kinds. Re-running the compat probe against a
  // process that is not there answers the same nothing every click.
  for (const kind of [
    "loading-host",
    "provisioning-host",
    "unavailable-host",
  ] as const) {
    it(`respawns the local host instead of re-probing on '${kind}'`, () => {
      const retry = vi.fn();
      const requestRespawn = vi.fn();
      renderStrip({
        compatibility: {
          status: "checking",
          retry,
        },
        readiness: { kind },
        presentation: {
          ...BASE_PRESENTATION,
          targetKind: "local",
          requestRespawn,
          compatibility: {
            ...BASE_PRESENTATION.compatibility,
            status: "checking",
            retry,
          },
        },
        hostClient: null,
      });

      expect(queryStrip()?.dataset.state).toBe("switching");
      fireEvent.click(screen.getByTestId("host-status-strip-retry"));
      expect(requestRespawn).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });
  }

  it("disables Retry while a respawn it issued is still pending", () => {
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry: () => undefined },
      readiness: { kind: "unavailable-host" },
      presentation: {
        ...BASE_PRESENTATION,
        targetKind: "local",
        requestRespawn,
        respawnPending: true,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
        },
      },
      hostClient: null,
    });

    const button = screen.getByTestId("host-status-strip-retry");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(requestRespawn).not.toHaveBeenCalled();
  });

  // The counter-pin: a CONNECTION wait must keep the probe retry. For a remote
  // target readiness is already `ready`, so respawning the local host would be
  // both useless and wrong.
  it("keeps the compatibility retry while the probe is still dialing", () => {
    const retry = vi.fn();
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry },
      readiness: { kind: "compatibility-checking" },
      presentation: {
        ...BASE_PRESENTATION,
        requestRespawn,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
          retry,
        },
      },
      hostClient: null,
    });

    expect(queryStrip()?.dataset.state).toBe("switching");
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(requestRespawn).not.toHaveBeenCalled();
  });

  // The counter-pin the local fix needed: `unavailable-host` is ALSO what a
  // selected REMOTE host reports once it loses its dialable endpoint. Respawning
  // then restarts the host on THIS computer and leaves the host the user is
  // actually pointed at untouched.
  it("does not respawn the local host when the unavailable target is remote", () => {
    const retry = vi.fn();
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry },
      readiness: { kind: "unavailable-host" },
      presentation: {
        ...BASE_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        requestRespawn,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
          retry,
        },
      },
      hostClient: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(requestRespawn).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("files the same report-issue context as the full-screen card on the error variant", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const retry = vi.fn();
    renderStrip({
      compatibility: {
        status: "failed",
        retry,
        retrying: false,
        error: SETTLED_TRANSPORT_FAILURE,
        unreachable: true,
      },
      readiness: { kind: "compatibility-error" },
      presentation: {
        ...BASE_PRESENTATION,
        localHostState: "ready",
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "failed",
          errorMessage: "fetch failed",
          unreachable: true,
          retry,
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("error");
    expect(screen.getByTestId("host-status-strip-retry")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
    // Same title/code/source as the full-screen compatibility-error card
    // (host-readiness-controller.test.tsx unreachable-host report pin).
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Traycer Host is not responding",
      message:
        "The app could not reach Traycer Host. Host health: host ready, compat unreachable.",
      code: "HOST_UNREACHABLE",
      source: "Host connection",
    });
  });

  // The three relay-only no-selection states: reachable on a LIVE session
  // (a background registry read that answers `signed-out` clears the
  // directory and nulls the selection without a GUI sign-out), so their
  // recovery has to live in the strip rather than a full-screen block.
  it.each([
    {
      kind: "searching-hosts" as const,
      message: "Looking for your hosts…",
      actionLabel: "Refresh",
    },
    {
      kind: "mobile-no-host" as const,
      message:
        "No host connected. Connect a host from this device to continue.",
      actionLabel: "Refresh",
    },
    {
      kind: "choose-host" as const,
      message: "Choose a host to continue.",
      actionLabel: "Choose host",
    },
  ])(
    "renders the $kind directory arm with its message and wires its action",
    ({ kind, message, actionLabel }) => {
      const refreshDirectory = vi.fn();
      const openHostPicker = vi.fn();
      renderStrip({
        compatibility: {
          status: "compatible",
          degraded: false,
          retry: () => undefined,
          hostStatus: {
            busy: false,
            busySessionCount: 0,
            hostVersion: "1.0.0",
          },
        },
        readiness: { kind },
        presentation: {
          ...BASE_PRESENTATION,
          refreshDirectory,
          openHostPicker,
        },
        hostClient: null,
      });

      const strip = queryStrip();
      expect(strip).not.toBeNull();
      expect(strip?.dataset.state).toBe("directory");
      expect(screen.getByText(message)).toBeTruthy();
      const action = screen.getByTestId("host-status-strip-directory-action");
      expect(action.textContent).toContain(actionLabel);

      fireEvent.click(action);
      if (kind === "choose-host") {
        expect(openHostPicker).toHaveBeenCalledTimes(1);
        expect(refreshDirectory).not.toHaveBeenCalled();
      } else {
        expect(refreshDirectory).toHaveBeenCalledTimes(1);
        expect(openHostPicker).not.toHaveBeenCalled();
      }
    },
  );

  it("disables the directory Refresh action and spins it while a fetch is in flight", () => {
    renderStrip({
      compatibility: {
        status: "compatible",
        degraded: false,
        retry: () => undefined,
        hostStatus: { busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
      },
      readiness: { kind: "searching-hosts" },
      presentation: {
        ...BASE_PRESENTATION,
        directoryRefreshing: true,
      },
      hostClient: null,
    });

    const action = screen.getByTestId("host-status-strip-directory-action");
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("host-status-strip-directory-spinner"),
    ).toBeTruthy();
  });

  it("never resurrects a settled compat failure as the red strip once directory is live", () => {
    // The compat facts here still hold the LAST host's answer. A deregistered
    // selection reaching `searching-hosts` must not paint "Traycer Host is
    // not responding" plus a probe Retry for a host that no longer exists.
    renderStrip({
      compatibility: {
        status: "failed",
        retry: vi.fn(),
        retrying: false,
        error: SETTLED_TRANSPORT_FAILURE,
        unreachable: true,
      },
      readiness: { kind: "searching-hosts" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "failed",
          unreachable: true,
          errorMessage: "host did not answer",
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("directory");
    expect(screen.queryByText("Traycer Host is not responding.")).toBeNull();
    expect(screen.queryByTestId("host-status-strip-retry")).toBeNull();
  });

  /**
   * The healthy directory-plane fixture the `disconnected` cases below share:
   * a compatible, non-degraded verdict under `readiness.kind: "ready"`. The
   * host is up and heartbeating Online in the directory - the fault, if any,
   * is this device's own session.
   */
  const HEALTHY_COMPATIBILITY: HostCompatibility = {
    status: "compatible",
    degraded: false,
    retry: () => undefined,
    hostStatus: { busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
  };

  it("shows the connection-interrupted strip without blaming the host when the session drops under a healthy directory plane", () => {
    connectivityRef.connectivity = "interrupted";
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "ready" },
      presentation: BASE_PRESENTATION,
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("disconnected");
    expect(strip?.textContent).toContain("Connection interrupted");
    // This state is reached with the host itself fine - the fault is the
    // device's own socket - so the copy must never read as the host being
    // down, and must never name the host either.
    expect(screen.queryByText(/Traycer Host is not responding/)).toBeNull();
    expect(strip?.textContent).not.toContain("Traycer Host");
    // The two rungs must not collapse into one: this is the FIRST rung, so
    // the stronger "still can't connect" wording must not also be present.
    expect(strip?.textContent).not.toContain("Still can't connect");
  });

  it("escalates the disconnected strip to its second rung once the outage has run long, without ever blaming the host", () => {
    connectivityRef.connectivity = "interrupted-prolonged";
    const retry = vi.fn();
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          retry,
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("disconnected");
    expect(strip?.textContent).toContain("Still can't connect");
    // The first rung's reassuring wording must not survive the escalation -
    // a message that never changes is what the second rung exists to avoid.
    expect(strip?.textContent).not.toContain("Connection interrupted");

    expect(connectivityRef.wake).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(connectivityRef.wake).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("names the interrupted strip as a connection problem, not a host problem, in its accessible name", () => {
    connectivityRef.connectivity = "interrupted";
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "ready" },
      presentation: BASE_PRESENTATION,
      hostClient: null,
    });

    expect(
      screen.getByRole("status", {
        name: "Connection to Traycer Host interrupted",
      }),
    ).toBeTruthy();
  });

  it("wakes the session and retries compatibility together when Retry is clicked, and not before", () => {
    connectivityRef.connectivity = "interrupted";
    const retry = vi.fn();
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          retry,
        },
      },
      hostClient: null,
    });

    expect(connectivityRef.wake).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(connectivityRef.wake).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("disables Retry on the disconnected strip while the compatibility retry it issued is still pending", () => {
    connectivityRef.connectivity = "interrupted";
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          retrying: true,
        },
      },
      hostClient: null,
    });

    expect(
      screen.getByTestId("host-status-strip-retry").hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each(["dialing", "settling", "ready", "unknown"] as const)(
    "stays hidden under a healthy directory plane while connectivity is '%s'",
    (connectivity) => {
      connectivityRef.connectivity = connectivity;
      renderStrip({
        compatibility: HEALTHY_COMPATIBILITY,
        readiness: { kind: "ready" },
        presentation: BASE_PRESENTATION,
        hostClient: null,
      });

      expect(queryStrip()).toBeNull();
    },
  );

  it("shows the directory arm, not disconnected, when the session is interrupted but no host is bound", () => {
    connectivityRef.connectivity = "interrupted";
    renderStrip({
      compatibility: HEALTHY_COMPATIBILITY,
      readiness: { kind: "mobile-no-host" },
      presentation: BASE_PRESENTATION,
      hostClient: null,
    });

    expect(queryStrip()?.dataset.state).toBe("directory");
  });
});
