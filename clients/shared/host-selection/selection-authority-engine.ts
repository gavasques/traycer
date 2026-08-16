/**
 * The selection authority's engine (host-lifecycle redesign, D16 / P1.1) - the
 * per-app singleton that owns the connection-evidence kernel and broadcasts
 * the selection tuple plus per-host lease snapshots.
 *
 * The wire/type contract it implements is
 * `./selection-authority-contract.ts` (settled by the P1.0 design review,
 * revision 9); every rule cited as "module header rule N" or "mechanism N"
 * below lives there. This module is the transport-agnostic implementation:
 * plain TS, no Electron, no IPC, no DOM. Desktop mounts it in the main
 * process behind the IPC binding; browser/dev mounts it in the single window
 * behind the in-process adapter.
 *
 * ## What this ticket implements, and what it deliberately does not
 *
 * P1.1 lands the authority skeleton and the whole evidence kernel: attach
 * rotation and retirement, unique-revision emission, dial/session/compat/
 * restart-intent aggregation, lease derivation, identity transitions and the
 * fleet port's race rules. Three surfaces carry a NAMED interim backing until
 * their own ticket lands - each is marked `INTERIM BACKING` at its site:
 *
 *  - `preferredHostId` has no writer (P1.2 owns `activate`, persistence and
 *    identity scoping), so it is `null` for the engine's whole life here.
 *  - `effectiveHostId` is `null`: deriving it is the failover engine's job
 *    (P1.3 - candidate enumeration, damping, `LocalHostEnsurePort`).
 *  - `activate` refuses every well-formed request with `unrecognized` (P1.2).
 *
 * `targetHostId` is NOT interim: `preferred ?? localHostId` is the settled M5
 * rule and is implemented here, so the `fleet-shift` cause has a real
 * producer from day one (the local host id appearing at startup is the
 * contract's own example).
 *
 * ## Evidence hierarchy (invariant 5) is structural here
 *
 * The engine has no cloud-DTO input at all: {@link HostFleetSnapshot} carries
 * identity and membership, never a status word. A DTO flip therefore cannot
 * reach a lease verdict even by accident - the type system has no channel for
 * it. Death is only ever reached through
 * {@link CONFIRMED_DEATH_REFUSAL_STREAK} consecutive transport-confirmed
 * refusals/timeouts across THE APP's attempts, and any live session for a
 * host suppresses that accumulation entirely.
 */
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type ActivateResult,
  type AuthorityIdentitySource,
  type HostFleetSnapshot,
  type HostFleetSource,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type LocalHostEnsurePort,
  type LocalHostOutageSignal,
  type SelectionAttachRequest,
  type SelectionAttachResult,
  type SelectionAuthorityEngine,
  type SelectionAuthoritySnapshot,
  type SelectionChange,
  type SelectionChangeCause,
  type SelectionEvidenceReport,
  type SelectionIncompatibility,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
  type SelectionTransportKind,
} from "./selection-authority-contract";

/**
 * How many CONSECUTIVE transport-confirmed refusals/timeouts - counted across
 * every window's attempts, deduplicated per (incarnation, attemptId) - make a
 * host `dead` (connection registry §2).
 *
 * Three, not one: the registry's target is "confirmation within ~5-10 s of
 * real death, not one failed probe". The transports pace their own redials
 * (backoff), so three consecutive refusals land inside that window in
 * practice while a single unlucky refusal never does. There is deliberately
 * NO elapsed-time floor on top of the count: an app-wide streak is exactly
 * what the registry defines as evidence ("two windows each seeing one refusal
 * is the same evidence as one window seeing two"), and a time floor would
 * re-introduce a per-window notion of "too fast".
 */
export const CONFIRMED_DEATH_REFUSAL_STREAK = 3;

/**
 * The fixed window a restart-intent tombstone holds its host in
 * `restarting-expected` (connection registry §3, mechanism 7).
 *
 * The registry says to reuse the existing 60 s quiet / 15 min max host
 * budgets. The QUIET budget is the one that fits a tombstone episode:
 * duplicate observations never extend an episode (mechanism 7), so the
 * episode has no progress signal to keep extending against, and 60 s covers
 * the restart/apply cycle the exemption exists for (the download half of an
 * update happens with the host still up). When it lapses, ordinary evidence
 * resumes and a host that never came back reaches `dead` normally.
 */
export const RESTART_INTENT_EPISODE_MS = 60_000;

/**
 * The ceiling on the LOCAL expected-outage hold (D5's HostController mutation
 * lane, {@link LocalHostOutageSignal}).
 *
 * This arm does have a progress signal - the lane is in flight or it is not -
 * so it takes the MAX budget rather than the quiet one, and the cap exists
 * only so a lane that never reports completion cannot hold a lease forever.
 */
export const LOCAL_EXPECTED_OUTAGE_CEILING_MS = 15 * 60_000;

