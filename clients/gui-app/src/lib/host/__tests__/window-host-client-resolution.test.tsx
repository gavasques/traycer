import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

/**
 * `useHostClient()` is the app-wide host client: the SELECTION LAYER's
 * `effectiveHostId` resolved through `createRequesterForHostId` (redesign
 * P2.1, then P4.2 deleted the runtime client's privileged active slot
 * entirely).
 *
 * The spine is substituted at the provider seam so these cases can drive
 * `effectiveHostId` directly against a real spine (real `findHostById`, real
 * `createRequesterForHostId`) without standing up the full selection
 * authority engine.
 */
const spineRef = vi.hoisted<{ value: HostClient<HostRpcRegistry> | null }>(
  () => ({ value: null }),
);

function getSpine(): HostClient<HostRpcRegistry> {
  if (spineRef.value === null) {
    throw new Error("test spine not configured");
  }
  return spineRef.value;
}

vi.mock("@/providers/host-runtime-provider", () => ({
  createHostRuntimeState: () => ({
    context: createContext(null),
    bindingSnapshot: { value: null },
  }),
  createHostRuntime: () => ({
    HostRuntimeProvider: () => null,
    HostRuntimeContext: createContext(null),
    useHostClient: getSpine,
    useHostDirectory: () => null,
    useAuthService: () => null,
    useHostBinding: () => null,
    getBindingSnapshot: () => null,
  }),
}));

import { useHostClient } from "@/lib/host/runtime";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const HOST_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

const directory: HostDirectoryEntry[] = [mockLocalHostEntry, HOST_B];

function applyEffectiveHostId(hostId: string | null): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

const messengerRef: { value: MockHostMessenger<HostRpcRegistry> | null } = {
  value: null,
};

beforeEach(() => {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: { "terminal.kill": () => ({ killed: true }) },
  });
  messengerRef.value = messenger;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (hostId) =>
      directory.find((entry) => entry.hostId === hostId) ?? null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  spineRef.value = spine;
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  spineRef.value = null;
  messengerRef.value = null;
});

describe("useHostClient", () => {
  it("addresses the effective host", () => {
    // This used to also assert a CONTROL: the runtime client's own active
    // slot stayed parked on the local host, so an implementation that read
    // the slot instead of the selection layer would have answered
    // `mock-local` here. Redesign P4.2 deleted the slot - `getActiveHostId()`
    // on an un-pinned client is now hardwired to `null` regardless of what
    // this hook does, so there is no second source left to distinguish from.
    // The surviving claim is that `useHostClient()` resolves the effective
    // host.
    applyEffectiveHostId(HOST_B.hostId);

    const { result } = renderHook(() => useHostClient());

    expect(result.current.getActiveHostId()).toBe(HOST_B.hostId);
    expect(result.current.getActiveHost()).toEqual(HOST_B);
  });

  it("re-points when the effective host moves, and hands back a stable client while it does not", () => {
    applyEffectiveHostId(mockLocalHostEntry.hostId);

    const { result, rerender } = renderHook(() => useHostClient());
    const first = result.current;
    rerender();
    // Stable across renders: consumers put this in effect/memo deps, and a
    // fresh identity per render would resubscribe every one of them.
    expect(result.current).toBe(first);

    applyEffectiveHostId(HOST_B.hostId);
    expect(result.current).not.toBe(first);
    expect(result.current.getActiveHostId()).toBe(HOST_B.hostId);
    // The client from the earlier paint keeps addressing the host it
    // resolved - it does not follow the app.
    expect(first.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
  });

  it("reports ∅ when no host is effective", () => {
    applyEffectiveHostId(null);

    const { result } = renderHook(() => useHostClient());

    expect(result.current.getActiveHostId()).toBe(null);
  });

  it("sends a request to the effective host", async () => {
    applyEffectiveHostId(HOST_B.hostId);

    const { result } = renderHook(() => useHostClient());
    await expect(
      result.current.request("terminal.kill", { sessionId: "session-a" }),
    ).resolves.toEqual({ killed: true });
    // Resolving is not enough: the mock answers for any host, so the ENDPOINT
    // is what says the call went to `host-b` rather than to the slot.
    expect(messengerRef.value?.calls).toHaveLength(1);
    expect(messengerRef.value?.calls[0]?.authority.endpoint.hostId).toBe(
      HOST_B.hostId,
    );
    expect(messengerRef.value?.calls[0]?.authority.endpoint.websocketUrl).toBe(
      HOST_B.websocketUrl,
    );
  });
});
