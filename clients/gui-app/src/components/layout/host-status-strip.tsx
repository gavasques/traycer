import { use, useCallback, type ReactNode } from "react";
import { PlugZap, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { hostFailureReportIssueAction } from "@/components/layout/host-failure-report";
import {
  presentsLocalHostLifecycle,
  useHostReadinessController,
  useSurfaceReadiness,
  type DefaultHostReadinessPresentation,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  deriveHostStatusStripState,
  useActiveHostLabel,
  useHostSwitchTarget,
} from "@/components/layout/host-status-strip-state";
import { HostCompatibilityContext } from "@/lib/host/compatibility-state";
import {
  isAnnouncedInterruption,
  useHostSessionConnectivity,
  useHostSessionWake,
  type HostSessionConnectivity,
} from "@/lib/host/session-connectivity";
import { cn } from "@/lib/utils";

/**
 * The ONE strip that states what the app-wide host connection is doing:
 * switching to another host, interrupted, degraded, or broken.
 *
 * It is also the single owner of the transport's own health, which is why
 * `disconnected` is a state HERE rather than a banner of its own. A dropped
 * session makes the compat probe fail, so a second row would paint its own
 * explanation of the same fault beside this one - and the row directly under
 * the app header is the only stable slot either could use. The states are
 * fed by two independent planes (see `deriveHostStatusStripState`); the
 * precedence between them is what keeps one fault to one line.
 *
 * It absorbs `HostConnectionDegradedBanner` (the traycer#860 held-verdict
 * strip) rather than sitting beside it - two owners of one row is how a
 * degraded connection and a switch end up stacked or fighting over the same
 * line. It also absorbs the recovery actions that used to require a
 * full-screen card: post-latch the gate no longer replaces the app for a
 * broken default host (`DefaultHostReadyGate`), so Retry and the pre-filled
 * report have to live somewhere inside a mounted app, and this is it.
 *
 * Why a strip is enough for the error states: tabs are bound to their host
 * for life, so a broken DEFAULT host does not invalidate a single open tab.
 * Default-host-scoped surfaces (composer, landing terminal) already project
 * their own in-surface fallbacks through `HostScopeReady` /
 * `SurfaceReadinessBoundary`; what they could not do is SAY why they went
 * quiet. That is this component's job.
 *
 * Reads the compat context directly rather than through
 * `useHostCompatibility` so a surface mounted outside the provider (test
 * harnesses, the gui-app dev preview) renders nothing instead of throwing.
 * The context decides whether this strip exists at all; every fact it states
 * comes from the readiness presentation, which is the same probe projected
 * once by the one controller.
 */
export function HostStatusStrip(): ReactNode {
  const compatibility = use(HostCompatibilityContext);
  const readiness = useSurfaceReadiness("default-host", null);
  const presentation = useHostReadinessController().defaultHostPresentation;
  const switchTarget = useHostSwitchTarget();
  const activeLabel = useActiveHostLabel();
  const connectivity = useHostSessionConnectivity();
  const wakeSession = useHostSessionWake();
  const retryCompatibility = presentation.compatibility.retry;
  // Both halves of one recovery, and neither is redundant. The wake collapses
  // the transport's pending backoff so the socket is re-established sooner than
  // its schedule intended; the probe is the request that then has to succeed
  // for every directory-plane state to settle. The probe alone would still have
  // to wait out the backoff, and the wake alone would leave a recovered session
  // sitting behind a stale failed verdict.
  const retryConnection = useCallback(() => {
    wakeSession();
    retryCompatibility();
  }, [wakeSession, retryCompatibility]);
  const state = deriveHostStatusStripState({
    switching: switchTarget !== null,
    sessionInterrupted: isAnnouncedInterruption(connectivity),
    readinessKind: readiness.kind,
    compatibility: presentation.compatibility,
  });
  if (compatibility === null) return null;
  if (state === "hidden") return null;
  if (state === "directory") {
    return (
      <HostStatusStripFrame state="directory">
        <HostStatusStripDirectoryContent
          readiness={readiness}
          presentation={presentation}
        />
      </HostStatusStripFrame>
    );
  }
  if (state === "error") {
    return (
      <HostStatusStripFrame state="error">
        <HostStatusStripErrorContent
          readiness={readiness}
          presentation={presentation}
        />
      </HostStatusStripFrame>
    );
  }
  const label = switchTarget?.label ?? activeLabel;
  // The session-plane recovery is not `waitingRetryAction`'s to choose. That
  // helper picks between a local-host respawn and a probe re-run, and neither
  // touches the socket this state is about. `retrying` is still the honest
  // pending flag, because the probe is half of what the retry issues.
  const waitingRetry =
    state === "disconnected"
      ? {
          onClick: retryConnection,
          pending: presentation.compatibility.retrying,
        }
      : waitingRetryAction(readiness.kind, presentation);
  return (
    <HostStatusStripFrame state={state}>
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {describeWaitingMessage({
          state,
          connectivity,
          fromSwitchGesture: switchTarget !== null,
          label,
        })}
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="host-status-strip-spinner"
        variant={undefined}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-current"
        data-testid="host-status-strip-retry"
        disabled={waitingRetry.pending}
        onClick={waitingRetry.onClick}
      >
        Retry now
      </Button>
    </HostStatusStripFrame>
  );
}

/**
 * Which recovery "Retry now" issues while the strip is waiting.
 *
 * The amber states are not one situation. A local host that is still starting,
 * stalled, or dead needs its PROCESS brought back - `requestRespawn`, exactly
 * what the full-screen cards this strip replaced put behind their Retry
 * (`loadingFallback` and `unavailableFallback` both wire it). Re-running the
 * compatibility probe against a process that is not there answers the same
 * nothing, however many times it is clicked.
 *
 * Everything else amber - an explicit switch, `restoring-request-context`, and
 * the still-dialing compat probe - is a CONNECTION question, and respawning the
 * local host for one of those would be both useless and wrong. Those keep the
 * probe retry.
 *
 * The target check is not redundant with the kind check. `unavailable-host` is
 * ALSO what a selected remote host reports once it loses its dialable endpoint
 * with no failover target, and that is the case where a respawn silently acts
 * on the wrong machine.
 */
function waitingRetryAction(
  kind: SurfaceReadiness["kind"],
  presentation: DefaultHostReadinessPresentation,
): { readonly onClick: () => void; readonly pending: boolean } {
  const localLifecycleWait =
    kind === "loading-host" ||
    kind === "provisioning-host" ||
    kind === "unavailable-host";
  // The readiness kind alone is NOT enough to authorize a respawn.
  // `unavailable-host` is also what a selected REMOTE host reports once it
  // loses its dialable endpoint with no failover target, and respawning then
  // restarts the host on THIS computer while leaving the host the user is
  // actually pointed at untouched. `presentsLocalHostLifecycle` is the
  // codebase's own answer to "do these lifecycle actions belong to this
  // target", including the unresolved-boot case that bare `targetKind` misses.
  if (localLifecycleWait && presentsLocalHostLifecycle(presentation)) {
    return {
      onClick: presentation.requestRespawn,
      pending: presentation.respawnPending,
    };
  }
  // `retrying` is the compat probe's own in-flight flag, the same one the
  // error strip's Retry already consumes. Hardcoding `false` here left the
  // amber "Retry now" enabled while the retry it just issued was still
  // running, so a second click re-fired a probe that was already in flight.
  return {
    onClick: presentation.compatibility.retry,
    pending: presentation.compatibility.retrying,
  };
}

/**
 * `directory`, `switching`, `disconnected` and `degraded` keep the
 * amber/`PlugZap` treatment the degraded banner shipped with - none of them is
 * a broken host. `error` is the one state where the app is pointed at a host it
 * cannot use, so it earns the destructive palette.
 */
function HostStatusStripFrame(props: {
  readonly state:
    "directory" | "switching" | "disconnected" | "degraded" | "error";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <output
      aria-label={STRIP_ARIA_LABEL[props.state]}
      data-testid="host-status-strip"
      data-state={props.state}
      className={cn(
        "flex w-full items-center gap-2 border-b px-3 py-1.5 text-ui-xs",
        props.state === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100",
      )}
    >
      {props.children}
    </output>
  );
}

const STRIP_ARIA_LABEL: Readonly<Record<string, string>> = {
  directory: "No Traycer Host connected",
  switching: "Switching Traycer Host",
  disconnected: "Connection to Traycer Host interrupted",
  degraded: "Traycer Host connection degraded",
  error: "Traycer Host is unavailable",
};

/**
 * One line for each of the amber waits.
 *
 * `disconnected` names the CONNECTION and never the host, because the
 * connection is the only thing it can prove. The verdict behind it means one
 * thing: this client's own session is not carrying frames. That is true when
 * the phone's link died with the host perfectly healthy, and equally true when
 * the relay reports the host's uplink gone - the session cannot tell those
 * apart, and neither reading licenses a claim about the host. Wording that
 * named the host would be a guess, and wrong half the time it mattered. Host
 * presence is stated elsewhere, by the surfaces that actually know it.
 *
 * It has two rungs and they are not interchangeable. The first promises
 * nothing about the tap: a retry pulls the redial forward, but a redial that
 * fails re-arms at the escalated backoff, so re-entering this same line is a
 * normal outcome. The second exists because a message that never changes stops
 * being read - an outage that has run for a while must not keep describing
 * itself in the words of one that is about to clear. Both keep the retry and
 * the spinner: the transport genuinely is still trying in either.
 *
 * The switch signal names the host the user picked; a readiness-driven wait
 * (a local host respawning, a request context being restored) has no such
 * gesture behind it, so it says what it is instead of claiming a switch
 * nobody asked for.
 */
function describeWaitingMessage(args: {
  readonly state: "switching" | "disconnected" | "degraded";
  readonly connectivity: HostSessionConnectivity;
  readonly fromSwitchGesture: boolean;
  readonly label: string | null;
}): string {
  if (args.state === "disconnected") {
    return args.connectivity === "interrupted-prolonged"
      ? "Still can't connect - retrying."
      : "Connection interrupted - reconnecting…";
  }
  if (args.state === "degraded") {
    return "Traycer Host is not responding. Your work is still open - reconnecting.";
  }
  const host = args.label ?? "Traycer Host";
  return args.fromSwitchGesture
    ? `Switching to ${host}…`
    : `Connecting to ${host}…`;
}

/**
 * The post-latch face of the three relay-only no-selection states.
 *
 * Cold start still gets their full-screen surfaces - the searching screen, the
 * no-host screen, and the `ChooseHostSurface` wall - because nothing is mounted
 * yet to preserve. Once the app has painted, the same three facts have to be
 * stated inside a live window: tabs stay bound to their own hosts and keep
 * working, and unmounting to announce that the DEFAULT selection went away
 * throws out editors, terminals and scroll position for a condition one click
 * usually fixes.
 *
 * No ambient spinner, unlike the switching arm. Nothing is in flight here until
 * the user asks for it: these states are what the app settles on, and a
 * perpetual spinner would promise a retry that is not running. The action
 * carries its own pending state instead.
 */
function HostStatusStripDirectoryContent(props: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const directory = describeHostStatusStripDirectory(
    props.readiness.kind,
    props.presentation,
  );
  return (
    <>
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{directory.message}</span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-current"
        data-testid="host-status-strip-directory-action"
        disabled={directory.action.pending}
        onClick={directory.action.onClick}
      >
        <span className="inline-flex items-center gap-1.5">
          <span>{directory.action.label}</span>
          {directory.action.pending ? (
            <AgentSpinningDots
              className="size-3"
              testId="host-status-strip-directory-spinner"
              variant={undefined}
            />
          ) : null}
        </span>
      </Button>
    </>
  );
}

/**
 * One line and one recovery per directory state.
 *
 * `choose-host` gets the PICKER, not the wall. The full-screen wall is the
 * cold-start surface - it exists because a shell with nothing on screen has
 * room to ask a question properly - while `openHostPicker` is #1133's
 * running-app switcher, which is the affordance a user already has a window
 * full of work behind. The other two get the registry re-read, wired to the
 * shared coalesced lock so a click during the background poll shows the fetch
 * it joined rather than pretending to start a second one.
 *
 * Copy is kept in step with the full-screen surfaces (`fallbackContent`): a
 * user who saw "Looking for your hosts…" at launch must not meet different
 * words for the same condition an hour later.
 */
function describeHostStatusStripDirectory(
  kind: SurfaceReadiness["kind"],
  presentation: DefaultHostReadinessPresentation,
): {
  readonly message: string;
  readonly action: HostStatusStripAction;
} {
  if (kind === "choose-host") {
    return {
      message: "Choose a host to continue.",
      action: {
        label: "Choose host",
        pending: false,
        onClick: presentation.openHostPicker,
      },
    };
  }
  const refresh: HostStatusStripAction = {
    label: "Refresh",
    pending: presentation.directoryRefreshing,
    onClick: presentation.refreshDirectory,
  };
  if (kind === "mobile-no-host") {
    return {
      message:
        "No host connected. Connect a host from this device to continue.",
      action: refresh,
    };
  }
  // Only `searching-hosts` is left: the registry has not answered yet, so the
  // emptiness means nobody has managed to ask rather than "you own no hosts".
  return { message: "Looking for your hosts…", action: refresh };
}

function HostStatusStripErrorContent(props: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const error = describeHostStatusStripError(
    props.readiness.kind,
    props.presentation,
  );
  return (
    <>
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {error.message}
        {error.detail === null ? null : (
          <span
            className="ml-1 opacity-80"
            data-testid="host-status-strip-detail"
          >
            {error.detail}
          </span>
        )}
      </span>
      {error.action === null ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-current"
          disabled={error.action.pending}
          data-testid="host-status-strip-retry"
          onClick={error.action.onClick}
        >
          <span className="inline-flex items-center gap-1.5">
            <span>{error.action.label}</span>
            {error.action.pending ? (
              <AgentSpinningDots
                className="size-3"
                testId="host-status-strip-retry-spinner"
                variant={undefined}
              />
            ) : null}
          </span>
        </Button>
      )}
      {error.report === null
        ? null
        : hostFailureReportIssueAction({
            title: error.report.title,
            message: error.report.message,
            code: error.report.code,
            source: error.report.source,
            presentation: props.presentation,
            includeRetainedProgress: error.report.includeRetainedProgress,
          })}
    </>
  );
}

