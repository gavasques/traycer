import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type ActivateResult,
  type HostLeaseSnapshot,
  type SelectionAttachRequest,
  type SelectionAttachResult,
  type SelectionAuthoritySnapshot,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "../selection-authority-contract";
import { silentAuthorityLog } from "../selection-authority-engine";
import {
  BufferedSelectionAuthorityClient,
  RotatingSelectionAuthorityClient,
  type SelectionAuthorityClientTransport,
} from "../buffered-selection-authority-client";

// ------------------------------------------------------------------ builders

function snapshotAt(revision: number): SelectionAuthoritySnapshot {
  return {
    contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    revision,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
  };
}

function selectionChangeStub(): SelectionChange {
  return {
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    previousEffectiveHostId: null,
    cause: "failover",
  };
}

function dialReportStub(hostId: string, attemptId: string): SelectionEvidenceReport {
  return { kind: "dial", hostId, attemptId, outcome: "success", transportKind: "remote-relay", at: 0 };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records every call the client instance makes and gives the test full
 * control over when `attach` resolves and what it resolves with - the
 * plan explicitly wants a fake transport, not a real engine, for this file.
 */
class FakeTransport implements SelectionAuthorityClientTransport {
  private readonly seqs: readonly number[];
  private seqIndex = 0;

  readonly attachRequests: SelectionAttachRequest[] = [];
  readonly reportEvidenceCalls: Array<{
    readonly incarnationId: string;
    readonly report: SelectionEvidenceReport;
  }> = [];
  readonly activateCalls: Array<{ readonly incarnationId: string; readonly hostId: string }> = [];

  /**
   * Incremented by every subscription's `dispose()` - the three the
   * constructor takes out (selection/leases/reattach). This is what tells
   * "the instance disposed" apart from "the instance merely never went
   * live": a client stuck in `buffering` also delivers nothing and also
   * never calls `reportEvidence`, but it never disposes its subscriptions.
   */
  disposedSubscriptionCount = 0;

  reportEvidenceImpl: (incarnationId: string, report: SelectionEvidenceReport) => Promise<void> =
    () => Promise.resolve();
  activateImpl: (incarnationId: string, hostId: string) => Promise<ActivateResult> = () =>
    Promise.resolve({ ok: false, reason: "unrecognized" });

  private readonly attachDeferreds: Array<Deferred<SelectionAttachResult>> = [];
  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<(event: SelectionReattachRequired) => void>();

  constructor(seqs: readonly number[]) {
    this.seqs = seqs;
  }

  allocateAttachSeq(): number {
    const seq = this.seqs[this.seqIndex] ?? -1;
    this.seqIndex += 1;
    return seq;
  }

  attach(request: SelectionAttachRequest): Promise<SelectionAttachResult> {
    this.attachRequests.push(request);
    const deferred = createDeferred<SelectionAttachResult>();
    this.attachDeferreds.push(deferred);
    return deferred.promise;
  }

  resolveLastAttach(result: SelectionAttachResult): void {
    const deferred = this.attachDeferreds[this.attachDeferreds.length - 1];
    if (deferred === undefined) throw new Error("no pending attach to resolve");
    deferred.resolve(result);
  }

  rejectLastAttach(error: unknown): void {
    const deferred = this.attachDeferreds[this.attachDeferreds.length - 1];
    if (deferred === undefined) throw new Error("no pending attach to reject");
    deferred.reject(error);
  }

  reportEvidence(incarnationId: string, report: SelectionEvidenceReport): Promise<void> {
    this.reportEvidenceCalls.push({ incarnationId, report });
    return this.reportEvidenceImpl(incarnationId, report);
  }

  activate(incarnationId: string, hostId: string): Promise<ActivateResult> {
    this.activateCalls.push({ incarnationId, hostId });
    return this.activateImpl(incarnationId, hostId);
  }

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
        this.disposedSubscriptionCount += 1;
      },
    };
  }

  onLeasesChanged(
    listener: (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void,
  ): SelectionSubscription {
    this.leaseListeners.add(listener);
    return {
      dispose: () => {
        this.leaseListeners.delete(listener);
        this.disposedSubscriptionCount += 1;
      },
    };
  }

  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription {
    this.reattachListeners.add(listener);
    return {
      dispose: () => {
        this.reattachListeners.delete(listener);
        this.disposedSubscriptionCount += 1;
      },
    };
  }

  emitSelection(event: SelectionRevisioned<SelectionChange>): void {
    for (const listener of Array.from(this.selectionListeners)) listener(event);
  }

  emitLeases(event: SelectionRevisioned<readonly HostLeaseSnapshot[]>): void {
    for (const listener of Array.from(this.leaseListeners)) listener(event);
  }

  emitReattach(event: SelectionReattachRequired): void {
    for (const listener of Array.from(this.reattachListeners)) listener(event);
  }
}

