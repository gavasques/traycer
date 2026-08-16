import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type SelectionAuthorityClient,
  type SelectionChange,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  silentAuthorityLog,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  createInProcessSelectionAuthorityClient,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  mountSelectionAuthorityBridge,
  type SelectionDirectoryBinding,
} from "@/lib/host/selection-authority-bridge";
import {
  subscribeFollowingSurfaceReset,
  type FollowingSurfaceResetListener,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** Flushes the microtask queue enough times for the attach choreography to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

class RecordingDirectory implements SelectionDirectoryBinding {
  readonly calls: Array<string | null> = [];
  selectById(hostId: string | null): void {
    this.calls.push(hostId);
  }
}

interface TestAuthority {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly fleet: InMemoryHostFleetSource;
  readonly identity: InMemoryAuthorityIdentitySource;
  readonly preferredStore: InMemoryPreferredHostStore;
  readonly client: SelectionAuthorityClient;
  dispose(): void;
}

function buildAuthority(input: {
  readonly localHostId: string | null;
  readonly hosts: readonly { hostId: string; kind: "local" | "remote" }[];
  readonly identityKey: string;
  /** Pre-seed the preferred store BEFORE the engine reads it at construction. */
  readonly seedPreferred?: string | null;
}): TestAuthority {
  const preferredStore = new InMemoryPreferredHostStore();
  if (input.seedPreferred !== undefined) {
    preferredStore.save(input.identityKey, input.seedPreferred);
  }
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: input.localHostId,
    hosts: input.hosts,
  });
  const identity = new InMemoryAuthorityIdentitySource(input.identityKey);
  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity,
    localHostEnsure: unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore,
    clock: { now: () => 0, schedule: () => () => undefined },
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  const client = createInProcessSelectionAuthorityClient(engine, silentAuthorityLog);
  return {
    engine,
    fleet,
    identity,
    preferredStore,
    client,
    dispose: () => {
      client.dispose();
      engine.dispose();
    },
  };
}

/** Feeds `CONFIRMED_DEATH_REFUSAL_STREAK` refusals from a second, synthetic window. */
function killHost(engine: SelectionAuthorityEngineImpl, hostId: string): void {
  const seq = engine.allocateAttachSeq("other-window");
  const attach = engine.attach("other-window", {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!attach.ok) throw new Error("expected the synthetic window to attach");
  for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
    engine.ingestEvidence("other-window", attach.incarnationId, {
      kind: "dial",
      hostId,
      attemptId: `kill-${i}`,
      outcome: "confirmed-refusal",
      refusalDetail: null,
      transportKind: "remote-relay",
      at: i,
    });
  }
}

