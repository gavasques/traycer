import { describe, expect, it } from "vitest";
import {
  type ActivateResult,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type SelectionAttachResult,
  type SelectionAuthorityClient,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "../selection-authority-contract";
import { silentAuthorityLog } from "../selection-authority-engine";
import {
  SelectionEvidenceKernel,
  type SelectionKernelSnapshot,
} from "../selection-evidence-kernel";

/**
 * Records every call the kernel makes, in order, and gives the test full
 * control over the attach result - the plan wants a fake
 * `SelectionAuthorityClient`, not a real engine, for this file.
 */
class FakeAuthorityClient implements SelectionAuthorityClient {
  readonly callOrder: string[] = [];
  readonly attachCalls: Array<{
    readonly callerContractVersion: number;
    readonly liveSessions: readonly LiveSessionAnnouncement[];
  }> = [];
  readonly reportEvidenceCalls: SelectionEvidenceReport[] = [];
  readonly activateCalls: string[] = [];

  attachImpl: (
    callerContractVersion: number,
    liveSessions: readonly LiveSessionAnnouncement[],
  ) => Promise<SelectionAttachResult> = () => Promise.resolve({ ok: false, kind: "superseded" });

  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<(event: SelectionReattachRequired) => void>();

  attach(
    callerContractVersion: number,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): Promise<SelectionAttachResult> {
    this.callOrder.push("attach");
    this.attachCalls.push({ callerContractVersion, liveSessions });
    return this.attachImpl(callerContractVersion, liveSessions);
  }

  reportEvidence(report: SelectionEvidenceReport): Promise<void> {
    this.reportEvidenceCalls.push(report);
    return Promise.resolve();
  }

  activate(hostId: string): Promise<ActivateResult> {
    this.activateCalls.push(hostId);
    return Promise.resolve({ ok: false, reason: "unrecognized" });
  }

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.callOrder.push("onSelectionChanged");
    this.selectionListeners.add(listener);
    return { dispose: () => this.selectionListeners.delete(listener) };
  }

  onLeasesChanged(
    listener: (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void,
  ): SelectionSubscription {
    this.callOrder.push("onLeasesChanged");
    this.leaseListeners.add(listener);
    return { dispose: () => this.leaseListeners.delete(listener) };
  }

  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription {
    this.callOrder.push("onReattachRequired");
    this.reattachListeners.add(listener);
    return { dispose: () => this.reattachListeners.delete(listener) };
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

function okAttach(revision: number): SelectionAttachResult {
  return {
    ok: true,
    incarnationId: "inc-1",
    snapshot: {
      contractVersion: 1,
      revision,
      preferredHostId: null,
      targetHostId: null,
      effectiveHostId: null,
      leases: [],
    },
  };
}

describe("SelectionEvidenceKernel - start choreography", () => {
  it("registers the three listeners before calling attach", () => {
    const client = new FakeAuthorityClient();
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });
    void kernel.start();
    expect(client.callOrder.slice(0, 4)).toEqual([
      "onSelectionChanged",
      "onLeasesChanged",
      "onReattachRequired",
      "attach",
    ]);
  });

  it("sessions established before start() are carried in the attach inventory", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });

    kernel.sessionEstablished("H", "s1", "local-ws");
    await kernel.start();

    expect(client.attachCalls[0]?.liveSessions).toEqual([
      { hostId: "H", sessionId: "s1", transportKind: "local-ws" },
    ]);
  });
});

describe("SelectionEvidenceKernel - session evidence", () => {
  it("sessionEstablished/sessionLost update the inventory and report the matching evidence", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });
    await kernel.start();

    kernel.sessionEstablished("H", "s1", "local-ws");
    expect(client.reportEvidenceCalls[client.reportEvidenceCalls.length - 1]).toEqual({
      kind: "session",
      hostId: "H",
      sessionId: "s1",
      transition: "established",
      transportKind: "local-ws",
      at: 0,
    });
    expect(kernel.localSessionCount("H")).toBe(1);

    kernel.sessionLost("H", "s1", "local-ws");
    expect(client.reportEvidenceCalls[client.reportEvidenceCalls.length - 1]).toEqual({
      kind: "session",
      hostId: "H",
      sessionId: "s1",
      transition: "lost",
      transportKind: "local-ws",
      at: 0,
    });
    expect(kernel.localSessionCount("H")).toBe(0);
  });
});