// -------------------------------------------------------------------- tests

describe("BufferedSelectionAuthorityClient - buffer then replay", () => {
  it("buffers events delivered before attach resolves, drops those at/below the snapshot revision, and replays the rest interleaved in ascending revision order", async () => {
    const transport = new FakeTransport([5]);
    const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);

    const attachPromise = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);

    const received: string[] = [];
    client.onSelectionChanged((event) => received.push(`selection:${event.revision}`));
    client.onLeasesChanged((event) => received.push(`leases:${event.revision}`));
    client.onReattachRequired((event) => received.push(`reattach:${event.revision}`));

    // Interleaved, out of order, all buffered because the instance has not
    // gone live yet.
    transport.emitLeases({ revision: 2, change: [] });
    transport.emitReattach({ revision: 4 });
    transport.emitSelection({ revision: 1, change: selectionChangeStub() });
    transport.emitSelection({ revision: 3, change: selectionChangeStub() });

    expect(received).toEqual([]);

    transport.resolveLastAttach({ ok: true, incarnationId: "inc-1", snapshot: snapshotAt(2) });
    const result = await attachPromise;
    expect(result.ok).toBe(true);

    // revision <= 2 (leases:2, selection:1) dropped; the rest replayed ascending.
    expect(received).toEqual(["selection:3", "reattach:4"]);
  });

  it("after going live, an event at or below the high-water mark is dropped", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    const attachPromise = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    transport.resolveLastAttach({ ok: true, incarnationId: "inc-1", snapshot: snapshotAt(5) });
    await attachPromise;

    const received: number[] = [];
    client.onReattachRequired((event) => received.push(event.revision));

    transport.emitReattach({ revision: 5 });
    transport.emitReattach({ revision: 6 });

    expect(received).toEqual([6]);
  });
});

describe("BufferedSelectionAuthorityClient - failure arms dispose", () => {
  const failureCases: ReadonlyArray<{
    readonly name: string;
    readonly resolveWith: SelectionAttachResult | null;
  }> = [
    { name: "superseded", resolveWith: { ok: false, kind: "superseded" } },
    {
      name: "version-mismatch",
      resolveWith: {
        ok: false,
        kind: "version-mismatch",
        authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
        callerVersion: 99,
      },
    },
    {
      name: "malformed-request",
      resolveWith: { ok: false, kind: "malformed-request", claimed: true },
    },
    { name: "transport rejection", resolveWith: null },
  ];

  for (const failureCase of failureCases) {
    it(`disposes on ${failureCase.name}: no further delivery, no reportEvidence transport call`, async () => {
      const transport = new FakeTransport([1]);
      const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
      const received: number[] = [];
      client.onSelectionChanged((event) => received.push(event.revision));

      const attachPromise = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
      if (failureCase.resolveWith === null) {
        transport.rejectLastAttach(new Error("boom"));
      } else {
        transport.resolveLastAttach(failureCase.resolveWith);
      }
      const result = await attachPromise;
      expect(result.ok).toBe(false);
      expect(result).toEqual(failureCase.resolveWith ?? { ok: false, kind: "superseded" });

      // The instance actually tore down its transport subscriptions (all
      // three: selection, leases, reattach) - not merely stuck buffering,
      // which would also produce zero delivery and zero reportEvidence
      // calls but leak the listeners.
      expect(transport.disposedSubscriptionCount).toBe(3);

      transport.emitSelection({ revision: 999, change: selectionChangeStub() });
      expect(received).toEqual([]);

      await client.reportEvidence(dialReportStub("H", "attempt-1"));
      expect(transport.reportEvidenceCalls.length).toBe(0);
    });
  }
});

describe("BufferedSelectionAuthorityClient - attach-once and seq guards", () => {
  it("a second attach() on the same instance answers superseded without a transport call", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    const first = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    transport.resolveLastAttach({ ok: true, incarnationId: "inc-1", snapshot: snapshotAt(0) });
    await first;

    const attachCallsBefore = transport.attachRequests.length;
    const second = await client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    expect(second).toEqual({ ok: false, kind: "superseded" });
    expect(transport.attachRequests.length).toBe(attachCallsBefore);
  });

  it("an instance whose allocateAttachSeq returned a negative seq answers superseded without calling the transport", async () => {
    const transport = new FakeTransport([-1]);
    const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    const result = await client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    expect(result).toEqual({ ok: false, kind: "superseded" });
    expect(transport.attachRequests.length).toBe(0);
  });
});

