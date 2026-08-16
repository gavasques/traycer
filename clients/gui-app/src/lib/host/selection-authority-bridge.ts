import type {
  SelectionAuthorityClient,
  SelectionChange,
  SelectionRevisioned,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type {
  SelectionEvidenceKernel,
  SelectionKernelSnapshot,
} from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { toastSelectionSwitched } from "@/lib/host/selection-switch-toast";
import { appLogger } from "@/lib/logger";
import { notifyEffectiveHostChanged } from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The one seam through which the authority's derivation reaches the
 * directory's binding. Deliberately the narrowest possible view of
 * `HostDirectoryService` - this bridge is allowed to move the app-wide
 * selection and to do nothing else.
 */
export interface SelectionDirectoryBinding {
  selectById(hostId: string | null): void;
}

/**
 * Read-only host labelling for the switch toast. DELIBERATELY separate from
 * {@link SelectionDirectoryBinding} rather than widening it: that binding is
 * the app's one sanctioned write path into the selection, and its narrowness
 * is the property P0.3's lint enforces. Narration needs a name, not a writer.
 */
export interface SelectionHostLabels {
  labelFor(hostId: string): string;
}

export interface SelectionAuthorityBridge {
  dispose(): void;
}

export interface SelectionAuthorityBridgeOptions {
  readonly client: SelectionAuthorityClient;
  /**
   * This window's kernel, ALREADY CONSTRUCTED AND STARTED by the composition
   * root (redesign P1.3). It is no longer built here because the transports
   * must be able to report into it before this bridge mounts: the buffering
   * client drops evidence produced before the attach begins, and the bridge
   * mounts only after `auth.start()` and `directory.start()` have resolved -
   * a window in which the very first dials happen. Owning the kernel one level
   * up also makes the subscribe-time apply below load-bearing rather than
   * decorative; see there.
   */
  readonly kernel: SelectionEvidenceKernel;
  readonly directory: SelectionDirectoryBinding;
  readonly hostLabels: SelectionHostLabels;
}

/**
 * Mounts this window's `SelectionEvidenceKernel` and wires its verdict into
 * the host directory (selection model §1, redesign P1.2).
 *
 * ONE-WAY, and that is the whole design. The authority derives
 * `effectiveHostId`; this bridge pushes it into `HostDirectoryService`, whose
 * `selectById` is now a pure setter, and `HostRuntime`'s existing
 * `onSelectionChange → HostClient.bind` wiring rebinds unchanged. Nothing
 * pushes back: a UI gesture that wants to move the app-wide selection calls
 * `SelectionAuthorityClient.activate(...)` and waits for the derivation to
 * come back down. This bridge is therefore the ONLY sanctioned `selectById`
 * caller in the app (P0.3's write-path lint is narrowed to this module), and
 * a second one would rebuild the five-entry-points defect the audit found.
 *
 * Two subscriptions, on purpose:
 *
 *  1. `kernel.onChange` drives the directory + the renderer's read store. The
 *     kernel is what reconciles the attach snapshot against replayed events
 *     per slice, so it - not the raw stream - is the authority on what this
 *     window currently believes.
 *  2. A raw `client.onSelectionChanged` drives narration (analytics + the G4
 *     following-surface reset). It exists because the kernel snapshot cannot
 *     carry `cause`: the engine's `resolveCause` is not reconstructible from
 *     the tuple (a `fleet-shift` can legally leave `effective !== target`,
 *     which a phase-transition guess would mis-report as a failover), and
 *     hanging the last cause off the snapshot would replay a stale one on
 *     every lease-only publish. It carries its OWN monotonic high-water mark,
 *     the same rule the kernel applies to its selection slice, so a replayed
 *     or reordered event narrates at most once.
 *
 * The current snapshot is applied at subscribe time. Under THIS construction
 * it is provably a no-op - the kernel is built here and started in the same
 * tick, and every publish path (attach settle, buffered replay, a client
 * event) is at least one microtask away - so what actually delivers the
 * opening binding is subscribing BEFORE `start()`. That ordering is the real
 * invariant, and it is what the bridge suite pins. The line stays because the
 * bridge's contract is "apply what the kernel already knows", and P1.3 wires
 * the evidence PRODUCERS (the remote-session connect loop, the local dial,
 * the compat probe) into the same kernel - the first construction that hands
 * this bridge a kernel someone else already attached is the one where an
 * unbound slot would otherwise wait for a change event that may never come.
 * Deliberately not "covered" by contorting a test into reaching it (the
 * confirmed-dead-defensive rule).
 */
export function mountSelectionAuthorityBridge(
  options: SelectionAuthorityBridgeOptions,
): SelectionAuthorityBridge {
  const kernel = options.kernel;
  /**
   * The newest selection event this bridge has accepted for narration but not
   * yet narrated, because the kernel has not applied that revision here yet.
   * See {@link flushNarration}.
   */
  let pendingNarration: SelectionRevisioned<SelectionChange> | null = null;
  let narratedRevision = -1;

  /**
   * Narration runs only once the window's own state carries the revision being
   * narrated.
   *
   * Both paths call this because neither ordering can be assumed. Registration
   * order used to decide it: this bridge subscribed to the raw stream before
   * `kernel.start()` installed the kernel's, and buffered delivery preserves
   * insertion order, so `notifyEffectiveHostChanged` and the analytics event
   * both ran while the store and the directory still held the PREVIOUS
   * revision - a G4 subscriber re-reading either during its own reset saw
   * pre-move state. Gating on the applied revision instead of on subscription
   * order makes the invariant (store -> selectById -> fan-out) hold whichever
   * listener the client happens to call first.
   */
  const flushNarration = (appliedSelectionRevision: number): void => {
    const pending = pendingNarration;
    if (pending === null || pending.revision > appliedSelectionRevision) {
      return;
    }
    pendingNarration = null;
    narrate(pending.change, options.hostLabels);
  };

  const apply = (snapshot: SelectionKernelSnapshot): void => {
    // Store BEFORE the bind: the directory fans out to `HostRuntime`
    // synchronously, and a consumer re-rendering off that bind must not read
    // an `effectiveHostId` this window has already superseded.
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
    options.directory.selectById(snapshot.effectiveHostId);
    flushNarration(snapshot.selectionRevision);
  };

  const subscriptions: SelectionSubscription[] = [
    kernel.onChange(apply),
    options.client.onSelectionChanged((event) => {
      // Its OWN monotonic high-water, the same rule the kernel applies to its
      // selection slice, so a replayed or reordered event narrates at most
      // once. The raw stream is subscribed at all because the kernel snapshot
      // deliberately carries no `cause`: `resolveCause` is not reconstructible
      // from the tuple (a `fleet-shift` can legally leave `effective !==
      // target`, which a phase-transition guess would mis-report as a
      // failover), and hanging the last cause off the snapshot would replay a
      // stale one on every lease-only publish.
      if (event.revision <= narratedRevision) {
        return;
      }
      narratedRevision = event.revision;
      pendingNarration = event;
      flushNarration(kernel.snapshot().selectionRevision);
    }),
  ];

  // The kernel is already started, so its attach may well have settled before
  // this bridge existed - which makes this the line that delivers the opening
  // binding, not a defensive no-op. (While the bridge owned construction it
  // was provably unreachable: every publish path was at least a microtask
  // away from a kernel built and started in the same tick.)
  apply(kernel.snapshot());

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      useSelectionAuthorityStore.getState().reset();
    },
  };
}