/**
 * The engine's own clock and timer source (mechanism 7: "authority deadlines
 * come from its own ceilings, never renderer or host clocks"). A composition
 * input, not wire surface - tests inject a fake.
 */
export interface AuthorityClock {
  now(): number;
  /** Returns a canceller; calling it twice is safe. */
  schedule(delayMs: number, run: () => void): () => void;
}

/** Real-time {@link AuthorityClock}. */
export const systemAuthorityClock: AuthorityClock = {
  now: () => Date.now(),
  schedule: (delayMs: number, run: () => void) => {
    const timer = setTimeout(run, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * Diagnostic sink. The engine never throws for bad input - a report that does
 * not belong to a live incarnation, a stale fleet snapshot, or a listener
 * that throws is logged and dropped.
 */
export interface AuthorityLog {
  debug(message: string, detail: Record<string, unknown>): void;
  warn(message: string, detail: Record<string, unknown>): void;
}

/** No-op {@link AuthorityLog} for tests and shells without a logger. */
export const silentAuthorityLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * Incarnation ids identify a client instance to the engine that minted them;
 * they never cross a trust boundary and are never persisted, so a process
 * -local counter is sufficient and keeps tests deterministic.
 */
export function createIncrementingIncarnationIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `incarnation-${counter}`;
  };
}

export interface SelectionAuthorityEngineOptions {
  readonly fleet: HostFleetSource;
  readonly identity: AuthorityIdentitySource;
  /**
   * The engine's one sanctioned process action (D14). Composed here so P1.3
   * can invoke it without re-plumbing; P1.1 never calls it.
   */
  readonly localHostEnsure: LocalHostEnsurePort;
  readonly localOutage: LocalHostOutageSignal;
  readonly clock: AuthorityClock;
  readonly newIncarnationId: () => string;
  readonly log: AuthorityLog;
}

/** One live transport session as the authority holds it. */
interface LiveSessionRecord {
  readonly hostId: string;
  readonly transportKind: SelectionTransportKind;
}

/**
 * One accepted attach. Everything scoped to a client INSTANCE lives here, so
 * retiring an attachment drops the instance's whole evidence footprint in one
 * step (mechanism 3).
 */
interface AttachmentRecord {
  readonly incarnationId: string;
  readonly attachSeq: number;
  readonly sessions: Map<string, LiveSessionRecord>;
  /**
   * `lost` observed before `established` for these ids: the session never
   * counts as live and the later `established` is dropped.
   */
  readonly tombstonedSessionIds: Set<string>;
  /** Dial dedup within the incarnation (mechanism 5). */
  readonly seenAttemptIds: Set<string>;
}

/**
 * Per-reporter attach generation state. `latestIssuedSeq` IS the supersession
 * fence (module header rule 4): allocation advances it, and only that seq -
 * while unconsumed - can be claimed.
 *
 * The fence survives retirement, identity transitions AND `reporterDetached`.
 * Surviving detach is not decoration: reporter ids are reused in practice
 * (the in-process adapter's constant id; the single-window bridge's
 * `"primary"`), so dropping the fence on detach would let a reload restart
 * the sequence and make a stale in-flight claim acceptable again.
 */
interface ReporterRecord {
  nextSeq: number;
  latestIssuedSeq: number;
  latestSeqConsumed: boolean;
  attachment: AttachmentRecord | null;
}

/** The freshest compat verdict for one host (mechanism 6). */
interface CompatRecord {
  readonly verdict: "compatible" | "incompatible";
  readonly incompatibility: SelectionIncompatibility | null;
  /**
   * The authority's own observation ordinal for `probedOnSessionId`, or -1
   * for a null-anchored (weakest) verdict. Version strings are never an
   * ordering key.
   */
  readonly rank: number;
}

/** Per-host aggregated evidence. Pruned when the host leaves the fleet. */
interface HostEvidence {
  refusalStreak: number;
  lastCountedRefusalDetail: "plan-restricted" | null;
  compat: CompatRecord | null;
  /** Authority-local deadline of the current tombstone episode, if any. */
  restartEpisodeEndsAt: number | null;
}

function emptyHostEvidence(): HostEvidence {
  return {
    refusalStreak: 0,
    lastCountedRefusalDetail: null,
    compat: null,
    restartEpisodeEndsAt: null,
  };
}

/** The selection tuple the engine currently holds. */
interface SelectionState {
  readonly preferredHostId: string | null;
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
}

const EMPTY_SELECTION: SelectionState = {
  preferredHostId: null,
  targetHostId: null,
  effectiveHostId: null,
};

/**
 * Generation sentinel for "the engine has not adopted an identity yet". Below
 * every real generation, so the first identity - whether it arrives from
 * `current()` or from a callback that raced it - is adopted as a SEED (no
 * wipe, no `reattachRequired`) rather than as a transition.
 */
const UNSET_IDENTITY_GENERATION = -1;

/**
 * The contract's `usable()` predicate (connection registry §4/§5, mechanism
 * 7, D13). Exported for P1.3's candidate enumeration and ∅ detection - it is
 * private to the AUTHORITY, never part of the client/IPC surface, so no
 * window can derive its own verdict from it.
 *
 * A host is usable when its lease is neither `dead` (which includes the
 * `incompatible` arm - C4: an incompatible host may hold a live socket and is
 * still never a candidate) nor `restarting-expected` (a HOLD, not
 * eligibility: the engine keeps pointing at a cycling host but must not newly
 * select one).
 */
export function isUsableForSelection(lease: HostLeaseSnapshot): boolean {
  return lease.status !== "dead" && lease.status !== "restarting-expected";
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}#${sessionId}`;
}

