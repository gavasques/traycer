import type {
  SelectionAuthorityClient,
  SelectionChange,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  SelectionEvidenceKernel,
  type SelectionKernelSnapshot,
} from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger, type AppLogValue } from "@/lib/logger";
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

export interface SelectionAuthorityBridge {
  dispose(): void;
}

export interface SelectionAuthorityBridgeOptions {
  readonly client: SelectionAuthorityClient;
  readonly directory: SelectionDirectoryBinding;
  /** Stamps evidence reports. Ordering comes from revisions, never this. */
  readonly now: () => number;
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
  const kernel = new SelectionEvidenceKernel({
    client: options.client,
    now: options.now,
    log: bridgeAuthorityLog,
  });

  const apply = (snapshot: SelectionKernelSnapshot): void => {
    // Store BEFORE the bind: the directory fans out to `HostRuntime`
    // synchronously, and a consumer re-rendering off that bind must not read
    // an `effectiveHostId` this window has already superseded.
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
    options.directory.selectById(snapshot.effectiveHostId);
  };

  const subscriptions: SelectionSubscription[] = [
    kernel.onChange(apply),
    subscribeNarration(options.client),
  ];

  void kernel.start().then((result) => {
    if (result.ok) {
      return;
    }
    // Terminal for this generation by contract - the kernel has already
    // published the detached snapshot, which this bridge has already turned
    // into an unbound directory. Recovery is a fresh load or the next
    // `reattachRequired`, never a retry here.
    appLogger.warn("[selection-bridge] authority attach refused", {
      kind: result.kind,
    });
  });

  apply(kernel.snapshot());

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      kernel.dispose();
      useSelectionAuthorityStore.getState().reset();
    },
  };
}

/**
 * Narration only - never a selection write. `previousEffectiveHostId` comes
 * from the event rather than from a locally remembered value because the
 * authority is the one that knows what it moved the window off: a preferred
 * or target change that leaves `effective` untouched still emits, and must
 * stay silent here.
 */
function subscribeNarration(
  client: SelectionAuthorityClient,
): SelectionSubscription {
  let narratedRevision = -1;
  return client.onSelectionChanged((event) => {
    if (event.revision <= narratedRevision) {
      return;
    }
    narratedRevision = event.revision;
    narrate(event.change);
  });
}

function narrate(change: SelectionChange): void {
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
  if (change.cause === "failover") {
    Analytics.getInstance().track(AnalyticsEvent.HostFailover, null);
    return;
  }
  if (change.cause === "recovery") {
    Analytics.getInstance().track(AnalyticsEvent.HostRecovered, null);
  }
}

const bridgeAuthorityLog: AuthorityLog = {
  debug: (message, detail) => {
    appLogger.debug(message, loggable(detail));
  },
  warn: (message, detail) => {
    appLogger.warn(message, loggable(detail));
  },
};

/**
 * The authority's log detail is `Record<string, unknown>`; the app logger
 * takes structured values. Anything outside that vocabulary is JSON-encoded
 * rather than dropped - a diagnostic that silently loses its subject is worse
 * than one that prints a shape. `JSON.stringify`, not `String(...)`: the
 * kernel's details are plain objects, which stringify to `[object Object]`
 * and would take the field's meaning with them.
 */
function loggable(detail: Record<string, unknown>): Record<string, AppLogValue> {
  const fields: Record<string, AppLogValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      fields[key] = value;
      continue;
    }
    fields[key] = describeLogValue(value);
  }
  return fields;
}

function describeLogValue(value: unknown): string {
  // Primitives are already handled by the caller, so what is left is an
  // object/array (encode it) or a type that has no useful log form at all
  // (name the type - a `[function]` in a diagnostic is a bug report, and
  // `JSON.stringify` would answer `undefined` for it).
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable";
  }
}