/** Proves a dead host alive again from the same synthetic second window. */
function reviveHost(engine: SelectionAuthorityEngineImpl, hostId: string): void {
  const seq = engine.allocateAttachSeq("other-window");
  const attach = engine.attach("other-window", {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!attach.ok) throw new Error("expected the synthetic window to re-attach");
  engine.ingestEvidence("other-window", attach.incarnationId, {
    kind: "dial",
    hostId,
    attemptId: "revive",
    outcome: "success",
    transportKind: "remote-relay",
    at: 0,
  });
}

beforeEach(() => {
  useSelectionAuthorityStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  useSelectionAuthorityStore.getState().reset();
});

describe("mountSelectionAuthorityBridge", () => {
  it("(a) pushes a kernel snapshot's effectiveHostId into directory.selectById AND the store", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [{ hostId: "L", kind: "local" }],
      identityKey: "acct-1",
    });
    const directory = new RecordingDirectory();
    const bridge = mountSelectionAuthorityBridge({
      client: authority.client,
      directory,
      now: () => 0,
    });
    await flushMicrotasks();

    // With no preference, M5 derives the local host as both target and
    // effective the moment this window's attach installs the current state.
    expect(directory.calls.at(-1)).toBe("L");
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");
    expect(useSelectionAuthorityStore.getState().attached).toBe(true);

    bridge.dispose();
    authority.dispose();
  });

  it("(b) the attach's OWN snapshot carries an already-settled preference - no subsequent change event is needed", async () => {
    // The preference is seeded into the store BEFORE the engine is
    // constructed, the way a restart finds it already on disk (G1). Nothing
    // in this test ever calls `activate` or otherwise emits a NEW
    // selectionChanged event - the only thing that can move the directory is
    // the bridge's own initial `apply(kernel.snapshot())` /
    // `kernel.start()` installing the attach's snapshot.
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [
        { hostId: "L", kind: "local" },
        { hostId: "P", kind: "remote" },
      ],
      identityKey: "acct-1",
      seedPreferred: "P",
    });
    expect(authority.engine.snapshot().preferredHostId).toBe("P");
    const directory = new RecordingDirectory();
    const bridge = mountSelectionAuthorityBridge({
      client: authority.client,
      directory,
      now: () => 0,
    });
    await flushMicrotasks();

    expect(directory.calls.at(-1)).toBe("P");
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");

    bridge.dispose();
    authority.dispose();
  });

  it("(c) fires HostFailover on a failover cause, HostRecovered on a recovery cause, and neither on activate/fleet-shift - the G4 hook fires on every effective change", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [
        { hostId: "L", kind: "local" },
        { hostId: "P", kind: "remote" },
      ],
      identityKey: "acct-1",
    });
    const directory = new RecordingDirectory();
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: Array<{
      previousEffectiveHostId: string | null;
      nextEffectiveHostId: string | null;
    }> = [];
    const g4Listener: FollowingSurfaceResetListener = (event) => {
      g4Events.push(event);
    };
    const unsubscribeG4 = subscribeFollowingSurfaceReset(g4Listener);
    const bridge = mountSelectionAuthorityBridge({
      client: authority.client,
      directory,
      now: () => 0,
    });
    await flushMicrotasks();
    // Settled on L (M5, no preference yet).
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");

    // cause: activate - moves effective from L to P. Neither analytics event
    // fires for it, but the G4 hook does (it fires on ANY effective change).
    const seqA = authority.engine.allocateAttachSeq("this-window-probe");
    // Use the bridge's OWN attached window to activate rather than a second
    // one, matching how Settings ▸ Activate really calls it: through the
    // SAME client this bridge wraps.
    void seqA; // not used directly; activate goes through the client below.
    expect(
      await authority.client.activate("P"),
    ).toEqual({ ok: true });
    await flushMicrotasks();
    expect(directory.calls.at(-1)).toBe("P");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "L",
      nextEffectiveHostId: "P",
    });
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostFailover,
      null,
    );
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostRecovered,
      null,
    );

    // cause: failover - P (preferred, target) dies; effective moves off it
    // to L, which is NOT the target, so the engine's own resolveCause names
    // this "failover".
    killHost(authority.engine, "P");
    await flushMicrotasks();
    expect(directory.calls.at(-1)).toBe("L");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "P",
      nextEffectiveHostId: "L",
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostFailover, null);
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostRecovered,
      null,
    );

    // cause: recovery - P (still the target/preferred) proves alive again;
    // effective lands back ON the target, which the engine names "recovery".
    trackSpy.mockClear();
    reviveHost(authority.engine, "P");
    await flushMicrotasks();
    expect(directory.calls.at(-1)).toBe("P");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "L",
      nextEffectiveHostId: "P",
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostRecovered, null);
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostFailover,
      null,
    );

    // cause: fleet-shift - a new, unrelated host joins the fleet. Effective
    // stays P throughout, so NEITHER analytics event fires and the G4 hook
    // gets no new entry.
    trackSpy.mockClear();
    const g4CountBeforeFleetShift = g4Events.length;
    authority.fleet.publish(0, "L", [
      { hostId: "L", kind: "local" },
      { hostId: "P", kind: "remote" },
      { hostId: "Q", kind: "remote" },
    ]);
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");
    expect(g4Events.length).toBe(g4CountBeforeFleetShift);
    expect(trackSpy).not.toHaveBeenCalled();

    unsubscribeG4();
    bridge.dispose();
    authority.dispose();
  });

  it("(d) an event whose effectiveHostId equals its previousEffectiveHostId narrates nothing, even when its cause is failover/recovery", () => {
    // A REAL engine cannot currently produce this shape: on every path that
    // tags a commit "failover" (ingestEvidence/attach/detach/local-outage/
    // the deadline timer), `effectiveHostId` is the only field of the
    // selection tuple those paths can move, so `selectionEquals` guarantees
    // any event they emit has ALREADY changed it - `stage()` never queues an
    // event otherwise. The CONTRACT still allows the shape (`SelectionChange`
    // has no invariant tying `cause` to whether `effectiveHostId` moved), and
    // this guard is what makes that legal-but-inert shape a no-op rather than
    // a misfired `HostFailover`/`HostRecovered`. Isolated at the same fake
    // `SelectionAuthorityClient` boundary as (e), for the same reason.
    const selectionListeners: Array<
      (event: SelectionRevisioned<SelectionChange>) => void
    > = [];
    const NO_SUB: SelectionSubscription = { dispose: () => undefined };
    const fakeClient: SelectionAuthorityClient = {
      attach: () =>
        Promise.resolve({
          ok: true,
          incarnationId: "inc-1",
          snapshot: {
            contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
            revision: 0,
            preferredHostId: null,
            targetHostId: null,
            effectiveHostId: null,
            leases: [],
          },
        }),
      reportEvidence: () => Promise.resolve(),
      activate: () => Promise.resolve({ ok: false, reason: "not-attached" }),
      onSelectionChanged: (listener) => {
        selectionListeners.push(listener);
        return NO_SUB;
      },
      onLeasesChanged: () => NO_SUB,
      onReattachRequired: () => NO_SUB,
    };
    const directory = new RecordingDirectory();
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: unknown[] = [];
    const unsubscribeG4 = subscribeFollowingSurfaceReset((event) => {
      g4Events.push(event);
    });
    const bridge = mountSelectionAuthorityBridge({
      client: fakeClient,
      directory,
      now: () => 0,
    });
    expect(selectionListeners.length).toBe(2);
    const emit = (event: SelectionRevisioned<SelectionChange>): void => {
      for (const listener of selectionListeners) listener(event);
    };

    // cause: failover, effective unchanged at null->null (targetHostId moved
    // to a preferred host that is itself unusable - ∅ throughout).
    emit({
      revision: 5,
      change: {
        preferredHostId: "H",
        targetHostId: "H",
        effectiveHostId: null,
        previousEffectiveHostId: null,
        cause: "failover",
      },
    });
    expect(g4Events.length).toBe(0);
    expect(trackSpy).not.toHaveBeenCalled();

    // cause: recovery, effective unchanged (already sitting on the target).
    emit({
      revision: 6,
      change: {
        preferredHostId: "H",
        targetHostId: "H",
        effectiveHostId: "H",
        previousEffectiveHostId: "H",
        cause: "recovery",
      },
    });
    expect(g4Events.length).toBe(0);
    expect(trackSpy).not.toHaveBeenCalled();

    unsubscribeG4();
    bridge.dispose();
  });

  it("(e) a replayed/stale revision narrates at most once", () => {
    // Isolated at the SelectionAuthorityClient contract boundary: a real
    // engine never redelivers a revision, so the guard this pins
    // (`subscribeNarration`'s own monotonic high-water mark) can only be
    // exercised with a controllable fake transport. The bridge registers
    // TWO independent `onSelectionChanged` subscribers (the kernel itself,
    // and `subscribeNarration`), so every listener must be tracked and
    // invoked - narration's is not necessarily the last one registered.
    const selectionListeners: Array<
      (event: SelectionRevisioned<SelectionChange>) => void
    > = [];
    const NO_SUB: SelectionSubscription = { dispose: () => undefined };
    const fakeClient: SelectionAuthorityClient = {
      attach: () =>
        Promise.resolve({
          ok: true,
          incarnationId: "inc-1",
          snapshot: {
            contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
            revision: 0,
            preferredHostId: null,
            targetHostId: null,
            effectiveHostId: null,
            leases: [],
          },
        }),
      reportEvidence: () => Promise.resolve(),
      activate: () => Promise.resolve({ ok: false, reason: "not-attached" }),
      onSelectionChanged: (listener) => {
        selectionListeners.push(listener);
        return NO_SUB;
      },
      onLeasesChanged: () => NO_SUB,
      onReattachRequired: () => NO_SUB,
    };
    const directory = new RecordingDirectory();
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: unknown[] = [];
    const unsubscribeG4 = subscribeFollowingSurfaceReset((event) => {
      g4Events.push(event);
    });
    const bridge = mountSelectionAuthorityBridge({
      client: fakeClient,
      directory,
      now: () => 0,
    });
    expect(selectionListeners.length).toBe(2);
    const change: SelectionChange = {
      preferredHostId: "H",
      targetHostId: "H",
      effectiveHostId: "H",
      previousEffectiveHostId: null,
      cause: "activate",
    };
    const emit = (event: SelectionRevisioned<SelectionChange>): void => {
      for (const listener of selectionListeners) listener(event);
    };
    emit({ revision: 5, change });
    expect(g4Events.length).toBe(1);
    // The SAME revision, replayed: must not narrate again.
    emit({ revision: 5, change });
    expect(g4Events.length).toBe(1);
    // A LOWER (stale/reordered) revision: must not narrate either.
    emit({ revision: 3, change });
    expect(g4Events.length).toBe(1);
    void trackSpy;

    unsubscribeG4();
    bridge.dispose();
  });

  it("(f) dispose unsubscribes and resets the store", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [{ hostId: "L", kind: "local" }],
      identityKey: "acct-1",
    });
    const directory = new RecordingDirectory();
    const bridge = mountSelectionAuthorityBridge({
      client: authority.client,
      directory,
      now: () => 0,
    });
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().attached).toBe(true);

    bridge.dispose();
    expect(useSelectionAuthorityStore.getState().attached).toBe(false);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();

    // Unsubscribed: further activity on the underlying authority must not
    // move the directory or the store again.
    const callsAtDispose = directory.calls.length;
    authority.fleet.publish(0, "L", [
      { hostId: "L", kind: "local" },
      { hostId: "M", kind: "remote" },
    ]);
    await flushMicrotasks();
    expect(directory.calls.length).toBe(callsAtDispose);
    expect(useSelectionAuthorityStore.getState().attached).toBe(false);

    authority.dispose();
  });
});
