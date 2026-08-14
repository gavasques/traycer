import {
  use,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  postLatchSurfaceFor,
  type DefaultHostReadinessPresentation,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  hostStatusProbeQueryKey,
  isPendingHostProbeError,
} from "@/lib/host/compatibility-state";
import { useHostBinding } from "@/lib/host/runtime";

/**
 * The states of the one host status strip (D3). `directory`, `switching`,
 * `disconnected` and `degraded` share the amber treatment; `error` is the red
 * variant carrying the recovery action that used to live on the full-screen
 * card.
 *
 * Every state but `disconnected` is fed by the DIRECTORY plane - the registry's
 * view of the host plus the compatibility probe. `disconnected` is the SESSION
 * plane: this device's own transport. The two are independent and routinely
 * disagree.
 */
export type HostStatusStripState =
  "directory" | "switching" | "disconnected" | "degraded" | "error" | "hidden";

/**
 * Precedence is
 * `directory > switching > disconnected > checking > error > degraded`, and
 * that ordering is the anti-flash rule, not a stylistic preference.
 *
 * A switch to a remote host produces, in order: a `host-bound` change, a
 * still-dialing compat probe, then a verdict. If a transient dial failure
 * could paint the red variant, every remote switch would blink
 * amber -> red -> hidden. Two things prevent that: a still-dialing probe now
 * reports `checking` rather than `failed` (see `isPendingHostProbeError`), and
 * `switching` wins outright while it is live. `error` renders only once the
 * switch signal has cleared - i.e. the probe settled - and what it settled on
 * is bad.
 *
 * `sessionInterrupted` sits where it does for the same anti-flash reason, from
 * the other side. It ranks BELOW an explicit switch, which is a gesture the
 * user just made and which owns the row while it resolves - a session dialing
 * for a host the user picked a second ago is not an interruption. It ranks
 * ABOVE the `checking` arm and everything below it because a dropped session
 * is what MAKES those states: the probe is a host RPC, so a dead transport
 * leaves it in flight, then failing, then held-degraded. Any of them reported
 * first would name the wrong plane's fault - the host is usually fine and
 * still heartbeating Online in the directory - and none of their recoveries
 * touches the socket. Ranking them above would also flip the row between two
 * explanations of one fault as the probe retried.
 *
 * Reads the compat facts off the READINESS PRESENTATION rather than the
 * compat context, so the state and the strip's copy can never disagree: they
 * are the same projection of the same probe (the controller memoizes it from
 * the context value). The context is still what decides whether the strip
 * mounts at all.
 */
export function deriveHostStatusStripState(args: {
  /** A host-bound switch whose new host has not settled a verdict yet. */
  readonly switching: boolean;
  /**
   * This device's transport to the active host attached at least once and is
   * not attached now. Never true outside the installed mobile app.
   */
  readonly sessionInterrupted: boolean;
  readonly readinessKind: SurfaceReadiness["kind"];
  readonly compatibility: DefaultHostReadinessPresentation["compatibility"];
}): HostStatusStripState {
  const surface = postLatchSurfaceFor(args.readinessKind);
  // Outright first, above even a live switch signal. Every other arm below
  // describes the host this app is POINTED AT; `directory` is the one state
  // where it is pointed at nothing - no selection, and no row to select. The
  // compat facts the arms below read still hold the last host's answer, so a
  // deregistered selection would otherwise paint "Traycer Host is not
  // responding" plus a probe Retry for a host that no longer exists, and an
  // unbound session with a probe still in flight would paint "Connecting to
  // Traycer Host…" with nothing to connect to. Both name the wrong problem and
  // offer a recovery that cannot resolve it. In practice the switch signal is
  // already clear here - `useHostSwitchTarget` drops its target on the very
  // `host-unbound` that produces these states - so this is precedence stated,
  // not a race being arbitrated.
  if (surface === "directory") return "directory";
  if (args.switching || surface === "switching") return "switching";
  if (args.sessionInterrupted) return "disconnected";
  // No answer for this host YET (the probe is in flight, or still dialing
  // under D5.1's pending-class classification). For a remote target readiness
  // is already `ready` - the relay attach is lazy and per-request - so this is
  // the only signal that the app is not actually talking to the host it is
  // pointed at.
  if (args.compatibility.status === "checking") return "switching";
  if (surface === "error") return "error";
  if (
    args.compatibility.status === "failed" ||
    args.compatibility.status === "incompatible"
  ) {
    return "error";
  }
  // Whatever is left is a `compatible` verdict; `degraded` means it is being
  // HELD through a failed refetch (traycer#860) rather than freshly answered.
  if (args.compatibility.degraded) return "degraded";
  return "hidden";
}

export interface HostSwitchTarget {
  readonly hostId: string;
  readonly label: string;
}

