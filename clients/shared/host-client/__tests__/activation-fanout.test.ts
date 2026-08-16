import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { Disposable } from "../../platform/uri-callback";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  DefaultRequestContextProvider,
  type AuthEra,
} from "../../auth/request-context-provider";
import type {
  HostQueryInvalidationOptions,
  IHostQueryInvalidator,
} from "../host-client";
import type { HostDirectoryEntry } from "../host-directory";
import { HostRuntime, type IHostDirectoryService } from "../host-runtime";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "../mock/mock-host-directory";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import { MockRunnerHost } from "../mock/mock-runner-host";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";

/**
 * THE ACTIVATION FAN-OUT SEAM (redesign D17 / P2.1).
 *
 * Everything an activation touches meets here: the directory publishes a new
 * effective host, `HostRuntime` forwards it to `HostClient`, and the client
 * decides what that costs every OTHER consumer - the ones pinned to a
 * different host, and the ones already talking to the incoming one.
 *
 * The answer these cases pin is "nothing". A host becoming effective is a
 * statement about attention, not about lifecycle: no in-flight request is
 * aborted, no query scope is swept, and a host that stops being effective
 * keeps serving the surfaces pinned to it. The suites next door cover
 * `bind()` in isolation; this file is deliberately assembled out of the real
 * runtime, the real request coordinator and the real binding-authority
 * registry, because the abort that used to reach a pinned consumer travelled
 * through all three and was invisible to any one of them alone.
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

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: () => "latest",
  joinResponseTimeoutMs: () => null,
};

/** The host a surface stays PINNED to across the activation. */
const HOST_A = mockLocalHostEntry;
/** The host the user activates. */
const HOST_B = mockRemoteHostEntry;

interface Deferred {
  readonly promise: Promise<{ pong: true }>;
  settle(): void;
}

function createDeferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<{ pong: true }>((resolve) => {
    settle = () => {
      resolve({ pong: true });
    };
  });
  return { promise, settle };
}

class RecordingInvalidator implements IHostQueryInvalidator {
  readonly invalidateCalls: Array<{
    readonly hostId: string | null;
    readonly options: HostQueryInvalidationOptions;
  }> = [];
  readonly cancelCalls: Array<string | null> = [];

  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void {
    this.invalidateCalls.push({ hostId, options });
  }

  readonly cancelHostScope = (hostId: string | null): Promise<void> => {
    this.cancelCalls.push(hostId);
    return Promise.resolve();
  };
}

/**
 * The narrowest directory that can publish an effective host. `selectById` is
 * the pure setter production has since P1.2, so a test drives an activation
 * exactly the way the selection-authority bridge does.
 */
class FanOutDirectory implements IHostDirectoryService {
  entries: HostDirectoryEntry[] = [HOST_A, HOST_B];
  selected: HostDirectoryEntry | null = null;
  private readonly handlers = new Set<
    (entry: HostDirectoryEntry | null) => void
  >();

  async list(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entries.find((entry) => entry.hostId === hostId) ?? null;
  }

  async refresh(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  async refreshForEra(_era: AuthEra): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  invalidateInFlightRefresh(): void {
    return;
  }

  getSelected(): HostDirectoryEntry | null {
    return this.selected;
  }

  selectById(hostId: string | null): void {
    this.selected = hostId === null ? null : this.findById(hostId);
    for (const handler of this.handlers) {
      handler(this.selected);
    }
  }

  onSelectionChange(
    handler: (entry: HostDirectoryEntry | null) => void,
  ): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }
}

interface FanOutFixture {
  readonly runtime: HostRuntime<typeof registry>;
  readonly directory: FanOutDirectory;
  readonly invalidator: RecordingInvalidator;
  readonly messenger: MockHostMessenger<typeof registry>;
  readonly pending: Deferred[];
}

function buildFanOutFixture(): FanOutFixture {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  const fixture = createAuthenticatedUserFixture(undefined);
  const user: AuthenticatedUser = {
    ...fixture,
    user: { ...fixture.user, id: "user-1" },
  };
  provider.setSignedIn({
    user,
    bearerToken: "tok-1",
    operationId: undefined,
    externalAbortSignal: undefined,
  });

  const directory = new FanOutDirectory();
  directory.selected = HOST_A;
  const invalidator = new RecordingInvalidator();
  const pending: Deferred[] = [];
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    // Every call parks until the test settles it, so a request is genuinely
    // IN FLIGHT while the activation lands - the only state in which an abort
    // is observable at all.
    handlers: {
      "host.ping": () => {
        const deferred = createDeferred();
        pending.push(deferred);
        return deferred.promise;
      },
    },
    requestId: () => "req-1",
  });
  const runtime = new HostRuntime({
    runnerHost: new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: directory.entries,
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    registry,
    messenger,
    requestContextProvider: provider,
    directory,
    invalidator,
    schedulingPolicy,
    // The REAL coordinator: `abortHostTransition` is what used to kill a
    // pinned surface's in-flight work, so a fake here would test nothing.
    requestCoordinator: null,
  });
  runtime.start();
  return { runtime, directory, invalidator, messenger, pending };
}

