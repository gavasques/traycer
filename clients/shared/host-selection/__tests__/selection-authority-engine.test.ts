import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type AuthorityIdentitySource,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type LocalHostEnsurePort,
  type LocalHostOutageSignal,
  type SelectionAttachRequest,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionIncompatibility,
} from "../selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  SESSION_ORDINAL_WINDOW,
  FAILOVER_CANDIDATE_STABILITY_MS,
  LOCAL_ENSURE_RETRY_COOLDOWN_MS,
  LOCAL_EXPECTED_OUTAGE_CEILING_MS,
  RESTART_INTENT_EPISODE_MS,
  RETURN_TO_TARGET_STABILITY_MS,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  isUsableForSelection,
  silentAuthorityLog,
  type PreferredHostSaveResult,
  type PreferredHostStore,
} from "../selection-authority-engine";
import {
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "../in-process-selection-authority";
import {
  createFakeAuthorityClock,
  createTestAuthority,
  fleetHost,
  findLease,
  recordEngineEvents,
  type RecordedEngineEvent,
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

describe("SelectionAuthorityEngineImpl - bounded per-incarnation state", () => {
  it("evicting session ordinals never promotes a stale verdict: an anchor for a session the reporter no longer holds ranks at the floor, not as the newest", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // An ancient session, long since gone, that carried an incompatible
    // verdict at the time.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "ancient", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "ancient", "lost", 0),
    );

    // Push its ordinal out of the window.
    for (let i = 0; i < SESSION_ORDINAL_WINDOW + 1; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        sessionEvidence("H", `churn-${i}`, "established", 0),
      );
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        sessionEvidence("H", `churn-${i}`, "lost", 0),
      );
    }

    // The live session, and a compatible verdict probed on it.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "current", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatCompatible("H", "current"),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // The delayed incompatible verdict for the EVICTED session must not win.
    // Before the floor rule, an unknown anchor was minted as the newest
    // ordinal, so eviction alone would have flipped this lease to dead.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", "ancient", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("dial dedup still collapses duplicates inside the retained window", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // One attempt, delivered many times: still one count, so the streak
    // cannot reach the threshold.
    for (let i = 0; i < 10; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", "duplicated", null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

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
      preferredStore: new InMemoryPreferredHostStore(),
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
      preferredStore: new InMemoryPreferredHostStore(),
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
      preferredStore: new InMemoryPreferredHostStore(),
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

describe("SelectionAuthorityEngineImpl - activate (P1.2)", () => {
  it("refuses a stale incarnation and an unknown host, and accepts a fleet host by writing preferred + emitting cause activate", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", "some-other-incarnation", "H")).toEqual({
      ok: false,
      reason: "not-attached",
    });
    // F14: a directory-validated write refuses an id the fleet does not hold,
    // so no path can re-assert a deregistered host.
    expect(await engine.activate("A", attachA.incarnationId, "ghost")).toEqual({
      ok: false,
      reason: "unknown-host",
    });

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(engine.snapshot().preferredHostId).toBe("H");
    // Persisted under the signed-in identity, and re-derivation has already
    // been emitted by the time `ok: true` resolves.
    expect(preferredStore.load("acct-1")).toBe("H");
    const selectionEvents = events.filter((event) => event.kind === "selection");
    const last = selectionEvents[selectionEvents.length - 1];
    if (last === undefined || last.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(last.change.cause).toBe("activate");
    expect(last.change.preferredHostId).toBe("H");
    expect(last.change.effectiveHostId).toBe("H");

    authority.dispose();
  });

  it("refuses a host whose current compat verdict is incompatible (D13)", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: false,
      reason: "incompatible",
    });
    expect(engine.snapshot().preferredHostId).toBeNull();

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
    // Derivation is real from P1.2: with no preference, the usable local host
    // is both the target (M5) and the effective host.
    expect(last.change.effectiveHostId).toBe("L");

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
      preferredStore: new InMemoryPreferredHostStore(),
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
      preferredStore: new InMemoryPreferredHostStore(),
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

describe("SelectionAuthorityEngineImpl - closure round: drain guard orders delivery across listeners", () => {
  it("every listener receives revision N before ANY listener receives revision N+1, even when listener 1 re-enters synchronously", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [fleetHost("H1", "remote")] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;

    const delivered: Array<{ listenerIndex: number; revision: number }> = [];
    let reentered = false;
    // Listener 1 re-enters the engine mid-delivery by publishing a fleet
    // snapshot, which stages a second leasesChanged event. The drain guard
    // (`if (this.draining) return;`) is what stops that nested transaction
    // from being delivered inline, ahead of listener 2 seeing the first one.
    engine.onLeasesChanged((event) => {
      delivered.push({ listenerIndex: 0, revision: event.revision });
      if (!reentered) {
        reentered = true;
        fleet.publish(0, null, [
          fleetHost("H1", "remote"),
          fleetHost("H2", "remote"),
          fleetHost("H3", "remote"),
        ]);
      }
    });
    engine.onLeasesChanged((event) => {
      delivered.push({ listenerIndex: 1, revision: event.revision });
    });

    fleet.publish(0, null, [fleetHost("H1", "remote"), fleetHost("H2", "remote")]);

    expect(delivered.length).toBe(4);
    const firstRevision = delivered[0].revision;
    const secondRevision = delivered[2].revision;
    expect(secondRevision).toBeGreaterThan(firstRevision);
    expect(delivered).toEqual([
      { listenerIndex: 0, revision: firstRevision },
      { listenerIndex: 1, revision: firstRevision },
      { listenerIndex: 0, revision: secondRevision },
      { listenerIndex: 1, revision: secondRevision },
    ]);

    authority.dispose();
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

// ------------------------------------------------------- P1.2 owed pins
// (host-lifecycle redesign, ticket P1.2 test brief - each pins a real engine
// behavior that had no test that would catch a regression).

describe("SelectionAuthorityEngineImpl - derivation precedence (P1.2)", () => {
  it("a usable preferred host outranks a usable local host: effective is the preferred host", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // L has no evidence at all, so its lease is the default "connecting" -
    // usable by `isUsableForSelection` (only `dead` and `restarting-expected`
    // are excluded). Both P and L are therefore usable at the moment of
    // activation, which is what makes this a precedence test rather than a
    // "no other candidate" test.
    const localLease = findLease(engine.snapshot().leases, "L");
    if (localLease === undefined) throw new Error("expected a lease for L");
    expect(isUsableForSelection(localLease)).toBe(true);

    expect(await engine.activate("A", attachA.incarnationId, "P")).toEqual({
      ok: true,
    });

    expect(engine.snapshot().preferredHostId).toBe("P");
    expect(engine.snapshot().targetHostId).toBe("P");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // Still true after the activation - L was never made unusable, so this
    // pins ORDER (the preferred arm runs before the local arm), not merely
    // "local was unusable so preferred won by default".
    const localLeaseAfter = findLease(engine.snapshot().leases, "L");
    if (localLeaseAfter === undefined) throw new Error("expected a lease for L");
    expect(isUsableForSelection(localLeaseAfter)).toBe(true);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - F14 deregister-clear (P1.2)", () => {
  it("a non-empty fleet that omits the preferred host clears preferred and emits cause deregister-clear; an empty fleet does not clear", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(engine.snapshot().preferredHostId).toBe("H");

    // An EMPTY fleet must NOT clear the preference (module header: "no hosts"
    // is what this port publishes before its first genuine registry answer,
    // and while an identity transition is in flight).
    fleet.publish(0, null, []);
    expect(engine.snapshot().preferredHostId).toBe("H");
    expect(preferredStore.load("acct-1")).toBe("H");
    const selectionEvents = events.filter((event) => event.kind === "selection");
    const afterEmptyFleet = selectionEvents[selectionEvents.length - 1];
    if (afterEmptyFleet === undefined || afterEmptyFleet.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(afterEmptyFleet.change.cause).not.toBe("deregister-clear");

    // A NON-EMPTY fleet that omits the preferred host clears it and stamps
    // the cause deregister-clear.
    fleet.publish(0, null, [fleetHost("OTHER", "remote")]);
    expect(engine.snapshot().preferredHostId).toBeNull();
    expect(preferredStore.load("acct-1")).toBeNull();
    const afterDeregister = events
      .filter((event) => event.kind === "selection")
      .at(-1);
    if (afterDeregister === undefined || afterDeregister.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(afterDeregister.change.cause).toBe("deregister-clear");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - identity wipe (P1.2, G1)", () => {
  it("activating under identity A then transitioning to B empties A's preferred bucket and B inherits nothing", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-A",
      clock,
    });
    const { engine, identity, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(preferredStore.load("acct-A")).toBe("H");

    identity.set("acct-B");

    // A's bucket is wiped, not merely left behind - a shared machine must not
    // be able to read A's choice back out of the store later.
    expect(preferredStore.load("acct-A")).toBeNull();
    // B inherits nothing: no bucket was ever written for acct-B, and the
    // engine's own preferred is null immediately after the transition.
    expect(preferredStore.load("acct-B")).toBeNull();
    expect(engine.snapshot().preferredHostId).toBeNull();

    authority.dispose();
  });
});

// ------------------------------------------------------- P1.3 owed pins
// (host-lifecycle redesign, ticket P1.3 test brief).

function attachReporter(
  engine: SelectionAuthorityEngineImpl,
  reporterId: string,
): string {
  const seq = engine.allocateAttachSeq(reporterId);
  const attach = engine.attach(reporterId, attachRequest(seq, []));
  if (!attach.ok) throw new Error(`expected attach ${reporterId} to succeed`);
  return attach.incarnationId;
}

function killHostWithRefusals(
  engine: SelectionAuthorityEngineImpl,
  reporterId: string,
  incarnationId: string,
  hostId: string,
): void {
  for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
    engine.ingestEvidence(
      reporterId,
      incarnationId,
      dialRefusal(hostId, `${hostId}-kill-${i}`, null, i),
    );
  }
}

function lastSelectionChange(
  events: readonly { kind: string; change?: SelectionChange }[],
): SelectionChange {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "selection" && event.change !== undefined) {
      return event.change;
    }
  }
  throw new Error("expected a selection event");
}

interface DeferredEnsure {
  readonly port: LocalHostEnsurePort;
  readonly calls: { count: number };
  resolve(ok: boolean): Promise<void>;
}

function createDeferredEnsure(): DeferredEnsure {
  const calls = { count: 0 };
  const pending: Array<
    (value: { ok: true } | { ok: false; reason: string }) => void
  > = [];
  return {
    port: {
      ensureReady: () => {
        calls.count += 1;
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
    },
    calls,
    resolve: async (ok: boolean) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no pending ensure");
      resolve(ok ? { ok: true } : { ok: false, reason: "ensure-failed" });
      await Promise.resolve();
    },
  };
}

function assertEmptyIff(input: {
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly ensureUnavailableOrFailed: boolean;
}): void {
  const anyUsable = input.leases.some(isUsableForSelection);
  const isEmpty = input.effectiveHostId === null;
  const shouldBeEmpty = !anyUsable && input.ensureUnavailableOrFailed;
  expect(isEmpty).toBe(shouldBeEmpty);
  expect(shouldBeEmpty).toBe(isEmpty);
}

class ScriptedPreferredHostStore implements PreferredHostStore {
  private readonly byIdentity = new Map<string, string>();
  private failNextWrite = false;
  writeCount = 0;

  failNext(): void {
    this.failNextWrite = true;
  }

  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    return this.byIdentity.get(identityKey) ?? null;
  }

  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult {
    this.writeCount += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return { ok: false, reason: "disk-full" };
    }
    if (identityKey === null) return { ok: true };
    if (hostId === null) {
      this.byIdentity.delete(identityKey);
      return { ok: true };
    }
    this.byIdentity.set(identityKey, hostId);
    return { ok: true };
  }
}

describe("SelectionAuthorityEngineImpl - P1.3 failover scenarios", () => {
  it("A1: preferred remote dies → fallback immediately, no stability window", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    killHostWithRefusals(engine, "A", incarnation, "P");
    clock.advance(0);
    expect(findLease(engine.snapshot().leases, "P")?.status).toBe("dead");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(lastSelectionChange(authority.events).cause).toBe("failover");

    authority.dispose();
  });

  it("A2: preferred returns → home only after the 20s stability window, cause recovery", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("P", "revive", "success", clock.now()),
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    clock.advance(RETURN_TO_TARGET_STABILITY_MS - 1);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    clock.advance(1);
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(lastSelectionChange(authority.events).cause).toBe("recovery");

    authority.dispose();
  });

  it("A3: fallback restart while FailedOver → no third-host hop (M6)", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("P", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(findLease(engine.snapshot().leases, "C")?.status).toBe("connecting");

    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("L", "tomb-fallback", null, clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // Advance past BOTH stability windows (failover-candidate and
    // return-to-target) while the restart episode (60s) is still open. Once
    // damping alone would admit a hop, the HOLD rule is the only thing that
    // can still keep the window on L instead of jumping to the third usable
    // host C.
    expect(
      Math.max(FAILOVER_CANDIDATE_STABILITY_MS, RETURN_TO_TARGET_STABILITY_MS) + 5_000,
    ).toBeLessThan(RESTART_INTENT_EPISODE_MS);
    clock.advance(
      Math.max(FAILOVER_CANDIDATE_STABILITY_MS, RETURN_TO_TARGET_STABILITY_MS) + 5_000,
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    const afterRestart = authority.events.filter(
      (event) => event.kind === "selection",
    );
    for (const event of afterRestart) {
      if (event.kind !== "selection") continue;
      expect(event.change.effectiveHostId).not.toBe("C");
    }
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });

  it("A4: Activate mid-FailedOver → immediately OnTarget, cause activate, damping bypassed", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("P", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    expect(await engine.activate("A", incarnation, "C")).toEqual({ ok: true });
    clock.advance(0);
    expect(engine.snapshot().preferredHostId).toBe("C");
    expect(engine.snapshot().targetHostId).toBe("C");
    expect(engine.snapshot().effectiveHostId).toBe("C");
    expect(lastSelectionChange(authority.events).cause).toBe("activate");

    authority.dispose();
  });

  it("A5: deregister preferred → preferred null, target local, cause deregister-clear", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(engine.snapshot().preferredHostId).toBeNull();
    expect(engine.snapshot().targetHostId).toBe("L");
    expect(lastSelectionChange(authority.events).cause).toBe("deregister-clear");

    authority.dispose();
  });

  it("A6: healthy remote preferred does not ensure local; killing it requests ensure once", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
      seedPreferred: "P",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(engine.snapshot().preferredHostId).toBe("P");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    killHostWithRefusals(engine, "A", incarnation, "L");
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("dead");
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(ensure.calls.count).toBe(0);

    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(ensure.calls.count).toBe(1);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 empty-set unification", () => {
  it("no local host + all remotes dead → ∅ (ensure unavailable)", () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("R1", "remote"), fleetHost("R2", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "R1");
    killHostWithRefusals(authority.engine, "A", incarnation, "R2");

    const snapshot = authority.engine.snapshot();
    expect(snapshot.effectiveHostId).toBeNull();
    expect(ensure.calls.count).toBe(0);
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: true,
    });

    authority.dispose();
  });

  it("local dead + ensure in flight → NOT ∅ (local lease is connecting)", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");

    expect(ensure.calls.count).toBe(1);
    const snapshot = authority.engine.snapshot();
    expect(findLease(snapshot.leases, "L")?.status).toBe("connecting");
    expect(snapshot.effectiveHostId).toBe("L");
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: false,
    });

    authority.dispose();
  });

  it("local dead + ensure failed inside cooldown + remotes dead → ∅", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "R");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    await ensure.resolve(false);

    const snapshot = authority.engine.snapshot();
    expect(findLease(snapshot.leases, "L")?.status).toBe("dead");
    expect(snapshot.effectiveHostId).toBeNull();
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: true,
    });

    authority.dispose();
  });

  it("after ensure cooldown lapses, ensure is retried", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    await ensure.resolve(false);
    expect(ensure.calls.count).toBe(1);
    expect(authority.engine.snapshot().effectiveHostId).toBeNull();

    clock.advance(LOCAL_ENSURE_RETRY_COOLDOWN_MS);
    expect(ensure.calls.count).toBe(2);

    authority.dispose();
  });

  it("ensure succeeds → local becomes usable and is adopted", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    expect(ensure.calls.count).toBe(1);
    await ensure.resolve(true);

    // Pin the streak-clear as the ONLY explanation for usability: without
    // it, `stage()` would see local still `dead` after the commit and
    // re-request ensure, making the lease read `connecting` (also usable)
    // via a second in-flight call rather than via a proven-alive local.
    // A re-request here would defeat this assertion, not merely add noise.
    expect(ensure.calls.count).toBe(1);

    const snapshot = authority.engine.snapshot();
    const local = findLease(snapshot.leases, "L");
    if (local === undefined) throw new Error("expected local lease");
    expect(isUsableForSelection(local)).toBe(true);
    expect(snapshot.effectiveHostId).toBe("L");
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: false,
    });

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 same-effective Activate (C1 engine)", () => {
  it("Activate a third dead host while FailedOver emits selectionChanged with unchanged effective", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [
          fleetHost("A", "remote"),
          fleetHost("B", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;
    const incarnation = attachReporter(engine, "W");
    expect(await engine.activate("W", incarnation, "A")).toEqual({ ok: true });
    killHostWithRefusals(engine, "W", incarnation, "C");
    killHostWithRefusals(engine, "W", incarnation, "A");
    expect(engine.snapshot().effectiveHostId).toBe("B");
    expect(engine.snapshot().targetHostId).toBe("A");

    const previousEffective = engine.snapshot().effectiveHostId;
    const before = events.filter((event) => event.kind === "selection").length;
    expect(await engine.activate("W", incarnation, "C")).toEqual({ ok: true });
    const after = events.filter((event) => event.kind === "selection");
    expect(after.length).toBe(before + 1);
    const change = lastSelectionChange(after);
    expect(change.preferredHostId).toBe("C");
    expect(change.targetHostId).toBe("C");
    expect(change.effectiveHostId).toBe(previousEffective);
    expect(change.previousEffectiveHostId).toBe(previousEffective);
    expect(change.cause).toBe("activate");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 persist-failed activate (E1/E2 engine)", () => {
  it("E1: failed write → persist-failed, nothing committed or emitted", async () => {
    const clock = createFakeAuthorityClock(0);
    const store = new ScriptedPreferredHostStore();
    store.failNext();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      preferredStore: store,
    });
    const incarnation = attachReporter(authority.engine, "A");
    const before = authority.events.filter(
      (event) => event.kind === "selection",
    ).length;

    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: false,
      reason: "persist-failed",
    });
    expect(authority.engine.snapshot().preferredHostId).toBeNull();
    expect(store.load("acct-1")).toBeNull();
    expect(
      authority.events.filter((event) => event.kind === "selection").length,
    ).toBe(before);

    authority.dispose();
  });

  it("E2: failed write then retry with a succeeding write is durable", async () => {
    const clock = createFakeAuthorityClock(0);
    const store = new ScriptedPreferredHostStore();
    store.failNext();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      preferredStore: store,
    });
    const incarnation = attachReporter(authority.engine, "A");
    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: false,
      reason: "persist-failed",
    });
    expect(authority.engine.snapshot().preferredHostId).toBeNull();

    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: true,
    });
    expect(authority.engine.snapshot().preferredHostId).toBe("H");
    expect(store.load("acct-1")).toBe("H");
    expect(lastSelectionChange(authority.events).cause).toBe("activate");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 F14 clear on identity adopt (H)", () => {
  function buildTransitionPorts(input: {
    readonly bPreference: string;
    readonly bFleet: {
      readonly localHostId: string | null;
      readonly hosts: readonly { hostId: string; kind: "local" | "remote" }[];
    };
  }): {
    engine: SelectionAuthorityEngineImpl;
    events: readonly RecordedEngineEvent[];
    transition: () => void;
  } {
    const store = new InMemoryPreferredHostStore();
    store.save("acct-B", input.bPreference);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "L-A",
      hosts: [fleetHost("L-A", "local")],
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
      clock: createFakeAuthorityClock(0),
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: store,
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);
    fleet.publish(1, input.bFleet.localHostId, input.bFleet.hosts);
    return {
      engine,
      events,
      transition: () => {
        identityState = { identityKey: "acct-B", generation: 1 };
        for (const listener of Array.from(identityListeners)) {
          listener(identityState);
        }
      },
    };
  }

  it("H1: already-available B fleet that omits B's persisted preference clears it as deregister-clear", () => {
    const ports = buildTransitionPorts({
      bPreference: "GONE",
      bFleet: {
        localHostId: "L-B",
        hosts: [fleetHost("L-B", "local"), fleetHost("OTHER", "remote")],
      },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBeNull();
    expect(ports.engine.snapshot().targetHostId).toBe("L-B");
    expect(lastSelectionChange(ports.events).cause).toBe("deregister-clear");
    ports.engine.dispose();
  });

  it("H2: already-available B fleet that still holds B's preference keeps it, cause fleet-shift", () => {
    const ports = buildTransitionPorts({
      bPreference: "L-B",
      bFleet: {
        localHostId: "L-B",
        hosts: [fleetHost("L-B", "local"), fleetHost("OTHER", "remote")],
      },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBe("L-B");
    expect(ports.engine.snapshot().targetHostId).toBe("L-B");
    expect(lastSelectionChange(ports.events).cause).toBe("fleet-shift");
    ports.engine.dispose();
  });

  it("H3: an empty already-available fleet never clears the persisted preference", () => {
    const ports = buildTransitionPorts({
      bPreference: "GONE",
      bFleet: { localHostId: null, hosts: [] },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBe("GONE");
    expect(lastSelectionChange(ports.events).cause).not.toBe("deregister-clear");
    ports.engine.dispose();
  });
});
