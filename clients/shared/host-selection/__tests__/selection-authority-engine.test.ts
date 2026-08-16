import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type AuthorityIdentitySource,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type LocalHostOutageSignal,
  type SelectionAttachRequest,
  type SelectionEvidenceReport,
  type SelectionIncompatibility,
} from "../selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  LOCAL_EXPECTED_OUTAGE_CEILING_MS,
  RESTART_INTENT_EPISODE_MS,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  isUsableForSelection,
  silentAuthorityLog,
} from "../selection-authority-engine";
import {
  InMemoryHostFleetSource,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "../in-process-selection-authority";
import {
  createFakeAuthorityClock,
  createTestAuthority,
  fleetHost,
  findLease,
  recordEngineEvents,
} from "./selection-authority-harness";

// ---------------------------------------------------------------- builders

function attachRequest(
  seq: number,
  liveSessions: readonly LiveSessionAnnouncement[],
): SelectionAttachRequest {
  return {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions,
  };
}

function liveSession(hostId: string, sessionId: string): LiveSessionAnnouncement {
  return { hostId, sessionId, transportKind: "remote-relay" };
}

function dialOutcome(
  hostId: string,
  attemptId: string,
  outcome: "success" | "timeout" | "indeterminate",
  at: number,
): SelectionEvidenceReport {
  return { kind: "dial", hostId, attemptId, outcome, transportKind: "remote-relay", at };
}

function dialRefusal(
  hostId: string,
  attemptId: string,
  refusalDetail: "plan-restricted" | null,
  at: number,
): SelectionEvidenceReport {
  return {
    kind: "dial",
    hostId,
    attemptId,
    outcome: "confirmed-refusal",
    refusalDetail,
    transportKind: "remote-relay",
    at,
  };
}

function sessionEvidence(
  hostId: string,
  sessionId: string,
  transition: "established" | "lost",
  at: number,
): SelectionEvidenceReport {
  return { kind: "session", hostId, sessionId, transition, transportKind: "remote-relay", at };
}

function compatCompatible(
  hostId: string,
  probedOnSessionId: string | null,
): SelectionEvidenceReport {
  return {
    kind: "compat",
    hostId,
    probedOnSessionId,
    hostVersion: null,
    verdict: "compatible",
    incompatibility: null,
    at: 0,
  };
}

function compatIncompatible(
  hostId: string,
  probedOnSessionId: string | null,
  detail: SelectionIncompatibility,
): SelectionEvidenceReport {
  return {
    kind: "compat",
    hostId,
    probedOnSessionId,
    hostVersion: null,
    verdict: "incompatible",
    incompatibility: detail,
    at: 0,
  };
}

function restartIntent(
  hostId: string,
  tombstoneId: string,
  expiresAt: number | null,
  at: number,
): SelectionEvidenceReport {
  return { kind: "restart-intent", hostId, tombstoneId, expiresAt, at };
}

const INCOMPAT_DETAIL: SelectionIncompatibility = {
  code: "protocol-major-behind",
  hostVersion: "1.0.0",
  minSupportedVersion: "2.0.0",
};

const EMPTY_FLEET_SEED = { identityGeneration: 0, localHostId: null, hosts: [] };

// -------------------------------------------------------------------- tests

describe("SelectionAuthorityEngineImpl - attach fence", () => {
  it("allocateAttachSeq advances the supersession fence: an earlier issued seq is superseded and state-neutral", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const seq2 = engine.allocateAttachSeq("R1");
    const revisionBefore = engine.snapshot().revision;

    const staleResult = engine.attach("R1", attachRequest(seq1, []));
    expect(staleResult).toEqual({ ok: false, kind: "superseded" });
    expect(engine.snapshot().revision).toBe(revisionBefore);

    const freshResult = engine.attach("R1", attachRequest(seq2, []));
    expect(freshResult.ok).toBe(true);

    authority.dispose();
  });

  it("attach-once: a second attach with the same seq is superseded", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq = engine.allocateAttachSeq("R1");
    const first = engine.attach("R1", attachRequest(seq, []));
    expect(first.ok).toBe(true);

    const second = engine.attach("R1", attachRequest(seq, []));
    expect(second).toEqual({ ok: false, kind: "superseded" });

    authority.dispose();
  });

  it("version mismatch retires the previous attachment and consumes the seq; a replay of the same seq is superseded", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const attach1 = engine.attach("R1", attachRequest(seq1, [liveSession("H", "s1")]));
    expect(attach1.ok).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    const seq2 = engine.allocateAttachSeq("R1");
    const mismatch = engine.attach("R1", {
      attachSeq: seq2,
      callerContractVersion: 99,
      liveSessions: [],
    });
    expect(mismatch).toEqual({
      ok: false,
      kind: "version-mismatch",
      authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
      callerVersion: 99,
    });
    // The previous attachment (seq1's live session) is retired atomically.
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const replay = engine.attach("R1", attachRequest(seq2, []));
    expect(replay).toEqual({ ok: false, kind: "superseded" });

    authority.dispose();
  });

  it("refuseMalformedAttach claims the latest-unconsumed seq and retires the previous attachment; a stale or already-consumed seq is state-neutral", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const attach1 = engine.attach("R1", attachRequest(seq1, [liveSession("H", "s1")]));
    expect(attach1.ok).toBe(true);

    const seq2 = engine.allocateAttachSeq("R1");
    const revisionBefore = engine.snapshot().revision;

    // seq1 is stale now: state-neutral.
    const staleClaim = engine.refuseMalformedAttach("R1", seq1);
    expect(staleClaim).toBe(false);
    expect(engine.snapshot().revision).toBe(revisionBefore);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // seq2 is the latest unconsumed issuance: claims and retires the live attachment.
    const freshClaim = engine.refuseMalformedAttach("R1", seq2);
    expect(freshClaim).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // seq2 is now consumed: a replay is state-neutral.
    const revisionAfterClaim = engine.snapshot().revision;
    const replayClaim = engine.refuseMalformedAttach("R1", seq2);
    expect(replayClaim).toBe(false);
    expect(engine.snapshot().revision).toBe(revisionAfterClaim);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - SEAM: late attach and handover races", () => {
  it("a late-attaching window receives the full current snapshot, including a host that already died", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach A to succeed");
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", `attempt-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected attach B to succeed");
    expect(findLease(attachB.snapshot.leases, "H")?.status).toBe("dead");
    const maxEventRevision = Math.max(...events.map((event) => event.revision));
    expect(attachB.snapshot.revision).toBe(maxEventRevision);

    authority.dispose();
  });

  it("a stale attach retried after replacement is superseded while the surviving instance's session stays counted", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA1 = engine.allocateAttachSeq("A");
    const attachA1 = engine.attach("A", attachRequest(seqA1, [liveSession("H", "sA")]));
    expect(attachA1.ok).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // A new load allocates but nobody has attached with it yet.
    engine.allocateAttachSeq("A");

    // The OLD instance retries its now-superseded seq.
    const retry = engine.attach("A", attachRequest(seqA1, []));
    expect(retry).toEqual({ ok: false, kind: "superseded" });
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    authority.dispose();
  });

  it("attach with surviving sockets never opens an empty-session window that concurrent refusals could count against", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;

    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "sA")]));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // A new load re-attaches announcing the same live session.
    const seqA2 = engine.allocateAttachSeq("A");
    const attachA2 = engine.attach("A", attachRequest(seqA2, [liveSession("H", "sA")]));
    if (!attachA2.ok) throw new Error("expected re-attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    for (let i = 0; i < 3; i += 1) {
      engine.ingestEvidence("A", attachA2.incarnationId, dialRefusal("H", `refusal-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // No emitted leases event ever showed H as anything but ready.
    for (const event of events) {
      if (event.kind !== "leases") continue;
      const lease = findLease(event.leases, "H");
      if (lease === undefined) continue;
      expect(lease.status).toBe("ready");
    }

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - death aggregation", () => {
  it("SEAM: two windows contributing one refusal each is the same evidence as one window contributing two", () => {
    const clock = createFakeAuthorityClock(0);
    const twoWindow = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const seqA = twoWindow.engine.allocateAttachSeq("A");
    const attachA = twoWindow.engine.attach("A", attachRequest(seqA, []));
    const seqB = twoWindow.engine.allocateAttachSeq("B");
    const attachB = twoWindow.engine.attach("B", attachRequest(seqB, []));
    if (!attachA.ok || !attachB.ok) throw new Error("expected both attaches to succeed");

    twoWindow.engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "a1", null, 0));
    twoWindow.engine.ingestEvidence("B", attachB.incarnationId, dialRefusal("H", "b1", null, 0));
    expect(findLease(twoWindow.engine.snapshot().leases, "H")?.status).not.toBe("dead");

    twoWindow.engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "a2", null, 0));
    expect(findLease(twoWindow.engine.snapshot().leases, "H")?.status).toBe("dead");
    twoWindow.dispose();

    const oneWindow = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock: createFakeAuthorityClock(0),
    });
    const seqC = oneWindow.engine.allocateAttachSeq("C");
    const attachC = oneWindow.engine.attach("C", attachRequest(seqC, []));
    if (!attachC.ok) throw new Error("expected attach to succeed");
    oneWindow.engine.ingestEvidence("C", attachC.incarnationId, dialRefusal("H", "c1", null, 0));
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).not.toBe("dead");
    oneWindow.engine.ingestEvidence("C", attachC.incarnationId, dialRefusal("H", "c2", null, 0));
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).not.toBe("dead");
    oneWindow.engine.ingestEvidence("C", attachC.incarnationId, dialRefusal("H", "c3", null, 0));
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).toBe("dead");
    oneWindow.dispose();
  });

  it("dial dedup counts the same attemptId once per incarnation, and again from a different incarnation", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    for (let i = 0; i < 5; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "dup", null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    const seqA2 = engine.allocateAttachSeq("A");
    const attachA2 = engine.attach("A", attachRequest(seqA2, []));
    if (!attachA2.ok) throw new Error("expected re-attach to succeed");
    engine.ingestEvidence("A", attachA2.incarnationId, dialRefusal("H", "dup", null, 0));
    engine.ingestEvidence("A", attachA2.incarnationId, dialRefusal("H", "other", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("success clears the refusal streak; indeterminate never advances it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "r1", null, 0));
    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "r2", null, 0));
    engine.ingestEvidence("A", attachA.incarnationId, dialOutcome("H", "success-1", "success", 0));

    for (let i = 0; i < 10; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialOutcome("H", `indeterminate-${i}`, "indeterminate", 0),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    authority.dispose();
  });

  it("a live session suppresses refusal accumulation; the streak reaches death normally once the session is lost", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    for (let i = 0; i < 5; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", `suppressed-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "lost", 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "fresh-1", null, 0));
    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "fresh-2", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");
    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", "fresh-3", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("plan-restricted provenance: only comes from a confirmed refusal carrying it; null-detail is offline; last-counted refusal wins", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H1", "remote"), fleetHost("H2", "remote"), fleetHost("H3", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H1", `plan-${i}`, "plan-restricted", i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H1")?.dead).toEqual({ reason: "plan-restricted" });

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H2", `off-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H2")?.dead).toEqual({ reason: "offline" });

    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H3", "mix-1", "plan-restricted", 0));
    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H3", "mix-2", "plan-restricted", 0));
    engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H3", "mix-3", null, 0));
    expect(findLease(engine.snapshot().leases, "H3")?.dead).toEqual({ reason: "offline" });

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - session pairing", () => {
  it("session transitions are idempotent: duplicate established/lost are no-ops, lost-before-established tombstones, a stale incarnation is dropped", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "established", 0));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "established", 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "lost", 0));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "lost", 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // lost before established: the id is tombstoned, the later established never lands.
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s2", "lost", 0));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s2", "established", 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // a transition stamped with a stale incarnation is dropped.
    const seqA2 = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA2, []));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s3", "established", 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - SEAM: cloud-DTO flip has no channel to a lease", () => {
  it("republishing an identical fleet membership never changes a lease, connecting and dead arms", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet } = authority;

    const revisionBefore = engine.snapshot().revision;
    const leaseEventsBefore = events.filter((event) => event.kind === "leases").length;
    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(engine.snapshot().revision).toBe(revisionBefore);
    expect(events.filter((event) => event.kind === "leases").length).toBe(leaseEventsBefore);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", `d-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    const revisionAfterDeath = engine.snapshot().revision;
    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(engine.snapshot().revision).toBe(revisionAfterDeath);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - compat freshness", () => {
  it("compat freshness is anchored to session observation order: a later session's verdict recovers the lease, and a delayed verdict re-anchored to the older session is dropped", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // s1's ordinal is assigned now, on first observation.
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "established", 0));
    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H", "s1", INCOMPAT_DETAIL));
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe("incompatible");

    // s1 is lost; s2 is observed for the first time now, so its ordinal is
    // strictly later than s1's - a legitimate downgrade / same-version
    // restart case, not a version-string comparison.
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "lost", 0));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s2", "established", 0));
    engine.ingestEvidence("A", attachA.incarnationId, compatCompatible("H", "s2"));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // A delayed verdict still anchored to s1 arrives after: its rank is
    // strictly below s2's, so it is dropped - the lease stays usable.
    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H", "s1", INCOMPAT_DETAIL));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("a null-anchored verdict never displaces a session-anchored one; null-vs-null latest wins", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H1", "remote"), fleetHost("H2", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H1", "s1", "established", 0));
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H1", "s1", "lost", 0));
    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H1", "s1", INCOMPAT_DETAIL));
    engine.ingestEvidence("A", attachA.incarnationId, compatCompatible("H1", null));
    expect(findLease(engine.snapshot().leases, "H1")?.dead?.reason).toBe("incompatible");

    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H2", null, INCOMPAT_DETAIL));
    engine.ingestEvidence("A", attachA.incarnationId, compatCompatible("H2", null));
    expect(findLease(engine.snapshot().leases, "H2")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("compat evidence for a host clears on fleet removal", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H", null, INCOMPAT_DETAIL));
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe("incompatible");

    fleet.publish(0, null, []);
    expect(findLease(engine.snapshot().leases, "H")).toBeUndefined();

    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    authority.dispose();
  });

  it("an incompatible verdict outranks a live session", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H", null, INCOMPAT_DETAIL));
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe("incompatible");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - restart-intent episodes", () => {
  it("a tombstone opens a restarting-expected hold that refusals cannot escape, and lapses on the engine's own deadline", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("restarting-expected");

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("H", `during-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("restarting-expected");

    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("restarting-expected");
    // The streak crossed the threshold while held; the deadline firing with no
    // new evidence is what surfaces it.
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("SEAM: a tombstone replay after the episode has lapsed opens no new episode", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, 0));
    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("restarting-expected");

    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("restarting-expected");

    authority.dispose();
  });

  it("a duplicate tombstone from another window mid-episode does not extend it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachA.ok || !attachB.ok) throw new Error("expected both attaches to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, 0));
    clock.advance(RESTART_INTENT_EPISODE_MS / 2);
    engine.ingestEvidence("B", attachB.incarnationId, restartIntent("H", "tomb-1", null, 0));
    clock.advance(RESTART_INTENT_EPISODE_MS / 2 + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("restarting-expected");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - local outage signal", () => {
  it("holds the local host's lease in restarting-expected while the signal is true, and the ceiling caps it", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "local-1",
      hosts: [fleetHost("local-1", "local")],
    });
    const identity = { current: () => ({ identityKey: "acct-1", generation: 0 }), onChanged: () => ({ dispose: () => undefined }) };
    let outageState = false;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe("restarting-expected");

    outageState = false;
    for (const listener of Array.from(outageListeners)) listener(false);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe("restarting-expected");

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe("restarting-expected");

    clock.advance(LOCAL_EXPECTED_OUTAGE_CEILING_MS + 1);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe("restarting-expected");

    engine.dispose();
  });
});

describe("isUsableForSelection", () => {
  it("is false for every dead reason and restarting-expected, true for ready/degraded/connecting", () => {
    const usable: HostLeaseSnapshot = { hostId: "h", status: "connecting", dead: null };
    const ready: HostLeaseSnapshot = { hostId: "h", status: "ready", dead: null };
    const degraded: HostLeaseSnapshot = { hostId: "h", status: "degraded", dead: null };
    const restarting: HostLeaseSnapshot = { hostId: "h", status: "restarting-expected", dead: null };
    const deadOffline: HostLeaseSnapshot = { hostId: "h", status: "dead", dead: { reason: "offline" } };
    const deadPlanRestricted: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "plan-restricted" },
    };
    const deadRemoved: HostLeaseSnapshot = { hostId: "h", status: "dead", dead: { reason: "removed" } };
    const deadIncompatible: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: INCOMPAT_DETAIL },
    };

    expect(isUsableForSelection(usable)).toBe(true);
    expect(isUsableForSelection(ready)).toBe(true);
    expect(isUsableForSelection(degraded)).toBe(true);
    expect(isUsableForSelection(restarting)).toBe(false);
    expect(isUsableForSelection(deadOffline)).toBe(false);
    expect(isUsableForSelection(deadPlanRestricted)).toBe(false);
    expect(isUsableForSelection(deadRemoved)).toBe(false);
    expect(isUsableForSelection(deadIncompatible)).toBe(false);
  });
});

describe("SelectionAuthorityEngineImpl - identity transitions", () => {
  it("SEAM: account A to sign-out to account B wipes evidence, voids every incarnation, orders reattachRequired after the commit, and rejects a late same-generation fleet completion", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost("H", "remote"), fleetHost("H2", "remote")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    const oldIncarnation = attachA.incarnationId;

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", oldIncarnation, dialRefusal("H2", `dead-${i}`, null, i));
    }
    expect(findLease(engine.snapshot().leases, "H2")?.status).toBe("dead");
    engine.ingestEvidence("A", oldIncarnation, restartIntent("H2", "tomb-x", null, 0));

    // The new-generation fleet is already available by the time the identity
    // transition runs, so it is adopted as part of the SAME transaction.
    fleet.publish(1, null, [fleetHost("H", "remote"), fleetHost("H2", "remote")]);

    const eventsBeforeTransition = events.length;
    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners)) listener(identityState);

    const transitionEvents = events.slice(eventsBeforeTransition);
    expect(transitionEvents.length).toBeGreaterThan(0);
    const reattachEvent = transitionEvents[transitionEvents.length - 1];
    expect(reattachEvent.kind).toBe("reattach");
    for (const event of transitionEvents.slice(0, -1)) {
      expect(event.revision).toBeLessThan(reattachEvent.revision);
    }

    // (a) evidence is gone: H2, which was dead, comes back as ordinary connecting.
    expect(findLease(engine.snapshot().leases, "H2")?.status).toBe("connecting");

    // (c) every incarnation is void.
    engine.ingestEvidence("A", oldIncarnation, dialRefusal("H", "post-transition", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");
    expect(await engine.activate("A", oldIncarnation, "H")).toEqual({
      ok: false,
      reason: "not-attached",
    });

    // (d) a late fleet completion stamped with the OLD generation is rejected.
    const revisionBeforeLateFleet = engine.snapshot().revision;
    fleet.publish(0, null, [fleetHost("H", "remote"), fleetHost("H2", "remote")]);
    expect(engine.snapshot().revision).toBe(revisionBeforeLateFleet);

    // (e) the generation-1 snapshot published before the transition is in effect.
    expect(findLease(engine.snapshot().leases, "H")).toBeDefined();
    expect(findLease(engine.snapshot().leases, "H2")).toBeDefined();

    engine.dispose();
  });

  it("identity callbacks are accepted monotonically: a callback whose generation is not greater than current is ignored", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost("H", "remote")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);

    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners)) listener(identityState);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);
    const revisionAfterTransition = engine.snapshot().revision;

    // Same generation replayed (coalesced callback): ignored.
    for (const listener of Array.from(identityListeners)) {
      listener({ identityKey: "acct-B", generation: 1 });
    }
    expect(engine.snapshot().revision).toBe(revisionAfterTransition);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);

    // An older generation replayed: also ignored.
    for (const listener of Array.from(identityListeners)) {
      listener({ identityKey: "acct-A", generation: 0 });
    }
    expect(engine.snapshot().revision).toBe(revisionAfterTransition);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);

    engine.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - revision discipline", () => {
  it("revisions across a scenario driving every event kind are strictly increasing, unique, and consecutive within one transaction", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet, identity } = authority;

    // A fleet-shift that moves both the selection (target appears) and the
    // leases (a host appears) in one transaction: consecutive revisions.
    fleet.publish(0, "L", [fleetHost("L", "local")]);
    const afterFleetShift = events.length;
    expect(events[afterFleetShift - 2].kind).toBe("selection");
    expect(events[afterFleetShift - 1].kind).toBe("leases");
    expect(events[afterFleetShift - 1].revision).toBe(events[afterFleetShift - 2].revision + 1);

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, [liveSession("L", "s1")]));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("L", "s1", "lost", 0));
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence("A", attachA.incarnationId, dialRefusal("L", `d-${i}`, null, i));
    }
    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("L", "tomb-1", null, 0));
    identity.set("acct-2");

    const revisions = events.map((event) => event.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - realistic redial cadence", () => {
  it("SEAM: confirms death within the target window using a realistic redial cadence", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "lost", clock.now()));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const cadenceMs = [1000, 2000, 4000];
    let elapsed = 0;
    for (const delay of cadenceMs) {
      clock.advance(delay);
      elapsed += delay;
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `redial-${elapsed}`, null, clock.now()),
      );
    }

    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");
    expect(elapsed).toBeLessThanOrEqual(10_000);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - reporter detach", () => {
  it("drops the reporter's sessions but keeps the supersession fence", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.reporterDetached("A");
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const replay = engine.attach("A", attachRequest(seqA, []));
    expect(replay).toEqual({ ok: false, kind: "superseded" });

    const seqA2 = engine.allocateAttachSeq("A");
    const fresh = engine.attach("A", attachRequest(seqA2, []));
    expect(fresh.ok).toBe(true);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - activate (P1.2 interim)", () => {
  it("a stale incarnation answers not-attached; a live incarnation answers unrecognized", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    const stale = await engine.activate("A", "some-other-incarnation", "H");
    expect(stale).toEqual({ ok: false, reason: "not-attached" });

    const live = await engine.activate("A", attachA.incarnationId, "H");
    expect(live).toEqual({ ok: false, reason: "unrecognized" });

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - fleet shift", () => {
  it("a fleet snapshot whose localHostId appears emits selectionChanged with cause fleet-shift, targeting the local host", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { events, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local")]);

    const selectionEvents = events.filter((event) => event.kind === "selection");
    const last = selectionEvents[selectionEvents.length - 1];
    if (last.kind !== "selection") throw new Error("expected a selection event");
    expect(last.change.cause).toBe("fleet-shift");
    expect(last.change.targetHostId).toBe("L");
    expect(last.change.effectiveHostId).toBeNull();

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - listener isolation", () => {
  it("a listener that throws does not stop delivery to other listeners", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [],
    });
    const identity = {
      current: () => ({ identityKey: "acct-1", generation: 0 }),
      onChanged: () => ({ dispose: () => undefined }),
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });

    let secondCalled = 0;
    engine.onSelectionChanged(() => {
      throw new Error("boom");
    });
    engine.onSelectionChanged(() => {
      secondCalled += 1;
    });

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(secondCalled).toBe(1);

    engine.dispose();
  });
});

// --------------------------------------------------- P1.1 fixup round (cold
// review blockers A1-A5) - see the module header's "re-entrancy" and
// "compat-rank" sections for the mechanisms these pin.

describe("SelectionAuthorityEngineImpl - A1: re-entrancy during attach", () => {
  it("seals attach's result BEFORE draining, so a listener-driven identity transition mints its reattachRequired at a revision ABOVE the sealed snapshot", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, identity, events } = authority;

    let leaseCallbackCount = 0;
    engine.onLeasesChanged(() => {
      leaseCallbackCount += 1;
      if (leaseCallbackCount === 1) {
        // A nested transaction, driven from inside the attach's own delivery:
        // an identity transition mid-drain.
        identity.set("acct-2");
      }
    });

    const seqA = engine.allocateAttachSeq("A");
    // The live session moves the leases slice too (H flips to ready), so the
    // attach's own transaction actually reaches the lease listener above.
    const result = engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    if (!result.ok) throw new Error("expected attach to succeed");

    const reattachEvent = events.find((event) => event.kind === "reattach");
    if (reattachEvent === undefined) {
      throw new Error("expected the nested identity transition to mint a reattachRequired");
    }
    expect(reattachEvent.revision).toBeGreaterThan(result.snapshot.revision);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A2: nested commit does not split a sibling pair", () => {
  it("a nested transaction triggered mid-delivery appends after the parent's selection/leases pair instead of splitting it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet, events } = authority;

    let selectionCallbackCount = 0;
    engine.onSelectionChanged(() => {
      selectionCallbackCount += 1;
      if (selectionCallbackCount === 1) {
        // A nested fleet-shift, driven from inside the parent's own delivery.
        fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("H2", "remote")]);
      }
    });

    const beforeCount = events.length;
    // Moves BOTH slices: the target appears (selection) and a host appears
    // (leases) - the parent's consecutive sibling pair.
    fleet.publish(0, "L", [fleetHost("L", "local")]);

    const transactionEvents = events.slice(beforeCount);
    expect(transactionEvents.length).toBeGreaterThanOrEqual(3);
    const [selectionEvent, leasesEvent, ...rest] = transactionEvents;
    expect(selectionEvent.kind).toBe("selection");
    expect(leasesEvent.kind).toBe("leases");
    // Consecutive: nothing from the nested transaction interleaved between them.
    expect(leasesEvent.revision).toBe(selectionEvent.revision + 1);
    for (const event of rest) {
      expect(event.revision).toBeGreaterThan(leasesEvent.revision);
    }

    // The full recorded sequence is strictly increasing with no duplicates.
    const revisions = events.map((event) => event.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A3: compat ranks are incarnation-scoped", () => {
  it("two windows that both call their session \"s1\" rank by the authority's own observation order, not a shared ordinal", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected A to attach");
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected B to attach");

    // A establishes its "s1" first; B's "s1" is observed later, so B's ordinal
    // is strictly newer even though the session ids collide.
    engine.ingestEvidence("A", attachA.incarnationId, sessionEvidence("H", "s1", "established", 0));
    engine.ingestEvidence("B", attachB.incarnationId, sessionEvidence("H", "s1", "established", 0));

    engine.ingestEvidence("B", attachB.incarnationId, compatCompatible("H", "s1"));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // A's older session reports incompatible on ITS "s1". If ranks were
    // shared by session id, this would tie (latest-received wins) and flip
    // B's live host to dead.
    engine.ingestEvidence("A", attachA.incarnationId, compatIncompatible("H", "s1", INCOMPAT_DETAIL));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A4: identity transition keeps an active local outage", () => {
  it("a deliberate local restart spanning a sign-out is not blindly cleared, and the ceiling still counts from the ORIGINAL start", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "local-1",
      hosts: [fleetHost("local-1", "local")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    let outageState = false;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe("restarting-expected");

    clock.advance(1000);

    // The new-generation fleet is already available by the time the identity
    // transition runs, so the local host is still a member afterwards. No new
    // outage edge fires.
    fleet.publish(1, "local-1", [fleetHost("local-1", "local")]);
    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners)) listener(identityState);

    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe("restarting-expected");

    // The ceiling counts from the ORIGINAL start (t=0), not from the
    // transition (t=1000): 1000ms elapsed already, so only CEILING - 1000
    // more is needed to lapse it.
    clock.advance(LOCAL_EXPECTED_OUTAGE_CEILING_MS - 1000 - 1);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe("restarting-expected");

    clock.advance(2);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe("restarting-expected");

    engine.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A5: tombstone seen-ids are pruned on fleet removal", () => {
  it("a replayed tombstoneId opens a NEW episode once the host has left and rejoined the fleet", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, 0));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("restarting-expected");

    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("restarting-expected");

    fleet.publish(0, null, []);
    expect(findLease(engine.snapshot().leases, "H")).toBeUndefined();

    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    // Same tombstoneId, replayed after the host rejoined: without pruning the
    // seen-id set on removal, this would be a no-op forever.
    engine.ingestEvidence("A", attachA.incarnationId, restartIntent("H", "tomb-1", null, clock.now()));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("restarting-expected");

    authority.dispose();
  });
});