describe("BufferedSelectionAuthorityClient - incarnation stamping", () => {
  it("reportEvidence and activate stamp the incarnation from the attach result; a rejected reportEvidence resolves without throwing", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    const attachPromise = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    transport.resolveLastAttach({ ok: true, incarnationId: "inc-77", snapshot: snapshotAt(0) });
    await attachPromise;

    await client.reportEvidence(dialReportStub("H", "a1"));
    expect(transport.reportEvidenceCalls[0]?.incarnationId).toBe("inc-77");

    await client.activate("H");
    expect(transport.activateCalls[0]?.incarnationId).toBe("inc-77");

    transport.reportEvidenceImpl = () => Promise.reject(new Error("dropped"));
    await expect(client.reportEvidence(dialReportStub("H", "a2"))).resolves.toBeUndefined();
  });
});

describe("RotatingSelectionAuthorityClient - rotation ordering", () => {
  it("builds the next instance (allocating its own seq) before notifying consumers, so the consumer's attach() lands on the new seq", async () => {
    const transports: FakeTransport[] = [];
    const seqQueues = [[1], [2]];
    let instanceIndex = 0;
    const createInstance = (): BufferedSelectionAuthorityClient => {
      const queue = seqQueues[instanceIndex];
      if (queue === undefined) throw new Error("ran out of seq queues");
      const transport = new FakeTransport(queue);
      transports.push(transport);
      instanceIndex += 1;
      return new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    };
    const rotating = new RotatingSelectionAuthorityClient(createInstance, silentAuthorityLog);

    const firstTransport = transports[0];
    const firstAttach = rotating.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    firstTransport.resolveLastAttach({ ok: true, incarnationId: "inc-1", snapshot: snapshotAt(0) });
    await firstAttach;

    let secondAttachPromise: Promise<SelectionAttachResult> | null = null;
    rotating.onReattachRequired(() => {
      secondAttachPromise = rotating.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    });

    firstTransport.emitReattach({ revision: 99 });

    expect(transports.length).toBe(2);
    const secondTransport = transports[1];
    expect(secondTransport.attachRequests.length).toBe(1);
    expect(secondTransport.attachRequests[0]?.attachSeq).toBe(2);

    secondTransport.resolveLastAttach({ ok: true, incarnationId: "inc-2", snapshot: snapshotAt(0) });
    if (secondAttachPromise === null) throw new Error("expected the reattach handler to have fired");
    await secondAttachPromise;
  });

  it("listeners registered once on the rotating client keep receiving events after a rotation", async () => {
    const transports: FakeTransport[] = [];
    const seqQueues = [[1], [2]];
    let instanceIndex = 0;
    const createInstance = (): BufferedSelectionAuthorityClient => {
      const queue = seqQueues[instanceIndex];
      if (queue === undefined) throw new Error("ran out of seq queues");
      const transport = new FakeTransport(queue);
      transports.push(transport);
      instanceIndex += 1;
      return new BufferedSelectionAuthorityClient(transport, silentAuthorityLog);
    };
    const rotating = new RotatingSelectionAuthorityClient(createInstance, silentAuthorityLog);

    const firstTransport = transports[0];
    const firstAttach = rotating.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    firstTransport.resolveLastAttach({ ok: true, incarnationId: "inc-1", snapshot: snapshotAt(0) });
    await firstAttach;

    const received: number[] = [];
    rotating.onLeasesChanged((event) => received.push(event.revision));

    let secondAttachPromise: Promise<SelectionAttachResult> | null = null;
    rotating.onReattachRequired(() => {
      secondAttachPromise = rotating.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    });

    firstTransport.emitReattach({ revision: 50 });
    const secondTransport = transports[1];
    secondTransport.resolveLastAttach({ ok: true, incarnationId: "inc-2", snapshot: snapshotAt(0) });
    if (secondAttachPromise === null) throw new Error("expected the reattach handler to have fired");
    await secondAttachPromise;

    // Events from the FIRST (now-retired) instance must not reach the listener.
    firstTransport.emitLeases({ revision: 999, change: [] });
    expect(received).toEqual([]);

    secondTransport.emitLeases({ revision: 1, change: [] });
    expect(received).toEqual([1]);
  });
});