function attemptKey(incarnationId: string, attemptId: string): string {
  return `${incarnationId}#${attemptId}`;
}

function selectionEquals(a: SelectionState, b: SelectionState): boolean {
  return (
    a.preferredHostId === b.preferredHostId &&
    a.targetHostId === b.targetHostId &&
    a.effectiveHostId === b.effectiveHostId
  );
}

function leaseEquals(a: HostLeaseSnapshot, b: HostLeaseSnapshot): boolean {
  if (a.hostId !== b.hostId || a.status !== b.status) return false;
  if (a.dead === null || b.dead === null) return a.dead === b.dead;
  if (a.dead.reason !== b.dead.reason) return false;
  if (a.dead.reason !== "incompatible" || b.dead.reason !== "incompatible") {
    return true;
  }
  return (
    a.dead.detail.code === b.dead.detail.code &&
    a.dead.detail.hostVersion === b.dead.detail.hostVersion &&
    a.dead.detail.minSupportedVersion === b.dead.detail.minSupportedVersion
  );
}

function leasesEqual(
  a: readonly HostLeaseSnapshot[],
  b: readonly HostLeaseSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!leaseEquals(a[index], b[index])) return false;
  }
  return true;
}

/** The empty fleet an identity transition swaps to when no matching snapshot exists. */
function emptyFleet(identityGeneration: number): HostFleetSnapshot {
  return {
    revision: -1,
    identityGeneration,
    localHostId: null,
    hosts: [],
  };
}

/**
 * The per-app selection authority.
 *
 * Concurrency model: every method is synchronous and runs to completion on
 * one thread (Electron main, or the single window in browser/dev). "One
 * transaction" in the contract therefore means "one method call": state
 * mutates, then {@link SelectionAuthorityEngineImpl.commit} derives and emits.
 * Nothing interleaves between a parse and a guarded call, which is what makes
 * the attach claim race-free without a lock (module header rule 6).
 */
export class SelectionAuthorityEngineImpl implements SelectionAuthorityEngine {
  private readonly options: SelectionAuthorityEngineOptions;

  /**
   * The ONE revision counter (mechanism 1). Incremented per EMITTED event, so
   * no two events ever share a revision and one client high-water mark
   * totally orders all three event kinds. Process-lifetime monotonic: it
   * never resets, including across sign-out/account replacement.
   */
  private revision = 0;

  private selection: SelectionState = EMPTY_SELECTION;
  private leases: readonly HostLeaseSnapshot[] = [];

  private fleet: HostFleetSnapshot = emptyFleet(UNSET_IDENTITY_GENERATION);
  private appliedFleetRevision = Number.NEGATIVE_INFINITY;
  private identityKey: string | null = null;
  private identityGeneration = UNSET_IDENTITY_GENERATION;

  private readonly reporters = new Map<string, ReporterRecord>();
  private readonly evidence = new Map<string, HostEvidence>();
  /** (hostId, sessionId) -> the authority's own observation ordinal. */
  private readonly sessionOrdinals = new Map<string, number>();
  private nextSessionOrdinal = 0;
  /**
   * Every (hostId, tombstoneId) ever observed, retained for the authority
   * PROCESS LIFETIME (decision 9): pruned only on the host's fleet removal or
   * an identity transition. No eviction horizon exists, so no replay can
   * outlive one and re-open a closed episode.
   */
  private readonly seenTombstoneIds = new Map<string, Set<string>>();

  /** Start of the current local expected outage, or null when the lane is idle. */
  private localOutageStartedAt: number | null = null;
  private cancelDeadlineTimer: (() => void) | null = null;
  private scheduledDeadline: number | null = null;

  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<
    (event: SelectionReattachRequired) => void
  >();

  private readonly portSubscriptions: SelectionSubscription[] = [];
  private disposed = false;

