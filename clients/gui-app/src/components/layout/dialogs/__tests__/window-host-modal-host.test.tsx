import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const hostStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly bootstrapMarkers: ReadonlyArray<{
          readonly timestamp: string;
          readonly phase: string;
          readonly fields: Readonly<Partial<Record<string, string>>>;
        }>;
        readonly bootstrapLogPath: string;
        readonly bootstrapLogTail: string;
      }
    | undefined,
}));

vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => hostStatus,
}));

/**
 * The host controller's mutation lane, which is where ALL provisioning
 * narration comes from - never this renderer's own mutation observer.
 */
const controllerStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly mutation: {
          readonly kind: string;
          readonly progress: null;
          readonly startedAt: string;
        } | null;
      }
    | undefined,
}));

vi.mock("@/hooks/runner/use-runner-host-controller-status-query", () => ({
  useRunnerHostControllerStatusQuery: () => controllerStatus,
}));

// Pinned so the version-skew DIRECTION under test is a property of the
// fixture, not of whatever version this build happens to carry.
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => "1.5.0",
  getClientAppVersionLabel: () => "1.5.0",
}));

const LOCAL_HOST_ID = "local-host";
const REMOTE_HOST_ID = "remote-host";

function lease(overrides: Partial<HostLeaseSnapshot>): HostLeaseSnapshot {
  return {
    hostId: LOCAL_HOST_ID,
    status: "connecting",
    dead: null,
    ...overrides,
  } as HostLeaseSnapshot;
}

function deadLease(
  hostId: string,
  dead: HostLeaseSnapshot["dead"],
): HostLeaseSnapshot {
  return { hostId, status: "dead", dead } as HostLeaseSnapshot;
}

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
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
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function controllerFor(
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => ({ kind: "ready" }),
    defaultHostPresentation: presentation,
  };
}

function applySnapshot(overrides: Partial<SelectionKernelSnapshot>): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
    selectionRevision: 1,
    ...overrides,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

function renderHost(
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(presentation)}
        >
          <WindowHostModalHost bypassed={bypassed} />
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

const BOOTSTRAP_MARKERS = {
  bootstrapMarkers: [
    {
      timestamp: "t0",
      phase: "starting",
      fields: { shell: "/bin/zsh", args: "-i -l -c traycer" },
    },
    { timestamp: "t1", phase: "crashed", fields: { code: "1" } },
  ],
  bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
  bootstrapLogTail: "",
};

beforeEach(() => {
  hostStatus.data = undefined;
  controllerStatus.data = undefined;
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("<WindowHostModalHost />", () => {
  it("∅ + all leases dead(offline) + local lifecycle: modal visible with cause no-usable-host, local bootstrap body, bootstrap log path and attempt summary", async () => {
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-cause"),
    ).toBe("no-usable-host");
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
  });

  it("a REMOTE-only fleet: no local bootstrap body, no bootstrap log path", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
  });

  it("cold-start cause: modal visible, no attempt summary (nothing failed yet)", async () => {
    // The markers MUST be available for this assertion to mean anything. The
    // first version of this test left the status query empty, so the summary
    // was absent because there was nothing to summarise - it passed with the
    // cause guard deleted, and a kill probe is what caught it. Supplying
    // markers makes the guard the only reason the summary stays away.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
      },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-cause"),
    ).toBe("cold-start");
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
  });

  it("bypassed: true renders nothing at all", () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      true,
    );

    expect(screen.queryByTestId("window-host-modal")).toBeNull();
  });

  it("a plan-restricted fleet: no retry button", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: null,
      leases: [
        deadLease("host-a", { reason: "plan-restricted" }),
        deadLease("host-b", { reason: "plan-restricted" }),
      ],
    });

    renderHost(EMPTY_PRESENTATION, false);

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("plan-restricted");
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
  });

  it("closes by re-derivation: a later snapshot naming a ready effective host makes the modal disappear with no user interaction", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      preferredHostId: LOCAL_HOST_ID,
      leases: [lease({ hostId: LOCAL_HOST_ID, status: "ready", dead: null })],
      selectionRevision: 2,
    });

    await waitFor(() => {
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
    });
  });

  it("stays gone after the host has served once, even when its lease goes back to connecting", async () => {
    // THE SERVED LATCH's own job, which the recovery test above cannot reach:
    // there, a ready lease keeps the modal away whether or not the latch
    // exists. Only a host that served and then stopped being ready
    // distinguishes them - and re-opening a window-wide modal there would be
    // the layered narration this epic deletes, because a host that goes quiet
    // after the app is working is the TILE's story, not the window's.
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
    });
    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
    );
    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "ready", dead: null })],
      selectionRevision: 2,
    });
    await waitFor(() => {
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
      selectionRevision: 3,
    });
    await waitFor(() => {
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
    });

    // ...but ∅ still re-opens it. The latch silences the cold-start arm, not
    // the no-usable-host arm; conflating the two would strand a window whose
    // fleet died after it had been working.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      selectionRevision: 4,
    });
    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
  });

  it("narrates a NON-ensure mutation lane: the modal reads the lane's own kind", async () => {
    // Actor- AND kind-agnostic. Filtering the lane to `ensure` is the shape the
    // legacy install card used, and it is why a restart or an update running
    // under a window that nothing can serve rendered a silent card.
    controllerStatus.data = {
      mutation: { kind: "respawn", progress: null, startedAt: "2026-01-01T00:00:00.000Z" },
    };
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost({ ...EMPTY_PRESENTATION, targetKind: "remote" }, false);

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal-progress").textContent,
    ).toContain("Restarting Traycer Host…");
  });

  it("update-host: offers Update host when the HOST is the outdated leg", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-behind",
            hostVersion: "1.0.0",
            minSupportedVersion: "1.5.0",
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(screen.getByTestId("window-host-modal-update-host")).toBeTruthy();
  });

  it("update-host: WITHHOLDS Update host when THIS APP is the outdated leg", async () => {
    // Updating the host cannot fix an outdated client, so offering it is an
    // action that could only fail. Same fleet, same variant, opposite skew -
    // the host version is now AHEAD of this app's pinned 1.5.0.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-ahead",
            hostVersion: "2.0.0",
            minSupportedVersion: "2.0.0",
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
  });
});
