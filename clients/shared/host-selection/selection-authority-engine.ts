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

/**
 * Where `preferredHostId` survives an app restart, IDENTITY-SCOPED (G1).
 *
 * Reads are synchronous because the engine loads the preference inside the
 * identity transaction that establishes the identity - a later async
 * completion would derive once against the wrong preference and correct
 * itself with a visible move. The file is tiny and written only on Activate
 * or a deregister-clear, so the cost is a rare small write, not a hot path.
 *
 * `identityKey: null` (signed out) has no bucket to read or write: there is
 * no account whose choice could be remembered.
 */
export interface PreferredHostStore {
  load(identityKey: string | null): string | null;
  save(identityKey: string | null, hostId: string | null): void;
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
  readonly preferredStore: PreferredHostStore;
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
  /**
   * hostId -> sessionId -> the authority's observation ordinal, scoped to
   * THIS incarnation because that is the scope in which `sessionId` is unique.
   * The ordinals are drawn from one global counter, so ranks remain
   * comparable across incarnations.
   */
  readonly sessionOrdinals: Map<string, Map<string, number>>;
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

/** One staged event, awaiting delivery in the engine's FIFO drain. */
type QueuedAuthorityEvent =
  | {
      readonly kind: "selection";
      readonly event: SelectionRevisioned<SelectionChange>;
    }
  | {
      readonly kind: "leases";
      readonly event: SelectionRevisioned<readonly HostLeaseSnapshot[]>;
    }
  | { readonly kind: "reattach"; readonly event: SelectionReattachRequired };

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

/**
 * Refines the cause of a DERIVED move. Explicit causes (`activate`,
 * `deregister-clear`, `fleet-shift`) are facts the caller knows and pass
 * through untouched; `failover` is the marker every evidence-driven path
 * passes, and only here - with the new tuple in hand - can it be told apart
 * from its mirror: landing ON the target is a recovery, leaving it is a
 * failover. P1.3 refines nothing about this; it adds the damping that decides
 * WHEN a move is allowed, not what to call it.
 */
function resolveCause(
  requested: SelectionChangeCause,
  selection: SelectionState,
): SelectionChangeCause {
  if (requested !== "failover") return requested;
  if (selection.effectiveHostId === null) return "failover";
  return selection.effectiveHostId === selection.targetHostId
    ? "recovery"
    : "failover";
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

  /**
   * The user's intent (D1), and the ONLY persisted half of the selection.
   * Written by exactly two paths: `activate` (the single UI writer) and the
   * deregister-clear below (the single sanctioned system write).
   */
  private preferredHostId: string | null = null;
  /**
   * Hosts that have BEEN effective, most recent first - the "most-recently
   * -effective usable remote" the derivation's third arm names (registry §4).
   * Runtime state: it describes this process's own observation order, and a
   * persisted copy would let a machine the user has not seen in weeks
   * outrank one they used an hour ago on another device.
   */
  private readonly mruEffectiveHostIds: string[] = [];
  private selection: SelectionState = EMPTY_SELECTION;
  private leases: readonly HostLeaseSnapshot[] = [];

  private fleet: HostFleetSnapshot = emptyFleet(UNSET_IDENTITY_GENERATION);
  private appliedFleetRevision = Number.NEGATIVE_INFINITY;
  private identityKey: string | null = null;
  private identityGeneration = UNSET_IDENTITY_GENERATION;

  private readonly reporters = new Map<string, ReporterRecord>();
  private readonly evidence = new Map<string, HostEvidence>();
  /**
   * The next observation ordinal to hand out. The ordinals themselves live on
   * the ATTACHMENT that observed them (see {@link AttachmentRecord}); this
   * counter is global so ranks stay comparable across incarnations, which is
   * what lets a newer window's verdict supersede an older window's.
   */
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
  /**
   * Staged-but-undelivered events, in revision order. Listeners run consumer
   * code synchronously and may re-enter the engine, so delivery is a separate
   * FIFO drain rather than an inline call - see {@link commit}.
   */
  private readonly eventQueue: QueuedAuthorityEvent[] = [];
  private draining = false;
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
    // AFTER the identity seed: the preference is scoped to whoever is signed
    // in, so it cannot be read before that is known.
    this.preferredHostId = options.preferredStore.load(this.identityKey);

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
    const attachment: AttachmentRecord = {
      incarnationId,
      attachSeq: request.attachSeq,
      sessions: new Map<string, LiveSessionRecord>(),
      tombstonedSessionIds: new Set<string>(),
      seenAttemptIds: new Set<string>(),
      sessionOrdinals: new Map<string, Map<string, number>>(),
    };
    record.attachment = attachment;
    this.installInventory(attachment, request.liveSessions);
    // SEAL BEFORE DELIVERY. The result is captured between staging and
    // draining, so a listener that re-enters (an identity transition driven
    // from a lease callback, say) mints its `reattachRequired` at a revision
    // ABOVE this snapshot - which is what lets the client keep the trigger
    // instead of discarding it as already covered.
    this.stage("failover");
    const result: SelectionAttachResult = {
      ok: true,
      incarnationId,
      snapshot: this.snapshot(),
    };
    this.drain();
    return result;
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
        this.ingestCompat(attachment, report);
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
    // F14: the write is DIRECTORY-VALIDATED. Refusing an id the fleet does not
    // hold is what stops any path - a stale picker row, a replayed gesture -
    // from re-asserting a host that was deregistered.
    if (!this.fleet.hosts.some((entry) => entry.hostId === hostId)) {
      return Promise.resolve({ ok: false, reason: "unknown-host" });
    }
    // D13/C4: an incompatible host is never selectable. Settings offers
    // Update instead. A host that becomes incompatible AFTER being preferred
    // keeps the preference and fails over until it is updated - that is a
    // derivation outcome, not a refusal, and it is why this checks the
    // CURRENT verdict rather than remembering one.
    const lease = this.leases.find((entry) => entry.hostId === hostId) ?? null;
    if (
      lease !== null &&
      lease.status === "dead" &&
      lease.dead.reason === "incompatible"
    ) {
      return Promise.resolve({ ok: false, reason: "incompatible" });
    }
    // Deliberately NOT refused: a registered host that is merely offline.
    // Preferred is intent, not liveness (D1/D5).
    if (this.preferredHostId !== hostId) {
      this.preferredHostId = hostId;
      this.options.preferredStore.save(this.identityKey, hostId);
      // Commit before resolving: the contract promises `ok: true` only after
      // validate, persist AND re-derivation, so the selection event has
      // already been emitted when the caller sees success.
      this.commit("activate");
    }
    return Promise.resolve({ ok: true });
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

  private installInventory(
    attachment: AttachmentRecord,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): void {
    for (const announcement of liveSessions) {
      attachment.sessions.set(announcement.sessionId, {
        hostId: announcement.hostId,
        transportKind: announcement.transportKind,
      });
      this.observeSession(
        attachment,
        announcement.hostId,
        announcement.sessionId,
      );
      this.onHostProvedAlive(announcement.hostId);
    }
  }

  /**
   * Assigns a host's session its observation ordinal the first time the
   * REPORTING INCARNATION names it - from an attach inventory, a session
   * transition, or a compat verdict naming it. This ordering, not any version
   * string, is what makes compat freshness survive downgrades and
   * same-version restarts (mechanism 6).
   *
   * Scoped to the attachment because `sessionId` is only unique WITHIN an
   * incarnation (contract, {@link SelectionSessionEvidence}). Keyed globally,
   * two windows that both call their connection `"s1"` shared one ordinal, so
   * a delayed incompatibility probed on window A's long-dead `s1` tied window
   * B's verdict on its own live `s1` and - latest-received wins on a tie -
   * flipped B's lease to dead. Nesting the map also removes the last place a
   * delimiter inside an id could forge a collision.
   */
  private observeSession(
    attachment: AttachmentRecord,
    hostId: string,
    sessionId: string,
  ): number {
    const perHost =
      attachment.sessionOrdinals.get(hostId) ?? new Map<string, number>();
    attachment.sessionOrdinals.set(hostId, perHost);
    const existing = perHost.get(sessionId);
    if (existing !== undefined) return existing;
    const ordinal = this.nextSessionOrdinal;
    this.nextSessionOrdinal += 1;
    perHost.set(sessionId, ordinal);
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
    this.observeSession(attachment, report.hostId, report.sessionId);
    this.onHostProvedAlive(report.hostId);
  }

  private ingestCompat(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "compat" }>,
  ): void {
    const rank =
      report.probedOnSessionId === null
        ? -1
        : this.observeSession(
            attachment,
            report.hostId,
            report.probedOnSessionId,
          );
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
    this.commit(this.clearPreferredOutsideFleet() ? "deregister-clear" : "fleet-shift");
  }