  constructor(options: SelectionAuthorityEngineOptions) {
    this.options = options;

    // SUBSCRIBE BEFORE READ on both ports (mechanism 8, §3b): the callback
    // carries the new value itself, so a change landing between the
    // subscription and the read cannot be lost - the seed read is then
    // rejected as stale by the monotonic guards below.
    this.portSubscriptions.push(
      options.identity.onChanged((identity) => {
        this.applyIdentity(identity);
      }),
    );
    this.applyIdentity(options.identity.current());

    this.portSubscriptions.push(
      options.fleet.onChanged((snapshot) => {
        this.applyFleetSnapshot(snapshot);
      }),
    );
    this.applyFleetSnapshot(options.fleet.snapshot());

    this.portSubscriptions.push(
      options.localOutage.onChanged((inExpectedOutage) => {
        this.applyLocalOutage(inExpectedOutage);
      }),
    );
    this.applyLocalOutage(options.localOutage.inExpectedOutage());
  }

  // ---------------------------------------------------------------- attach

  allocateAttachSeq(reporterId: string): number {
    const record = this.reporterRecord(reporterId);
    record.nextSeq += 1;
    record.latestIssuedSeq = record.nextSeq;
    // ALLOCATION ADVANCES THE FENCE (module header rule 4): every older
    // generation's attach is superseded from this moment, whether or not the
    // new instance ever attaches. The CURRENT attachment is deliberately NOT
    // retired here - it keeps reporting until the new claim lands, which is
    // what makes the handover free of an empty-session window.
    record.latestSeqConsumed = false;
    return record.latestIssuedSeq;
  }