describe("activation fan-out", () => {
  it("leaves a pinned surface's in-flight request untouched when the effective host moves off its host", async () => {
    const { runtime, directory, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    const inFlight = pinnedToA.request("host.ping", {});
    expect(pending).toHaveLength(1);

    directory.selectById(HOST_B.hostId);
    expect(runtime.hostClient.getActiveHostId()).toBe(HOST_B.hostId);

    pending[0]?.settle();
    await expect(inFlight).resolves.toEqual({ pong: true });
  });

  it("sweeps no host's query scope when the effective host moves", () => {
    const { directory, invalidator } = buildFanOutFixture();
    // `start()` applied the context before any host was bound; drop that
    // identity-transition sweep so what remains is the activation alone.
    invalidator.invalidateCalls.length = 0;
    invalidator.cancelCalls.length = 0;

    directory.selectById(HOST_B.hostId);

    // Not the outgoing host (surfaces pinned to it did not move), and not the
    // incoming one either (its consumers re-key onto its host-scoped keys and
    // fetch on demand - the sweep only ever made that louder).
    expect(invalidator.invalidateCalls).toEqual([]);
    expect(invalidator.cancelCalls).toEqual([]);
  });

  it("keeps serving the deselected host: a NEW request still reaches it", async () => {
    const { runtime, directory, messenger, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    directory.selectById(HOST_B.hostId);

    const afterDeselect = pinnedToA.request("host.ping", {});
    pending[0]?.settle();
    await expect(afterDeselect).resolves.toEqual({ pong: true });
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(HOST_A.hostId);
    expect(messenger.calls[0]?.authority.endpoint.websocketUrl).toBe(
      HOST_A.websocketUrl,
    );
  });

  it("cancels a pinned surface's own read after deselection, not the effective host's", async () => {
    const { runtime, directory, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    const inFlight = pinnedToA.request("host.ping", {});
    expect(pending).toHaveLength(1);
    directory.selectById(HOST_B.hostId);

    // The coordinator keys cancellation on `(hostId, userId, method, params)`.
    // Routed through the active slot this would have named B and cancelled
    // nothing, leaving the surface unable to release its own read the moment
    // its host stopped being effective.
    pinnedToA.cancelActiveRead("host.ping", {});
    await expect(inFlight).rejects.toThrow();
  });

  it("resolves the window-global client from the effective host id, and pins what it resolved", async () => {
    const { runtime, directory, messenger, pending } = buildFanOutFixture();

    // What a window-global consumer holds for one paint: the effective host
    // id, resolved through the same requester mechanism a pin uses.
    const whileAIsEffective = runtime.hostClient.createRequesterForHostId(
      HOST_A.hostId,
    );
    expect(whileAIsEffective.getActiveHostId()).toBe(HOST_A.hostId);

    directory.selectById(HOST_B.hostId);

    // The client from the PREVIOUS paint still addresses A. A consumer that
    // re-renders gets B; one mid-chain finishes where it aimed. Under the
    // active slot both of those were the same mutable object, so a call in
    // flight silently re-aimed at B.
    const inFlight = whileAIsEffective.request("host.ping", {});
    pending[0]?.settle();
    await expect(inFlight).resolves.toEqual({ pong: true });
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(HOST_A.hostId);

    expect(
      runtime.hostClient
        .createRequesterForHostId(HOST_B.hostId)
        .getActiveHostId(),
    ).toBe(HOST_B.hostId);
  });

  it("answers ∅ and an unresolved row exactly as an unbound client always did", async () => {
    const { runtime } = buildFanOutFixture();

    const empty = runtime.hostClient.createRequesterForHostId(null);
    expect(empty.getActiveHostId()).toBe(null);
    expect(empty.getActiveHost()).toBe(null);
    await expect(empty.request("host.ping", {})).rejects.toThrow(
      /without an active host/,
    );

    // An id the directory cannot resolve reports `null` too - the same answer
    // `selectById` produced by binding `null`, so every readiness gate keeps
    // reading the value it read before.
    const unresolved =
      runtime.hostClient.createRequesterForHostId("nobody-here");
    expect(unresolved.getActiveHostId()).toBe(null);
    await expect(unresolved.request("host.ping", {})).rejects.toThrow(
      /without an active host/,
    );
  });
});