describe("SelectionEvidenceKernel - dial evidence shapes", () => {
  it("each reportDial* produces the exact contract shape; confirmed-refusal only comes from reportDialRefusal", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 42, log: silentAuthorityLog });
    await kernel.start();
    client.reportEvidenceCalls.length = 0;

    kernel.reportDialSuccess("H", "a1", "local-ws");
    kernel.reportDialTimeout("H", "a2", "local-ws");
    kernel.reportDialIndeterminate("H", "a3", "local-ws");
    kernel.reportDialRefusal("H", "a4", "local-ws", "plan-restricted");
    kernel.reportDialRefusal("H", "a5", "local-ws", null);

    expect(client.reportEvidenceCalls).toEqual([
      { kind: "dial", hostId: "H", attemptId: "a1", outcome: "success", transportKind: "local-ws", at: 42 },
      { kind: "dial", hostId: "H", attemptId: "a2", outcome: "timeout", transportKind: "local-ws", at: 42 },
      {
        kind: "dial",
        hostId: "H",
        attemptId: "a3",
        outcome: "indeterminate",
        transportKind: "local-ws",
        at: 42,
      },
      {
        kind: "dial",
        hostId: "H",
        attemptId: "a4",
        outcome: "confirmed-refusal",
        refusalDetail: "plan-restricted",
        transportKind: "local-ws",
        at: 42,
      },
      {
        kind: "dial",
        hostId: "H",
        attemptId: "a5",
        outcome: "confirmed-refusal",
        refusalDetail: null,
        transportKind: "local-ws",
        at: 42,
      },
    ]);
    expect(client.reportEvidenceCalls[0]).not.toHaveProperty("refusalDetail");
    expect(client.reportEvidenceCalls[1]).not.toHaveProperty("refusalDetail");
    expect(client.reportEvidenceCalls[2]).not.toHaveProperty("refusalDetail");
  });
});

describe("SelectionEvidenceKernel - compat evidence", () => {
  it("reportCompatVerdict emits the compatible arm with incompatibility null and the incompatible arm with its detail", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 7, log: silentAuthorityLog });
    await kernel.start();
    client.reportEvidenceCalls.length = 0;

    kernel.reportCompatVerdict({
      hostId: "H",
      probedOnSessionId: "s1",
      hostVersion: "1.2.3",
      incompatibility: null,
    });
    kernel.reportCompatVerdict({
      hostId: "H",
      probedOnSessionId: "s1",
      hostVersion: "1.2.3",
      incompatibility: {
        code: "protocol-major-behind",
        hostVersion: "1.2.3",
        minSupportedVersion: "2.0.0",
      },
    });

    expect(client.reportEvidenceCalls).toEqual([
      {
        kind: "compat",
        hostId: "H",
        probedOnSessionId: "s1",
        hostVersion: "1.2.3",
        verdict: "compatible",
        incompatibility: null,
        at: 7,
      },
      {
        kind: "compat",
        hostId: "H",
        probedOnSessionId: "s1",
        hostVersion: "1.2.3",
        verdict: "incompatible",
        incompatibility: {
          code: "protocol-major-behind",
          hostVersion: "1.2.3",
          minSupportedVersion: "2.0.0",
        },
        at: 7,
      },
    ]);
  });
});

describe("SelectionEvidenceKernel - reattach", () => {
  it("re-attaches carrying the current inventory on reattachRequired", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });
    await kernel.start();

    kernel.sessionEstablished("H", "s1", "local-ws");
    const attachCallsBefore = client.attachCalls.length;

    client.emitReattach({ revision: 1 });

    expect(client.attachCalls.length).toBe(attachCallsBefore + 1);
    expect(client.attachCalls[client.attachCalls.length - 1]?.liveSessions).toEqual([
      { hostId: "H", sessionId: "s1", transportKind: "local-ws" },
    ]);
  });
});

describe("SelectionEvidenceKernel - render surface", () => {
  it("selection and leases events update snapshot() and fire onChange", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve(okAttach(0));
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });
    const changes: SelectionKernelSnapshot[] = [];
    kernel.onChange((snapshot) => changes.push(snapshot));
    await kernel.start();
    expect(kernel.snapshot().attached).toBe(true);

    client.emitSelection({
      revision: 1,
      change: {
        preferredHostId: null,
        targetHostId: "H",
        effectiveHostId: "H",
        previousEffectiveHostId: null,
        cause: "failover",
      },
    });
    expect(kernel.snapshot().targetHostId).toBe("H");
    expect(kernel.snapshot().effectiveHostId).toBe("H");

    client.emitLeases({ revision: 2, change: [{ hostId: "H", status: "ready", dead: null }] });
    expect(kernel.snapshot().leases).toEqual([{ hostId: "H", status: "ready", dead: null }]);

    expect(changes.length).toBeGreaterThan(0);
  });

  it("a failed attach leaves attached:false and does not retry", async () => {
    const client = new FakeAuthorityClient();
    client.attachImpl = () => Promise.resolve({ ok: false, kind: "superseded" });
    const kernel = new SelectionEvidenceKernel({ client, now: () => 0, log: silentAuthorityLog });
    await kernel.start();

    expect(kernel.snapshot().attached).toBe(false);
    expect(client.attachCalls.length).toBe(1);
  });
});
