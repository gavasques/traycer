/**
 * The seam through which a window's TRANSPORTS feed the selection authority's
 * evidence kernel (connection registry §1b, redesign P1.3).
 *
 * P1.1 landed the kernel with its producers deliberately unwired, so that the
 * failover engine could never be built on an evidence vacuum by accident: with
 * nothing reporting, every lease reads `connecting`, derivation returns
 * preferred-or-local, and nothing ever moves. This module is the wiring, and it
 * exists as its own narrow interface rather than passing the kernel itself so
 * that `host-transport` never depends on the authority's client/IPC surface.
 *
 * ## The classification rule (do not soften it)
 *
 * `confirmed-refusal` requires evidence from the HOST's transport plane -
 * connection refused, a Noise/relay handshake rejection, a relay attach
 * refusal. Credential- and authn-plane failures are `indeterminate`, however
 * terminal they look: an attach-grant mint that fails because the user is
 * signed out, because the bearer was rejected, or because authn returned 500
 * says nothing about whether the HOST is alive - it was never dialed. Counting
 * those would let one cloud outage reach the confirmed-death streak on every
 * remote host at once and fail the whole fleet over, which is the false-Offline
 * class invariant 5 exists to prevent.
 *
 * The one entitlement exception is `plan-restricted`, which stays a refusal: it
 * is a stable PER-HOST verdict rather than a transient fleet-correlated
 * outage, it is the sole provenance of `dead("plan-restricted")`, and it is
 * what routes the ∅ modal to "upgrade" instead of "retry".
 *
 * That rule is enforced structurally, not by review: this interface exposes
 * positive outcomes only. There is no "classify this error" entry point, so
 * `isConfirmedTransportRefusal` (the PRE-DIAL directory gate that folds cloud
 * -DTO verdicts into its answer) cannot be fed to it by any argument a caller
 * could pass. Callers state the outcome they observed, from the error the
 * attempt itself produced.
 */
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "./selection-authority-contract";

/**
 * What a transport reports. Structurally identical to the matching methods of
 * `SelectionEvidenceKernel`, which declares `implements` against it so a
 * signature drift is a compile error rather than a silently dead producer.
 */
export interface TransportEvidenceReporter {
  /**
   * A transport session for `hostId` is now live. A live session anywhere in
   * the app is the strongest evidence class there is (invariant 5): it
   * suppresses death accumulation entirely and pins the lease `ready`, so a
   * session announced here MUST be retracted through {@link sessionLost} on
   * every teardown path, or the host can never be declared dead again.
   */
  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** A dial that reached the host. Clears the host's death streak. */
  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /**
   * A dial the HOST's transport plane terminally refused. `refusalDetail` is
   * `"plan-restricted"` only when this attempt's own error carried the
   * entitlement denial - see the module header.
   */
  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void;
  /** A dial that ran out of time without an answer. Death evidence. */
  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** An attempt that says nothing about the host. Inert by contract. */
  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void;
}

/**
 * For shells that have no selection authority to feed - the CLI, and every
 * test that builds a transport to exercise something else. Named rather than
 * defaulted: the transports take their reporter as a required option, so a new
 * construction site has to say which of the two it means.
 */
export const NO_TRANSPORT_EVIDENCE: TransportEvidenceReporter = {
  sessionEstablished: () => undefined,
  sessionLost: () => undefined,
  reportDialSuccess: () => undefined,
  reportDialRefusal: () => undefined,
  reportDialTimeout: () => undefined,
  reportDialIndeterminate: () => undefined,
  reportCompatVerdict: () => undefined,
};

/**
 * A stable reporter whose target can be swapped underneath live transports.
 *
 * THE INVARIANT: the relay's scope must equal the pooled transports' scope.
 *
 * Remote sessions are shared through a MODULE-scoped cache
 * (`host-transport/remote/active-remote-sessions.ts`), so on a cache hit the
 * session-building factory never runs and whatever reporter the FIRST acquirer
 * wired is the one that session keeps for life. Handing transports the kernel
 * directly would therefore bind them to one kernel instance permanently: a
 * host-runtime remount builds a new kernel while cached sessions go on
 * reporting into the disposed one, whose evidence the engine drops at the
 * incarnation gate - silent evidence loss in exactly the window (a re-mount,
 * an account switch) where the engine most needs to be told what the sockets
 * are seeing.
 *
 * Holding one relay for as long as the session pool lives closes that: the
 * composition root binds the current kernel and unbinds on teardown, and every
 * transport - cached or fresh - reports into whichever kernel is live now.
 *
 * This is not ambient authority in `shared`: nothing here is a module
 * singleton. The relay is an ordinary constructor argument; it is the CLIENT
 * that holds one at the scope its own session pool lives at.
 */
export class TransportEvidenceRelay implements TransportEvidenceReporter {
  private target: TransportEvidenceReporter | null = null;

  /**
   * Points the relay at `target` and returns the unbind. A second bind
   * replaces the first outright rather than stacking - two live kernels for
   * one window is not a state this design has, and silently fanning out to
   * both would double every streak the authority counts.
   */
  bind(target: TransportEvidenceReporter): () => void {
    this.target = target;
    return () => {
      if (this.target === target) {
        this.target = null;
      }
    };
  }

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.sessionEstablished(hostId, sessionId, transportKind);
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.sessionLost(hostId, sessionId, transportKind);
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialSuccess(hostId, attemptId, transportKind);
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.target?.reportDialRefusal(
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    );
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialTimeout(hostId, attemptId, transportKind);
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialIndeterminate(hostId, attemptId, transportKind);
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.target?.reportCompatVerdict(input);
  }
}
