/**
 * The per-window evidence kernel (connection registry §1b, P1.1) - the shim
 * that sits in a window's transport layer, REPORTS what its own transports
 * observed to the selection authority, and RENDERS from the authority's
 * aggregated verdict.
 *
 * The division of labour it exists to enforce (registry §1b, mechanism 10):
 *
 *  - A window never derives its own effective host. It has no vote. When its
 *    local evidence disagrees with the authority's verdict (its socket died
 *    while another window's lives), that is a per-lease CONDITION it reports
 *    and renders - never a reason to fail over alone.
 *  - The confirmed-death counter counts THE APP's attempts. This kernel
 *    contributes attempts; it never counts them.
 *
 * ## Dial classification: the one rule that must not be got wrong
 *
 * `confirmed-refusal` means THIS ATTEMPT was terminally refused by the
 * transport itself - connection refused, a Noise/relay handshake rejection, a
 * relay attach refusal, an attach-grant mint that came back
 * `plan-restricted`. It is deliberately NOT
 * `isConfirmedTransportRefusal(entry, hasReadyLiveSession)` from
 * `host-client/remote-fetcher.ts`: that helper is a PRE-DIAL directory gate
 * that folds cloud-DTO verdicts (`offline`, `plan-restricted`) into its
 * answer, so feeding it here would let a DTO flip advance the death counter -
 * exactly what invariant 5 forbids, and exactly the false-Offline window the
 * audit measured (≤4 h relay fuse).
 *
 * That rule is enforced STRUCTURALLY rather than by review: this kernel has
 * no "classify this error" entry point at all. A caller states the outcome it
 * observed through one of the four `reportDial*` methods, and the only one
 * that can produce death evidence with a `plan-restricted` reason takes that
 * detail from the transport error it just handled. There is no argument you
 * can pass that turns a directory verdict into a refusal.
 *
 * ## Producers (wired by later tickets)
 *
 * P1.1 lands the kernel, its inventory and its attach choreography. The call
 * sites that will feed it are named here so the wiring is a matter of record:
 * the remote session's connect loop (`host-transport/remote/remote-session.ts`
 * - one `reportDial*` per attempt generation, `sessionEstablished` at its
 * ready boundary, `sessionLost` when a connection drops), the local WS dial,
 * the compat probe (`reportCompatVerdict`), and P1.4's liveness-plane
 * tombstone observer (`reportRestartIntent`).
 */
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type SelectionAttachResult,
  type SelectionAuthorityClient,
  type SelectionChange,
  type SelectionIncompatibility,
  type SelectionSubscription,
  type SelectionTransportKind,
} from "./selection-authority-contract";
import { type AuthorityLog } from "./selection-authority-engine";

/**
 * What the window renders from. `selection` is null until the first attach
 * succeeds; `leases` is the authority's aggregate, never this window's own
 * view of its sockets.
 */
export interface SelectionKernelSnapshot {
  readonly attached: boolean;
  readonly preferredHostId: string | null;
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
}

const DETACHED_SNAPSHOT: SelectionKernelSnapshot = {
  attached: false,
  preferredHostId: null,
  targetHostId: null,
  effectiveHostId: null,
  leases: [],
};

export interface SelectionEvidenceKernelOptions {
  readonly client: SelectionAuthorityClient;
  /**
   * Stamps the diagnostic `at` on every report. Identity and ordering come
   * from attemptIds and authority revisions, never from this clock.
   */
  readonly now: () => number;
  readonly log: AuthorityLog;
}

interface KernelSessionRecord {
  readonly hostId: string;
  readonly transportKind: SelectionTransportKind;
}

/**
 * One window's kernel. Construct one per renderer load; `start()` registers
 * the authority subscriptions and performs the attach that carries the
 * window's complete live-session inventory.
 */
export class SelectionEvidenceKernel {
  private readonly options: SelectionEvidenceKernelOptions;
  /**
   * The window's live sessions, keyed by the reporter-generated sessionId.
   * This IS the inventory an attach transfers atomically, which is why it is
   * kept here rather than recomputed from the transports at attach time: a
   * re-announce step after the claim would leave an observable empty-session
   * window in which concurrent refusals could count against sockets that
   * survived (decision 8).
   */
  private readonly sessions = new Map<string, KernelSessionRecord>();

  private current: SelectionKernelSnapshot = DETACHED_SNAPSHOT;
  private started = false;
  private disposed = false;
  private readonly subscriptions: SelectionSubscription[] = [];
  private readonly listeners = new Set<
    (snapshot: SelectionKernelSnapshot) => void
  >();

  constructor(options: SelectionEvidenceKernelOptions) {
    this.options = options;
  }

  /**
   * Registers listeners first, then attaches - the order the buffering
   * protocol requires (module header rule 3): everything the authority emits
   * between the snapshot's capture and the listeners going live is buffered
   * by the client and replayed, so nothing can be lost in the gap.
   */
  start(): Promise<SelectionAttachResult> {
    if (this.started || this.disposed) {
      return Promise.resolve({ ok: false, kind: "superseded" });
    }
    this.started = true;
    const client = this.options.client;
    this.subscriptions.push(
      client.onSelectionChanged((event) => {
        this.applySelection(event.change);
      }),
      client.onLeasesChanged((event) => {
        this.applyLeases(event.change);
      }),
      client.onReattachRequired(() => {
        // The MANDATORY trigger: the client has already rotated to a fresh
        // generation, so this attach carries the same inventory onto the new
        // one atomically.
        void this.attach();
      }),
    );
    return this.attach();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.listeners.clear();
  }