  /**
   * The single sanctioned SYSTEM write to preferred (invariant 1), and F14's
   * load-time degradation - one rule, because they are the same fact observed
   * at different times: the preferred host is no longer in the account's
   * fleet. Deregistering it while the app runs and finding it already gone at
   * startup both land here, and both clear to null so nothing can re-assert a
   * stale id.
   *
   * An EMPTY fleet never triggers it. "No hosts" is what this port publishes
   * before its first genuine registry answer and while an identity transition
   * is in flight, and a preference must not be destroyed by the absence of an
   * answer - the same distinction the directory drew between "the registry
   * omitted the host" and "the registry was never reached". Holding a stale
   * preference costs nothing meanwhile: with no lease it is not usable, so
   * derivation ignores it, and the next non-empty snapshot settles it.
   */
  private clearPreferredOutsideFleet(): boolean {
    const preferredHostId = this.preferredHostId;
    if (preferredHostId === null) return false;
    if (this.fleet.hosts.length === 0) return false;
    if (this.fleet.hosts.some((entry) => entry.hostId === preferredHostId)) {
      return false;
    }
    this.preferredHostId = null;
    this.options.preferredStore.save(this.identityKey, null);
    return true;
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
    const outgoingIdentityKey = this.identityKey;
    this.identityGeneration = identity.generation;
    this.identityKey = identity.identityKey;
    if (isSeed) {
      // Nothing to wipe and no client can exist yet, so the first identity is
      // adopted without a transition (and without a re-attach trigger).
      return;
    }
    this.runIdentityTransition(outgoingIdentityKey);
  }

