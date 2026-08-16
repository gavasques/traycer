import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  HostClient,
  type HostQueryInvalidationOptions,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

/**
 * THE P4.2 HANDOFF INSTRUMENT (redesign P4.1).
 *
 * P4.2 deletes `HostClient.bind()` and the active slot. The only thing that
 * currently tells a React consumer pinned by host id to look again when its
 * row lands is that slot's change event, so the deletion is safe only if a
 * replacement signal already carries it. This file is where that claim is
 * measured rather than asserted.
 *
 * The two cases are deliberately the SAME scenario under the two wirings:
 *
 *  - `slot event only` reproduces the PRE-P4.1 world. No registry source is
 *    installed, so the registry arm in `useReactiveHostReadiness` is inert by
 *    construction (nothing ever calls `reconcileAllRows`), and the landed row
 *    can only reach the consumer through `bind()`.
 *  - `registry signal only` is the POST-P4.1 world, and it never calls
 *    `bind()` at all - the row lands, the directory emits, and the consumer
 *    has to re-read off the registry alone.
 *
 * Neutering `bind()`'s two `emitChange` calls (probe K15) must therefore fail
 * the first case and leave the second passing. A run where BOTH still pass
 * means the first case stopped depending on the slot event and has quietly
 * become vacuous; a run where BOTH fail means the registry arm is not wired.
 * Read the two together - either one alone proves nothing.
 */

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

/** The host whose row has not arrived yet - a machine still booting. */
const LATE_HOST_ID = "late-host";
const LATE_HOST: HostDirectoryEntry = {
  hostId: LATE_HOST_ID,
  label: "Late Host",
  kind: "remote",
  websocketUrl: "wss://late.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

class NoopInvalidator implements IHostQueryInvalidator {
  invalidateHostScope(
    _hostId: string | null,
    _options: HostQueryInvalidationOptions,
  ): void {
    // Cache behavior is not what these cases are about.
  }
}

/** The narrowest directory that can gain a row and say so. */
class LateArrivingDirectory {
  entries: HostDirectoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  findById(hostId: string): HostDirectoryEntry | null {
    const found = this.entries.find((entry) => entry.hostId === hostId);
    // A FRESH object per read, like production: the local row is rebuilt per
    // snapshot and crosses the IPC bridge as a new object. A registry that
    // compared by reference would report a change on every emit and this
    // suite would pass for the wrong reason.
    return found === undefined ? null : { ...found };
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The host finishes booting and its row lands in the directory. */
  publishLateHost(): void {
    this.entries = [LATE_HOST];
    this.emit();
  }

  /**
   * A directory emit that changes NOTHING about any row - the benign churn
   * production produces constantly (a respawn-in-place whose only delta is a
   * pid the entry does not carry).
   */
  emitUnchanged(): void {
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function buildPinnedRequester(directory: LateArrivingDirectory): {
  readonly client: HostClient<typeof registry>;
  readonly pinned: HostClient<typeof registry>;
} {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  provider.setSignedIn({
    user: createAuthenticatedUserFixture(undefined),
    bearerToken: "bearer-1",
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  const client = new HostClient<typeof registry>({
    registry,
    messenger: new MockHostMessenger<typeof registry>({
      registry,
      handlers: { "host.ping": () => ({ pong: true }) },
      requestId: () => "req-1",
    }),
    invalidator: new NoopInvalidator(),
    findHostById: (hostId) => directory.findById(hostId),
  });
  client.setRequestContext(provider.current());
  // What a window pointed at a host that has not resolved yet holds: the id
  // is named, the row is not there, so the requester answers `null` exactly
  // as an unbound client always did.
  return { client, pinned: client.createRequesterForHostId(LATE_HOST_ID) };
}

describe("the registry's row-changed signal (P4.2 handoff)", () => {
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
  });

  it("reaches the consumer through the SLOT EVENT when no registry source is installed (the pre-P4.1 world)", () => {
    const directory = new LateArrivingDirectory();
    const { client, pinned } = buildPinnedRequester(directory);

    const { result } = renderHook(() => useReactiveHostReadiness(pinned));
    expect(result.current.hostId).toBeNull();
    expect(result.current.isReady).toBe(false);

    // The row lands. With no registry source installed, the directory emit
    // reaches nobody - `bind()` is the only notifier left.
    act(() => {
      directory.publishLateHost();
    });
    expect(result.current.hostId).toBeNull();

    act(() => {
      client.bind(LATE_HOST);
    });
    expect(result.current.hostId).toBe(LATE_HOST_ID);
    expect(result.current.isReady).toBe(true);
  });

  it("reaches the consumer through the REGISTRY with bind() never called (the post-P4.1 world)", () => {
    const directory = new LateArrivingDirectory();
    const { pinned } = buildPinnedRequester(directory);
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    });

    const { result } = renderHook(() => useReactiveHostReadiness(pinned));
    expect(result.current.hostId).toBeNull();
    expect(result.current.isReady).toBe(false);

    act(() => {
      directory.publishLateHost();
    });

    // No `bind()` anywhere in this case. This is the assertion P4.2 is
    // allowed to delete the slot on.
    expect(result.current.hostId).toBe(LATE_HOST_ID);
    expect(result.current.isReady).toBe(true);
  });

  it("renders nothing on a directory emit that moved no row this consumer can see", () => {
    const directory = new LateArrivingDirectory();
    directory.entries = [LATE_HOST];
    const { pinned } = buildPinnedRequester(directory);
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    });

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useReactiveHostReadiness(pinned);
    });
    expect(result.current.hostId).toBe(LATE_HOST_ID);
    const rendersAfterMount = renders;

    // The coarse arm deliberately WAKES on every source emit (a consumer that
    // cannot name its host must be woken by rows it has never seen). What
    // stops that from churning the tree is the value-compared snapshot, and
    // this is where that is pinned: `findById` hands back a fresh object
    // every read, so a reference-compared snapshot would re-render here.
    act(() => {
      directory.emitUnchanged();
    });
    expect(renders).toBe(rendersAfterMount);
  });
});