/**
 * The switch half of the strip's composite trigger.
 *
 * Readiness kinds alone can never announce a local -> remote switch:
 * `projectDefaultHostReadiness` passes non-local targets through, and raw
 * readiness is `ready` the moment the entry is dialable (relay attach is
 * per-request and lazy). So the transition is taken from the binding itself -
 * `HostClient.emitChange` with `reason: "host-bound"` - and held until the
 * host we switched TO has settled a verdict.
 *
 * "Settled" is read from that host's own probe cache slot rather than from
 * `useHostCompatibility()`, which answers for whichever host is active at
 * render time: one render after the bind that value can still be the PREVIOUS
 * host's `compatible`, which would clear the signal before the strip ever
 * appeared. A verdict already held for the target (D2's session-lived cache)
 * settles it in the same render - which is exactly what makes A -> B -> A
 * silent instead of flashing a strip nobody needed.
 */
export function useHostSwitchTarget(): HostSwitchTarget | null {
  const binding = useHostBinding();
  const hostClient = binding === null ? null : binding.hostClient;
  // Read through the context rather than `useQueryClient()`, which THROWS
  // without a provider. The banner this strip absorbed rendered fine in
  // harnesses that mount `AppShell` with no query client, and quietly making
  // the app shell un-mountable without one is not a change this ticket is
  // entitled to make. No client simply means the probe cache is unobservable
  // here: the switch trigger stays silent, and the readiness/compat-driven
  // states still work.
  const queryClient = use(QueryClientContext);
  // The last host we were switched TO. Written only from the binding's own
  // change callback: set on `host-bound`, cleared on `host-unbound`. Whether
  // a set target is still SWITCHING is not stored - it is derived below from
  // that host's probe - so there is no second piece of state to keep in sync
  // (and no `setState` in an effect body).
  const [lastBound, setLastBound] = useState<HostSwitchTarget | null>(null);
  useEffect(() => {
    if (hostClient === null) return;
    return hostClient.onChange((event) => {
      // An unbind ENDS any switch in progress. Without this the strip latched
      // forever on a host that went away mid-switch (bind B, B's row is then
      // removed or explicitly cleared before its probe settles): `lastBound`
      // stayed set, `settled` stayed false, and `switching` precedence then
      // suppressed the very error the user needed to see.
      if (event.reason === "host-unbound" || event.currentHostId === null) {
        setLastBound(null);
        return;
      }
      // Only a genuine host swap. `host-updated` (same host, new endpoint),
      // `auth-changed` and `availability-recovered` are not switches.
      if (event.reason !== "host-bound") return;
      const entry = hostClient.getActiveHost();
      if (entry === null) return;
      setLastBound({ hostId: event.currentHostId, label: entry.label });
    });
  }, [hostClient]);

  // Subscribed to the query cache ONLY while a switch is outstanding: with no
  // pending target this hook must not re-render the strip on every cache
  // event in the app.
  const subscribeToProbe = useCallback(
    (onStoreChange: () => void) => {
      if (lastBound === null || queryClient === undefined) {
        return () => undefined;
      }
      return queryClient.getQueryCache().subscribe(onStoreChange);
    },
    [lastBound, queryClient],
  );
  const readSettled = useCallback(() => {
    if (lastBound === null || queryClient === undefined) return true;
    return hasSettledHostStatusProbe(queryClient, lastBound.hostId);
  }, [lastBound, queryClient]);
  const settled = useSyncExternalStore(
    subscribeToProbe,
    readSettled,
    readSettled,
  );

  if (lastBound === null || settled || hostClient === null) return null;
  // Defensive second gate on the SAME question the unbind branch answers, for
  // any path that moves the binding without an event this hook saw (a
  // subscription that attached late, a rebind during teardown). Announcing a
  // switch to a host the client is no longer pointed at is worse than
  // announcing nothing. Either guard alone clears the unbind case; both are
  // kept because they fail differently - one is event-driven, one is a live
  // read of the binding.
  if (hostClient.getActiveHostId() !== lastBound.hostId) return null;
  return lastBound;
}

/** The active host's own label, re-read on every binding change. */
export function useActiveHostLabel(): string | null {
  const binding = useHostBinding();
  const hostClient = binding === null ? null : binding.hostClient;
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (hostClient === null) return () => undefined;
      return hostClient.onChange(onStoreChange);
    },
    [hostClient],
  );
  const getSnapshot = useCallback(() => {
    if (hostClient === null) return null;
    const entry = hostClient.getActiveHost();
    return entry === null ? null : entry.label;
  }, [hostClient]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether this host's compat probe has produced an ANSWER - a verdict (fresh
 * or held) or a settled failure. A pending-class transport error is not an
 * answer: the session is still dialing, and treating it as one is what turned
 * a mid-dial remote switch into a red card.
 */
function hasSettledHostStatusProbe(
  queryClient: QueryClient,
  hostId: string,
): boolean {
  const state = queryClient.getQueryState(hostStatusProbeQueryKey(hostId));
  if (state === undefined) return false;
  if (state.data !== undefined) return true;
  return state.status === "error" && !isPendingHostProbeError(state.error);
}