interface HostStatusStripAction {
  readonly label: string;
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface HostStatusStripReport {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly source: string;
  readonly includeRetainedProgress: boolean;
}

interface HostStatusStripError {
  readonly message: string;
  readonly detail: string | null;
  readonly action: HostStatusStripAction | null;
  readonly report: HostStatusStripReport | null;
}

/**
 * The same failure families the full-screen fallbacks describe, in one line.
 * Copy, report code and `source` are kept IDENTICAL to those cards
 * (`fallbackContent`) - a user filing from the strip and a user filing from a
 * cold-start card are reporting the same thing, and triage keys off those
 * fields (traycer#858 / #860 / #862).
 *
 * Readiness kinds are consulted first because a LOCAL target projects its
 * lifecycle into them. A remote (or unresolved) target never does - readiness
 * stays `ready` while its probe fails - so the compat verdict is the fallback
 * source, which is precisely the direction that used to fail silently.
 */
function describeHostStatusStripError(
  kind: SurfaceReadiness["kind"],
  presentation: DefaultHostReadinessPresentation,
): HostStatusStripError {
  if (kind === "provisioning-error") {
    return {
      message:
        presentation.provisioningError?.message ??
        "Could not start Traycer Host.",
      detail: null,
      action: {
        label: "Retry",
        pending: presentation.provisioning,
        onClick: presentation.retryProvisioning,
      },
      report: {
        title: "Could not start Traycer Host",
        message: "Traycer Host could not start.",
        code: "HOST_PROVISIONING_FAILED",
        source: "Host startup",
        // The one report the retained stage explains: this state is reached
        // only while the converge error that produced it is still live.
        includeRetainedProgress: true,
      },
    };
  }
  if (kind === "removed-host") {
    return {
      message:
        "You removed Traycer's background components, so the host won't start.",
      detail: null,
      action: {
        label: "Reinstall",
        pending: false,
        onClick: presentation.reinstall,
      },
      report: null,
    };
  }
  if (kind === "incompatible-host" || isIncompatible(presentation)) {
    return {
      message: "Host update required",
      detail: presentation.compatibility.errorMessage,
      action: presentation.canManageHost
        ? {
            label: "Update host",
            pending: false,
            onClick: presentation.forceProvisioning,
          }
        : {
            label: "Retry",
            pending: false,
            onClick: presentation.compatibility.retry,
          },
      report: {
        title: "Host update required",
        message: "Traycer Host requires an update.",
        code: "HOST_INCOMPATIBLE",
        source: "Host compatibility",
        includeRetainedProgress: false,
      },
    };
  }
  // Everything else that reaches the error state is a settled compat failure:
  // `compatibility-error` for a local target, or a `failed` verdict under a
  // readiness that stayed `ready` (remote / unresolved).
  const unreachable = presentation.compatibility.unreachable;
  return {
    message: unreachable
      ? "Traycer Host is not responding."
      : "Could not verify host compatibility.",
    detail: presentation.compatibility.errorMessage,
    action: {
      label: "Retry",
      pending: presentation.compatibility.retrying,
      onClick: presentation.compatibility.retry,
    },
    report: {
      title: unreachable
        ? "Traycer Host is not responding"
        : "Could not verify Traycer Host compatibility",
      message: unreachable
        ? "The app could not reach Traycer Host."
        : "Traycer Host rejected the compatibility handshake.",
      code: unreachable ? "HOST_UNREACHABLE" : "HOST_COMPAT_PROBE_REJECTED",
      // Not a startup failure: this is a host that was already serving and
      // stopped answering (traycer#860).
      source: "Host connection",
      includeRetainedProgress: false,
    },
  };
}

function isIncompatible(
  presentation: DefaultHostReadinessPresentation,
): boolean {
  return presentation.compatibility.status === "incompatible";
}