  /**
   * ONE transaction (§3b): void every incarnation, clear ALL evidence, reset
   * leases, swap to the new-generation fleet if one is already available or
   * the EMPTY fleet otherwise, emit - and only after that commit, emit
   * `reattachRequired` at its OWN fresh unique revision.
   */
  private runIdentityTransition(outgoingIdentityKey: string | null): void {
    // G1: sign-out WIPES the preference rather than merely scoping it, so a
    // shared machine cannot show the previous user's host choice back to
    // them, and the incoming account inherits nothing. Persistence exists to
    // survive a restart, not a user switch.
    this.options.preferredStore.save(outgoingIdentityKey, null);
    this.preferredHostId = this.options.preferredStore.load(this.identityKey);
    this.mruEffectiveHostIds.length = 0;
    for (const record of this.reporters.values()) {
      // Generation high-waters survive (rule 4); only the attachment dies.
      record.attachment = null;
    }
    this.evidence.clear();
    this.seenTombstoneIds.clear();
    this.nextSessionOrdinal = 0;
    // The local expected-outage hold is PORT STATE, not evidence: the
    // HostController mutation lane does not stop being in flight because the
    // signed-in user changed. Clearing it blindly used to drop the hold with
    // no edge left to restore it, so a deliberate local restart spanning a
    // sign-out would derive as connecting/dead and P1.3 would fail over off a
    // host that is coming back. Re-sample instead, keeping the original start
    // so the ceiling still counts from when the lane actually went busy.
    this.localOutageStartedAt = this.options.localOutage.inExpectedOutage()
      ? (this.localOutageStartedAt ?? this.options.clock.now())
      : null;
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
    // One transaction: the state batch is staged first and the trigger after
    // it, so the trigger's revision is strictly above every event of the
    // commit it follows - then both are delivered in that order.
    this.stage("fleet-shift");
    this.stageReattachRequired();
    this.drain();
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

  /**
   * `derive(preferred, fleet)` from selection model §1, as a PURE function of
   * the preference, the fleet and the leases just computed:
   *
   *   usable(preferred) → preferred
   *   usable(local)     → local
   *   any usable remote → most-recently-effective one
   *   otherwise         → null  (∅ → the global modal)
   *
   * P1.3 owns the failover MACHINE on top of this - death streaks driving
   * candidate switches, the local `ensure` request, and the damping windows.
   * Nothing here waits, retries or debounces: it answers "given what is known
   * right now, which host serves this app".
   */
  private deriveSelection(
    leases: readonly HostLeaseSnapshot[],
  ): SelectionState {
    const preferredHostId = this.preferredHostId;
    // M5: the target is the preference, or the local host when there is none.
    const localHostId = this.fleet.localHostId;
    return {
      preferredHostId,
      targetHostId: preferredHostId ?? localHostId,
      effectiveHostId: this.deriveEffective(
        preferredHostId,
        localHostId,
        leases,
      ),
    };
  }

  private deriveEffective(
    preferredHostId: string | null,
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
  ): string | null {
    if (preferredHostId !== null && this.isUsable(preferredHostId, leases)) {
      return preferredHostId;
    }
    if (localHostId !== null && this.isUsable(localHostId, leases)) {
      return localHostId;
    }
    return this.mostRecentlyEffectiveUsableRemote(localHostId, leases);
  }

  /** A host is usable only if the fleet holds it AND its lease says so. */
  private isUsable(
    hostId: string,
    leases: readonly HostLeaseSnapshot[],
  ): boolean {
    const lease = leases.find((entry) => entry.hostId === hostId);
    return lease !== undefined && isUsableForSelection(lease);
  }

  /**
   * The third arm. MRU order first; when this process has never had an
   * effective remote (a cold start that cannot reach the local host), fall
   * back to the fleet's own order - which the fleet port sorts by hostId, so
   * the answer is deterministic rather than dependent on registry ordering.
   */
  private mostRecentlyEffectiveUsableRemote(
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
  ): string | null {
    for (const hostId of this.mruEffectiveHostIds) {
      if (hostId === localHostId) continue;
      if (this.isUsable(hostId, leases)) return hostId;
    }
    for (const lease of leases) {
      if (lease.hostId === localHostId) continue;
      if (isUsableForSelection(lease)) return lease.hostId;
    }
    return null;
  }

  /** Records an effective host at the head of the MRU order. */
  private noteEffective(hostId: string | null): void {
    if (hostId === null) return;
    const at = this.mruEffectiveHostIds.indexOf(hostId);
    if (at === 0) return;
    if (at > 0) this.mruEffectiveHostIds.splice(at, 1);
    this.mruEffectiveHostIds.unshift(hostId);
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
   * Stages one transaction and then delivers whatever is queued.
   *
   * COMMIT AND DELIVERY ARE SEPARATE STEPS, and that separation is
   * load-bearing rather than stylistic. Listeners run arbitrary consumer code
   * synchronously - in the browser/dev topology the in-process client hands
   * events straight to the renderer - so a listener can re-enter the engine
   * (drive the identity source, publish a fleet snapshot) in the middle of a
   * delivery. When emission happened inline, that re-entrancy could:
   *
   *  - interleave a nested transaction's revisions BETWEEN the parent's
   *    selection and leases events, breaking the contract's consecutive
   *    sibling pair; and
   *  - mint the identity transition's `reattachRequired` BEFORE `attach`
   *    captured its result snapshot, so the snapshot's revision already
   *    covered the trigger and the buffering client discarded it as
   *    stale - leaving that client holding a voided incarnation with no
   *    re-attach ever to follow.
   *
   * Staging allocates every revision for the transaction up front and appends
   * the events to one FIFO queue; the drain delivers them in that order, and a
   * nested commit appends AFTER the batch in flight instead of splitting it.
   */
  private commit(cause: SelectionChangeCause): void {
    this.stage(cause);
    this.drain();
  }

  /**
   * Mutates state and QUEUES the transaction's events. Delivers nothing, so a
   * caller that must seal a result against re-entrancy (see `attach`) can read
   * its snapshot between staging and draining.
   */
  private stage(cause: SelectionChangeCause): void {
    // Leases FIRST: derivation is a function of them, so computing the
    // selection off the previously-emitted set would answer one transaction
    // late. Emission order is still selection-then-leases (consecutive
    // revisions), so a client never sees leases for a selection it has not
    // been told about.
    const leases = this.deriveLeases();
    const selection = this.deriveSelection(leases);
    if (!selectionEquals(selection, this.selection)) {
      const previousEffectiveHostId = this.selection.effectiveHostId;
      this.selection = selection;
      this.noteEffective(selection.effectiveHostId);
      this.eventQueue.push({
        kind: "selection",
        event: {
          revision: this.nextRevision(),
          change: {
            preferredHostId: selection.preferredHostId,
            targetHostId: selection.targetHostId,
            effectiveHostId: selection.effectiveHostId,
            previousEffectiveHostId,
            cause: resolveCause(cause, selection),
          },
        },
      });
    }
    if (!leasesEqual(leases, this.leases)) {
      this.leases = leases;
      this.eventQueue.push({
        kind: "leases",
        event: { revision: this.nextRevision(), change: leases },
      });
    }
    this.armDeadlineTimer(this.options.clock.now());
  }

  /**
   * The MANDATORY post-transition re-attach trigger, staged at its OWN fresh
   * unique revision after its transaction's state events (§3b) so one client
   * high-water mark still orders all three event kinds and no state sibling
   * can shadow it.
   */
  private stageReattachRequired(): void {
    this.eventQueue.push({
      kind: "reattach",
      event: { revision: this.nextRevision() },
    });
  }

  /** Delivers the queue in FIFO order; re-entrant calls are absorbed. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const queued = this.eventQueue.shift();
        if (queued === undefined) return;
        this.deliverQueued(queued);
      }
    } finally {
      this.draining = false;
    }
  }

  private deliverQueued(queued: QueuedAuthorityEvent): void {
    if (queued.kind === "selection") {
      for (const listener of Array.from(this.selectionListeners)) {
        this.deliver(() => listener(queued.event), "selectionChanged");
      }
      return;
    }
    if (queued.kind === "leases") {
      for (const listener of Array.from(this.leaseListeners)) {
        this.deliver(() => listener(queued.event), "leasesChanged");
      }
      return;
    }
    for (const listener of Array.from(this.reattachListeners)) {
      this.deliver(() => listener(queued.event), "reattachRequired");
    }
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
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