  attach(
    reporterId: string,
    request: SelectionAttachRequest,
  ): SelectionAttachResult {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null || !this.claimSeq(record, request.attachSeq)) {
      return { ok: false, kind: "superseded" };
    }
    // The claim is consumed; the previous attachment is retired inside the
    // same synchronous call, and (on success) replaced before anything is
    // emitted - so no observer ever sees the reporter session-less.
    record.attachment = null;
    if (
      request.callerContractVersion !== SELECTION_AUTHORITY_CONTRACT_VERSION
    ) {
      // Terminal for that renderer load: retired, seq consumed, no replay.
      this.commit("failover");
      return {
        ok: false,
        kind: "version-mismatch",
        authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
        callerVersion: request.callerContractVersion,
      };
    }
    const incarnationId = this.options.newIncarnationId();
    record.attachment = {
      incarnationId,
      attachSeq: request.attachSeq,
      sessions: this.inventoryFrom(request.liveSessions),
      tombstonedSessionIds: new Set<string>(),
      seenAttemptIds: new Set<string>(),
    };
    this.commit("failover");
    return { ok: true, incarnationId, snapshot: this.snapshot() };
  }

  refuseMalformedAttach(reporterId: string, attachSeq: number): boolean {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null || !this.claimSeq(record, attachSeq)) {
      return false;
    }
    record.attachment = null;
    this.commit("failover");
    return true;
  }

  reporterDetached(reporterId: string): void {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null || record.attachment === null) return;
    record.attachment = null;
    this.commit("failover");
  }

  // -------------------------------------------------------------- evidence

  ingestEvidence(
    reporterId: string,
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): void {
    const attachment = this.reporters.get(reporterId)?.attachment ?? null;
    if (attachment === null || attachment.incarnationId !== incarnationId) {
      // A stale renderer generation (reload, HMR) or a report that raced a
      // retirement. Dropped, never an error (mechanism 3).
      this.options.log.debug("[selection-authority] stale evidence dropped", {
        reporterId,
        incarnationId,
        kind: report.kind,
      });
      return;
    }
    switch (report.kind) {
      case "dial":
        this.ingestDial(attachment, report);
        break;
      case "session":
        this.ingestSession(attachment, report);
        break;
      case "compat":
        this.ingestCompat(report);
        break;
      case "restart-intent":
        this.ingestRestartIntent(report);
        break;
    }
    this.commit("failover");
  }

  activate(
    reporterId: string,
    incarnationId: string,
    hostId: string,
  ): Promise<ActivateResult> {
    const attachment = this.reporters.get(reporterId)?.attachment ?? null;
    if (attachment === null || attachment.incarnationId !== incarnationId) {
      return Promise.resolve({ ok: false, reason: "not-attached" });
    }
    // INTERIM BACKING (P1.2 - preferred + derivation). Writing preferred is
    // the whole of P1.2: fleet validation (`unknown-host`), the compat
    // refusal (`incompatible`), identity-scoped persistence and the
    // re-derivation that makes `ok: true` truthful ("resolves only after
    // validate, persist, and re-derivation"). Refusing every well-formed
    // request until then is the honest answer - `unrecognized` is exactly the
    // contract's arm for "this authority does not implement that write yet",
    // and no caller can mistake it for a completed activation.
    this.options.log.debug("[selection-authority] activate refused (P1.2)", {
      reporterId,
      hostId,
    });
    return Promise.resolve({ ok: false, reason: "unrecognized" });
  }

  // ----------------------------------------------------------- subscription

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
      },
    };
  }

  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription {
    this.leaseListeners.add(listener);
    return {
      dispose: () => {
        this.leaseListeners.delete(listener);
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
      },
    };
  }

  /**
   * Releases the port subscriptions and any armed deadline. Not part of the
   * contract's engine interface - it is the composition root's obligation
   * (the desktop bridge's `disposeFns`, the adapter's teardown).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.portSubscriptions) {
      subscription.dispose();
    }
    this.portSubscriptions.length = 0;
    this.clearDeadlineTimer();
    this.selectionListeners.clear();
    this.leaseListeners.clear();
    this.reattachListeners.clear();
  }

  /**
   * The full state at the current revision. Captured AFTER a transaction's
   * emissions, so `revision` is the maximum committed event revision and a
   * client that installs it can discard every buffered event at or below it.
   */
  snapshot(): SelectionAuthoritySnapshot {
    return {
      contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
      revision: this.revision,
      preferredHostId: this.selection.preferredHostId,
      targetHostId: this.selection.targetHostId,
      effectiveHostId: this.selection.effectiveHostId,
      leases: this.leases,
    };
  }

  // ------------------------------------------------------------- internals

  private reporterRecord(reporterId: string): ReporterRecord {
    const existing = this.reporters.get(reporterId);
    if (existing !== undefined) return existing;
    const created: ReporterRecord = {
      nextSeq: 0,
      latestIssuedSeq: 0,
      latestSeqConsumed: true,
      attachment: null,
    };
    this.reporters.set(reporterId, created);
    return created;
  }

  /**
   * The guard both attach paths share (module header rule 6). A non-latest or
   * already-consumed seq is STATE-NEUTRAL - it never touches the live
   * attachment. The latest unconsumed seq is consumed HERE, so whichever
   * guarded call it reached terminates that generation: the same seq can
   * never be replayed with a corrected envelope.
   */
  private claimSeq(record: ReporterRecord, attachSeq: number): boolean {
    if (attachSeq !== record.latestIssuedSeq) return false;
    if (record.latestSeqConsumed) return false;
    record.latestSeqConsumed = true;
    return true;
  }

  private inventoryFrom(
    liveSessions: readonly LiveSessionAnnouncement[],
  ): Map<string, LiveSessionRecord> {
    const sessions = new Map<string, LiveSessionRecord>();
    for (const announcement of liveSessions) {
      sessions.set(announcement.sessionId, {
        hostId: announcement.hostId,
        transportKind: announcement.transportKind,
      });
      this.observeSession(announcement.hostId, announcement.sessionId);
      this.onHostProvedAlive(announcement.hostId);
    }
    return sessions;
  }

  /**
   * Assigns a host's session its observation ordinal the first time the
   * authority hears of it - from an attach inventory, a session transition,
   * or a compat verdict naming it. This ordering, not any version string, is
   * what makes compat freshness survive downgrades and same-version restarts
   * (mechanism 6).
   */
  private observeSession(hostId: string, sessionId: string): number {
    const key = sessionKey(hostId, sessionId);
    const existing = this.sessionOrdinals.get(key);
    if (existing !== undefined) return existing;
    const ordinal = this.nextSessionOrdinal;
    this.nextSessionOrdinal += 1;
    this.sessionOrdinals.set(key, ordinal);
    return ordinal;
  }

  private hostEvidence(hostId: string): HostEvidence {
    const existing = this.evidence.get(hostId);
    if (existing !== undefined) return existing;
    const created = emptyHostEvidence();
    this.evidence.set(hostId, created);
    return created;
  }

  /** Whether ANY window currently holds a live session for the host. */
  private hasLiveSession(hostId: string): boolean {
    for (const record of this.reporters.values()) {
      const attachment = record.attachment;
      if (attachment === null) continue;
      for (const session of attachment.sessions.values()) {
        if (session.hostId === hostId) return true;
      }
    }
    return false;
  }

  /**
   * Firsthand proof of life (a dial success, or a session appearing) clears
   * the host's death streak and closes any restart episode: the outage the
   * episode was holding for is over.
   */
  private onHostProvedAlive(hostId: string): void {
    const evidence = this.hostEvidence(hostId);
    evidence.refusalStreak = 0;
    evidence.lastCountedRefusalDetail = null;
    evidence.restartEpisodeEndsAt = null;
  }

  private ingestDial(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "dial" }>,
  ): void {
    const hostId = report.hostId;
    const key = attemptKey(attachment.incarnationId, report.attemptId);
    if (attachment.seenAttemptIds.has(key)) return;
    attachment.seenAttemptIds.add(key);
    if (report.outcome === "success") {
      this.onHostProvedAlive(hostId);
      return;
    }
    // `indeterminate` is inert by contract: a liveness-read failure or an
    // attempt abandoned for unrelated reasons is not evidence about the host.
    if (report.outcome === "indeterminate") return;
    if (this.hasLiveSession(hostId)) {
      // Recorded for diagnostics, never accumulated: a live session anywhere
      // in the app outranks every other evidence class (invariant 5). The
      // streak resumes only once the session set for this host empties.
      this.options.log.debug(
        "[selection-authority] dial failure suppressed by live session",
        { hostId, outcome: report.outcome },
      );
      return;
    }
    const evidence = this.hostEvidence(hostId);
    evidence.refusalStreak += 1;
    evidence.lastCountedRefusalDetail =
      report.outcome === "confirmed-refusal" ? report.refusalDetail : null;
  }

  private ingestSession(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "session" }>,
  ): void {
    if (report.transition === "lost") {
      if (attachment.sessions.delete(report.sessionId)) return;
      // `lost` before `established` (reordered delivery): tombstone the id so
      // the late `established` cannot resurrect a session that is already
      // gone. Both are dropped; the session never counts as live.
      attachment.tombstonedSessionIds.add(report.sessionId);
      return;
    }
    if (attachment.tombstonedSessionIds.has(report.sessionId)) return;
    if (attachment.sessions.has(report.sessionId)) return;
    attachment.sessions.set(report.sessionId, {
      hostId: report.hostId,
      transportKind: report.transportKind,
    });
    this.observeSession(report.hostId, report.sessionId);
    this.onHostProvedAlive(report.hostId);
  }

  private ingestCompat(
    report: Extract<SelectionEvidenceReport, { kind: "compat" }>,
  ): void {
    const rank =
      report.probedOnSessionId === null
        ? -1
        : this.observeSession(report.hostId, report.probedOnSessionId);
    const evidence = this.hostEvidence(report.hostId);
    const current = evidence.compat;
    // A verdict probed on a session the authority observed later supersedes
    // every earlier one; equal rank means the same session (or two
    // null-anchored verdicts), where latest-received wins. A null-anchored
    // verdict never displaces a session-anchored one.
    if (current !== null && rank < current.rank) return;
    evidence.compat = {
      verdict: report.verdict,
      incompatibility: report.incompatibility,
      rank,
    };
  }

  private ingestRestartIntent(
    report: Extract<SelectionEvidenceReport, { kind: "restart-intent" }>,
  ): void {
    // FIRST receipt anchors ONE fixed episode; every duplicate - another
    // window observing the same tombstone, a liveness-plane replay - is
    // ignored outright and can never extend it (mechanism 7).
    const seen = this.seenTombstoneIds.get(report.hostId) ?? new Set<string>();
    if (seen.has(report.tombstoneId)) return;
    seen.add(report.tombstoneId);
    this.seenTombstoneIds.set(report.hostId, seen);
    const evidence = this.hostEvidence(report.hostId);
    // `expiresAt` on the report is the HOST's clock and is display-only; the
    // deadline is the authority's own ceiling.
    evidence.restartEpisodeEndsAt =
      this.options.clock.now() + RESTART_INTENT_EPISODE_MS;
  }

  // ------------------------------------------------------------------ ports

  private applyFleetSnapshot(snapshot: HostFleetSnapshot): void {
    if (snapshot.identityGeneration !== this.identityGeneration) {
      // Revision orders observations; the generation establishes MEMBERSHIP.
      // A late account-A fetch completing after account B became current is
      // rejected here no matter how high its revision is (§3b).
      this.options.log.debug(
        "[selection-authority] stale-identity fleet drop",
        {
          snapshotGeneration: snapshot.identityGeneration,
          currentGeneration: this.identityGeneration,
        },
      );
      return;
    }
    if (snapshot.revision <= this.appliedFleetRevision) return;
    this.appliedFleetRevision = snapshot.revision;
    this.fleet = snapshot;
    this.pruneEvidenceOutsideFleet();
    this.commit("fleet-shift");
  }

  /** Compat verdicts and tombstone ids are cleared on fleet removal. */
  private pruneEvidenceOutsideFleet(): void {
    const present = new Set(this.fleet.hosts.map((entry) => entry.hostId));
    for (const hostId of Array.from(this.evidence.keys())) {
      if (!present.has(hostId)) this.evidence.delete(hostId);
    }
    for (const hostId of Array.from(this.seenTombstoneIds.keys())) {
      if (!present.has(hostId)) this.seenTombstoneIds.delete(hostId);
    }
  }

  private applyIdentity(identity: {
    identityKey: string | null;
    generation: number;
  }): void {
    // Monotonic acceptance: a delayed or coalesced old callback can never
    // transition the authority backward (§3b).
    if (identity.generation <= this.identityGeneration) return;
    const isSeed = this.identityGeneration === UNSET_IDENTITY_GENERATION;
    this.identityGeneration = identity.generation;
    this.identityKey = identity.identityKey;
    if (isSeed) {
      // Nothing to wipe and no client can exist yet, so the first identity is
      // adopted without a transition (and without a re-attach trigger).
      return;
    }
    this.runIdentityTransition();
  }

  /**
   * ONE transaction (§3b): void every incarnation, clear ALL evidence, reset
   * leases, swap to the new-generation fleet if one is already available or
   * the EMPTY fleet otherwise, emit - and only after that commit, emit
   * `reattachRequired` at its OWN fresh unique revision.
   */
  private runIdentityTransition(): void {
    for (const record of this.reporters.values()) {
      // Generation high-waters survive (rule 4); only the attachment dies.
      record.attachment = null;
    }
    this.evidence.clear();
    this.seenTombstoneIds.clear();
    this.sessionOrdinals.clear();
    this.nextSessionOrdinal = 0;
    this.localOutageStartedAt = null;
    const available = this.options.fleet.snapshot();
    this.fleet =
      available.identityGeneration === this.identityGeneration
        ? available
        : emptyFleet(this.identityGeneration);
    // The matching snapshot, when it arrives, must still be applicable: the
    // adapter's revision is process-lifetime monotonic, so leaving the
    // high-water where it is only rejects observations we already applied.
    if (this.fleet.revision > this.appliedFleetRevision) {
      this.appliedFleetRevision = this.fleet.revision;
    }
    this.commit("fleet-shift");
    this.emitReattachRequired();
  }

  private applyLocalOutage(inExpectedOutage: boolean): void {
    const startedAt = this.localOutageStartedAt;
    if (inExpectedOutage) {
      if (startedAt !== null) return;
      this.localOutageStartedAt = this.options.clock.now();
    } else {
      if (startedAt === null) return;
      this.localOutageStartedAt = null;
    }
    this.commit("failover");
  }

  // ------------------------------------------------------------ derivation

  private deriveSelection(): SelectionState {
    // M5: the target is the preferred host, or the LOCAL host when preferred
    // is null, or null when neither exists. Windows cannot derive this - it
    // needs the local host's identity, which is fleet knowledge.
    //
    // INTERIM BACKING (P1.2 / P1.3): `preferredHostId` has no writer until
    // P1.2, and `effectiveHostId` stays null until P1.3's failover engine
    // derives it from lease states + the ensure outcome. Nothing consumes the
    // authority's selection yet, so a null effective is inert rather than a
    // wrong answer - and the target below is already the end-state rule.
    const preferredHostId = this.selection.preferredHostId;
    return {
      preferredHostId,
      targetHostId: preferredHostId ?? this.fleet.localHostId,
      effectiveHostId: null,
    };
  }

  private deriveLeases(): readonly HostLeaseSnapshot[] {
    const now = this.options.clock.now();
    return this.fleet.hosts.map((entry) =>
      this.deriveLease(entry.hostId, entry.kind === "local", now),
    );
  }

  /**
   * One host's verdict. The order of these arms IS the evidence hierarchy:
   *
   * 1. `incompatible` first (C4/D13): compatibility is a handshake verdict,
   *    not a transport property - such a host dials and may hold a live
   *    socket, and is still unusable for selection.
   * 2. an expected outage (restart tombstone, or the local mutation lane)
   *    HOLDS the lease: the whole point of D5 is not to move off a host that
   *    is deliberately cycling, so this outranks both the live-session arm
   *    (which would flash `ready` a moment before the socket dies) and the
   *    death arm.
   * 3. a live session anywhere in the app is firsthand proof of life.
   * 4. the confirmed-death streak. `plan-restricted` is reachable ONLY from a
   *    refusal whose transport error carried it - never from a DTO.
   * 5. otherwise `connecting`: no evidence yet, or a streak still short of
   *    the threshold. Deliberately non-committal - neither usable-by-proof
   *    nor dead.
   *
   * `degraded` has no producer in P1.1: it belongs to the reconnect engine
   * that Phase 4 folds into this module. `dead("removed")` likewise - a
   * deregistered host leaves the fleet, and P1.2's deregister-clear owns the
   * selection consequence.
   */
  private deriveLease(
    hostId: string,
    isLocal: boolean,
    now: number,
  ): HostLeaseSnapshot {
    const evidence = this.evidence.get(hostId) ?? null;
    const compat = evidence?.compat ?? null;
    if (compat !== null && compat.incompatibility !== null) {
      return {
        hostId,
        status: "dead",
        dead: { reason: "incompatible", detail: compat.incompatibility },
      };
    }
    if (this.inExpectedOutage(hostId, isLocal, now)) {
      return { hostId, status: "restarting-expected", dead: null };
    }
    if (this.hasLiveSession(hostId)) {
      return { hostId, status: "ready", dead: null };
    }
    if (
      evidence !== null &&
      evidence.refusalStreak >= CONFIRMED_DEATH_REFUSAL_STREAK
    ) {
      return {
        hostId,
        status: "dead",
        dead: {
          reason:
            evidence.lastCountedRefusalDetail === "plan-restricted"
              ? "plan-restricted"
              : "offline",
        },
      };
    }
    return { hostId, status: "connecting", dead: null };
  }

  private inExpectedOutage(
    hostId: string,
    isLocal: boolean,
    now: number,
  ): boolean {
    const episodeEndsAt = this.evidence.get(hostId)?.restartEpisodeEndsAt;
    if (episodeEndsAt !== undefined && episodeEndsAt !== null) {
      if (now < episodeEndsAt) return true;
    }
    if (!isLocal) return false;
    const startedAt = this.localOutageStartedAt;
    if (startedAt === null) return false;
    return now < startedAt + LOCAL_EXPECTED_OUTAGE_CEILING_MS;
  }

  /**
   * The next moment a lease would change with no new evidence - an episode or
   * the local ceiling lapsing. Without this the lease would stay
   * `restarting-expected` until something else happened to arrive.
   */
  private nextDeadline(now: number): number | null {
    let earliest: number | null = null;
    const consider = (deadline: number): void => {
      if (deadline <= now) return;
      if (earliest === null || deadline < earliest) earliest = deadline;
    };
    for (const entry of this.fleet.hosts) {
      const endsAt = this.evidence.get(entry.hostId)?.restartEpisodeEndsAt;
      if (endsAt !== undefined && endsAt !== null) consider(endsAt);
      if (entry.kind === "local" && this.localOutageStartedAt !== null) {
        consider(this.localOutageStartedAt + LOCAL_EXPECTED_OUTAGE_CEILING_MS);
      }
    }
    return earliest;
  }

  private clearDeadlineTimer(): void {
    if (this.cancelDeadlineTimer !== null) {
      this.cancelDeadlineTimer();
      this.cancelDeadlineTimer = null;
    }
    this.scheduledDeadline = null;
  }

  private armDeadlineTimer(now: number): void {
    const deadline = this.nextDeadline(now);
    if (deadline === null) {
      this.clearDeadlineTimer();
      return;
    }
    if (this.scheduledDeadline === deadline) return;
    this.clearDeadlineTimer();
    this.scheduledDeadline = deadline;
    this.cancelDeadlineTimer = this.options.clock.schedule(
      Math.max(0, deadline - now),
      () => {
        this.cancelDeadlineTimer = null;
        this.scheduledDeadline = null;
        if (this.disposed) return;
        this.commit("failover");
      },
    );
  }

  // -------------------------------------------------------------- emission

  /**
   * Derives and emits one transaction's events. A transaction that moves both
   * slices commits at CONSECUTIVE revisions (mechanism 1) - the selection
   * event first, so a client applying them in revision order never sees
   * leases for a selection it has not been told about.
   *
   * `cause` rides the selection event only. Sites that cannot move the
   * selection tuple pass `"failover"`: in P1.1 the selection depends solely
   * on preferred + fleet, so evidence-driven emissions are structurally
   * impossible, and when P1.3 makes `effective` evidence-derived, a move
   * caused by evidence IS a failover (P1.3 refines the recovery arm).
   */
  private commit(cause: SelectionChangeCause): void {
    const selection = this.deriveSelection();
    if (!selectionEquals(selection, this.selection)) {
      const previousEffectiveHostId = this.selection.effectiveHostId;
      this.selection = selection;
      this.emitSelection({
        revision: this.nextRevision(),
        change: {
          preferredHostId: selection.preferredHostId,
          targetHostId: selection.targetHostId,
          effectiveHostId: selection.effectiveHostId,
          previousEffectiveHostId,
          cause,
        },
      });
    }
    const leases = this.deriveLeases();
    if (!leasesEqual(leases, this.leases)) {
      this.leases = leases;
      this.emitLeases({ revision: this.nextRevision(), change: leases });
    }
    this.armDeadlineTimer(this.options.clock.now());
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private emitSelection(event: SelectionRevisioned<SelectionChange>): void {
    for (const listener of Array.from(this.selectionListeners)) {
      this.deliver(() => listener(event), "selectionChanged");
    }
  }

  private emitLeases(
    event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
  ): void {
    for (const listener of Array.from(this.leaseListeners)) {
      this.deliver(() => listener(event), "leasesChanged");
    }
  }

  /**
   * The MANDATORY post-transition re-attach trigger, at its own fresh unique
   * revision so one client high-water mark still orders all three event kinds
   * and no state sibling can shadow it (§3b).
   */
  private emitReattachRequired(): void {
    const event: SelectionReattachRequired = { revision: this.nextRevision() };
    for (const listener of Array.from(this.reattachListeners)) {
      this.deliver(() => listener(event), "reattachRequired");
    }
  }

  /** One window's throwing listener must not cost another window its event. */
  private deliver(run: () => void, channel: string): void {
    try {
      run();
    } catch (error: unknown) {
      this.options.log.warn("[selection-authority] listener threw", {
        channel,
        error: String(error),
      });
    }
  }

  /**
   * The identity the persisted preference is scoped to (P1.2). Held here
   * because the transition transaction is the only place it changes.
   */
  currentIdentityKey(): string | null {
    return this.identityKey;
  }
}