  snapshot(): SelectionKernelSnapshot {
    return this.current;
  }

  /** Lease/selection subscription surface consumed by P1.2+ surfaces. */
  onChange(
    listener: (snapshot: SelectionKernelSnapshot) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** This window's own live-session count for a host (divergence display). */
  localSessionCount(hostId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.hostId === hostId) count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------- sessions

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.sessions.set(sessionId, { hostId, transportKind });
    void this.options.client.reportEvidence({
      kind: "session",
      hostId,
      sessionId,
      transition: "established",
      transportKind,
      at: this.options.now(),
    });
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.sessions.delete(sessionId);
    void this.options.client.reportEvidence({
      kind: "session",
      hostId,
      sessionId,
      transition: "lost",
      transportKind,
      at: this.options.now(),
    });
  }

  // ----------------------------------------------------------------- dials

  /** A dial that reached the host. Clears the host's death streak. */
  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "success");
  }

  /**
   * A dial the TRANSPORT terminally refused. `refusalDetail` is
   * `"plan-restricted"` only when the attempt's own error carried the plan
   * restriction (an attach-grant mint refused with `plan_restricted`); it is
   * the sole provenance of `dead("plan-restricted")`.
   */
  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    void this.options.client.reportEvidence({
      kind: "dial",
      hostId,
      attemptId,
      outcome: "confirmed-refusal",
      refusalDetail,
      transportKind,
      at: this.options.now(),
    });
  }

  /** A dial that ran out of time without an answer. Death evidence. */
  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "timeout");
  }

  /**
   * An attempt that says nothing about the host - a liveness read that
   * failed, an attempt abandoned for unrelated reasons (the window slept, the
   * credential rotated mid-dial). Inert by contract: it never advances a
   * counter, and reporting it is still worth doing for diagnostics.
   */
  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "indeterminate");
  }

  // ------------------------------------------------------- compat / restart

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    const at = this.options.now();
    if (input.incompatibility === null) {
      void this.options.client.reportEvidence({
        kind: "compat",
        hostId: input.hostId,
        probedOnSessionId: input.probedOnSessionId,
        hostVersion: input.hostVersion,
        verdict: "compatible",
        incompatibility: null,
        at,
      });
      return;
    }
    void this.options.client.reportEvidence({
      kind: "compat",
      hostId: input.hostId,
      probedOnSessionId: input.probedOnSessionId,
      hostVersion: input.hostVersion,
      verdict: "incompatible",
      incompatibility: input.incompatibility,
      at,
    });
  }

  /**
   * A restart tombstone observed on the liveness plane (P1.4's producer).
   * `expiresAt` is the HOST's clock and is display-only - the authority
   * bounds the episode with its own ceiling.
   */
  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    void this.options.client.reportEvidence({
      kind: "restart-intent",
      hostId,
      tombstoneId,
      expiresAt,
      at: this.options.now(),
    });
  }

  // ------------------------------------------------------------- internals

  private reportDial(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    outcome: "success" | "timeout" | "indeterminate",
  ): void {
    void this.options.client.reportEvidence({
      kind: "dial",
      hostId,
      attemptId,
      outcome,
      transportKind,
      at: this.options.now(),
    });
  }

  private inventory(): readonly LiveSessionAnnouncement[] {
    const announcements: LiveSessionAnnouncement[] = [];
    for (const [sessionId, session] of this.sessions) {
      announcements.push({
        hostId: session.hostId,
        sessionId,
        transportKind: session.transportKind,
      });
    }
    return announcements;
  }

  private attach(): Promise<SelectionAttachResult> {
    return this.options.client
      .attach(SELECTION_AUTHORITY_CONTRACT_VERSION, this.inventory())
      .then((result) => {
        if (!result.ok) {
          // Every failure arm is terminal for that generation: `superseded`
          // means a newer load already owns the reporter, and
          // `version-mismatch` / `malformed-request` mean this bundle can
          // never attach with the seq it was issued. Recovery is a fresh load
          // (or the next `reattachRequired`), never a retry loop here.
          this.options.log.warn("[selection-kernel] attach refused", {
            kind: result.kind,
          });
          this.publish(DETACHED_SNAPSHOT);
          return result;
        }
        this.publish({
          attached: true,
          preferredHostId: result.snapshot.preferredHostId,
          targetHostId: result.snapshot.targetHostId,
          effectiveHostId: result.snapshot.effectiveHostId,
          leases: result.snapshot.leases,
        });
        return result;
      });
  }

  private applySelection(change: SelectionChange): void {
    this.publish({
      attached: true,
      preferredHostId: change.preferredHostId,
      targetHostId: change.targetHostId,
      effectiveHostId: change.effectiveHostId,
      leases: this.current.leases,
    });
  }

  private applyLeases(leases: readonly HostLeaseSnapshot[]): void {
    this.publish({ ...this.current, leases });
  }

  private publish(snapshot: SelectionKernelSnapshot): void {
    this.current = snapshot;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch (error: unknown) {
        this.options.log.warn("[selection-kernel] listener threw", {
          error: String(error),
        });
      }
    }
  }
}