function narrate(change: SelectionChange, hostLabels: SelectionHostLabels): void {
  if (change.effectiveHostId === change.previousEffectiveHostId) {
    return;
  }
  appLogger.debug("[selection-bridge] effective host changed", {
    cause: change.cause,
    from: change.previousEffectiveHostId,
    to: change.effectiveHostId,
    targetHostId: change.targetHostId,
  });
  // G4: a `null`-selection surface re-points and resets its host-dependent
  // state. Pinned instances ignore this by construction (D6).
  notifyEffectiveHostChanged(
    change.previousEffectiveHostId,
    change.effectiveHostId,
  );
  // The authority's own verdict, never re-derived here: `recovery` is
  // "landed back on the target", `failover` is "left it". Intent
  // (`HostSelected`) belongs to Settings ▸ Activate and is not fired from a
  // derivation, which is the conflation this split ends.
  const effectiveHostId = change.effectiveHostId;
  if (effectiveHostId !== null) {
    // ∅ has its own narrator - the global modal (D10) - and a toast saying
    // the app switched to nothing would compete with it.
    toastSelectionSwitched({
      cause: change.cause,
      previousEffectiveHostId: change.previousEffectiveHostId,
      hostLabel: hostLabels.labelFor(effectiveHostId),
    });
  }
  if (change.cause === "failover") {
    Analytics.getInstance().track(AnalyticsEvent.HostFailover, null);
    return;
  }
  if (change.cause === "recovery") {
    Analytics.getInstance().track(AnalyticsEvent.HostRecovered, null);
  }
}
