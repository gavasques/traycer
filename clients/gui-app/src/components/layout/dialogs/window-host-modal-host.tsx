import { type ReactNode } from "react";
import { WindowHostModal } from "@/components/layout/dialogs/window-host-modal";
import {
  presentsLocalHostLifecycle,
  useHostReadinessController,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";
import { BootstrapAttemptDetails } from "@/components/host/bootstrap-attempt-details";
import { summariseBootstrapAttempts } from "@/components/host/bootstrap-attempt-summary";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { useHostProvisioningProgress } from "@/hooks/host/use-host-provisioning-progress";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";
import { useWindowNarration } from "@/hooks/host/use-window-narration";
import { getClientAppVersion } from "@/lib/app-version";
import type { HostProgressView } from "@/lib/host/host-progress-copy";
import {
  hostUpdateActionApplies,
  type WindowNarrationCause,
  type WindowNarrationState,
  type WindowNarrationVariant,
} from "@/lib/host/window-narration";

/**
 * The window narrator's HOME: the one place that decides whether the modal is
 * on screen, and the mount point the local-host lifecycle re-parents into.
 *
 * Mounted once per window, OUTSIDE the readiness gate (the gate replaces its
 * children during cold start, so a modal mounted inside it could never narrate
 * the cold start it exists for) and inside the router, which is what lets the
 * `/settings` bypass below be a route question.
 *
 * P3.4's re-parent seam, stated so the move is mechanical: today the recovery
 * actions come from the readiness controller's presentation, which is where
 * `HostProvisioningController` currently projects them. When that controller
 * moves here, wrap this component's body in it and read `lifecycle.provisioning`
 * in place of `presentation` - the fields consumed below (`retryProvisioning`,
 * `forceProvisioning`, `canManageHost`, `configureShell`, `refreshDirectory`,
 * `openSettings`, `provisioning`) are already exactly the shape it hands back,
 * so nothing here has to be rewritten to accept it. Progress deliberately does
 * NOT come through that presentation even now: see `useHostProvisioningProgress`.
 */
export function WindowHostModalHost(props: {
  /**
   * The caller's routing-aware answer to "is this a host-independent route".
   *
   * Injected rather than read from the router here, following the same rule
   * the readiness gate's `bypass` prop states: ONE routing-aware computation
   * drives the narrators instead of each layer re-deriving it. It also keeps
   * this component mountable in the trees that exercise host lifecycle
   * without a router.
   *
   * Settings is the escape hatch for a host that cannot start - its Shell page
   * edits the launch config through the CLI, with no running host involved -
   * so the narrator steps aside there. The modal's own "Open settings" action
   * is what sends a user there in the first place.
   */
  readonly bypassed: boolean;
}): ReactNode {
  const narration = useWindowNarration();

  if (narration.kind === "silent") return null;
  if (props.bypassed) return null;
  return <NarratingWindowHostModal narration={narration} />;
}

/**
 * Everything the modal needs to DRAW, read only once it is actually drawing.
 *
 * Split from the component above so that a silent narrator - which is every
 * window, almost all of the time - reads nothing but the authority projection.
 * That is not a micro-optimization: this mounts at the app root, and reading
 * the host controller's lane unconditionally there made the ROOT depend on
 * `RunnerHostProvider`, so two root-route suites that had never needed one
 * lost their whole tree to a throw. Narrowing the dependency to the narrating
 * case is the honest contract - the lane is only interesting when there is
 * something to say about it.
 */
function NarratingWindowHostModal(props: {
  readonly narration: Extract<
    WindowNarrationState,
    { readonly kind: "narrating" }
  >;
}): ReactNode {
  const { narration } = props;
  const progress = useHostProvisioningProgress();
  const presentation = useHostReadinessController().defaultHostPresentation;
  const localLifecycle = presentsLocalHostLifecycle(presentation);
  const retry = resolveRetry(narration.variant, presentation, localLifecycle);
  return (
    <WindowHostModal
      cause={narration.cause}
      variant={narration.variant}
      progress={progress}
      localBootstrapBody={buildLocalBootstrapBody({
        variant: narration.variant,
        presentation,
        localLifecycle,
        progress,
        cause: narration.cause,
      })}
      onRetry={retry.onRetry}
      retryPending={retry.pending}
      onUpdateHost={resolveUpdateHost(narration.variant, presentation)}
      onOpenSettings={presentation.openSettings}
    />
  );
}

interface ResolvedRetry {
  readonly onRetry: (() => void) | null;
  readonly pending: boolean;
}

/**
 * Which recovery this state actually has, and whether it has one at all.
 *
 * `plan-restricted` gets NO retry, deliberately: the hosts are healthy and
 * running on their own machines, and a Retry there is a button that can only
 * ever fail while implying the failure is transient. The upgrade action is the
 * whole answer. `update-host` likewise - retrying a version disagreement just
 * re-reads the same versions.
 *
 * For `offline` the answer depends on whose machine this is. When the app
 * manages this machine's host, re-running the install/start is a real recovery
 * (the user-initiated half of provisioning that survived the automatic
 * converge's retirement). When it does not - a fleet of remote machines this
 * app cannot start - the only honest retry is re-reading the registry.
 */
function resolveRetry(
  variant: WindowNarrationVariant,
  presentation: DefaultHostReadinessPresentation,
  localLifecycle: boolean,
): ResolvedRetry {
  if (variant.kind !== "offline") return { onRetry: null, pending: false };
  if (localLifecycle && presentation.canManageHost) {
    return {
      onRetry: presentation.retryProvisioning,
      pending: presentation.provisioning,
    };
  }
  return { onRetry: presentation.refreshDirectory, pending: false };
}

function resolveUpdateHost(
  variant: WindowNarrationVariant,
  presentation: DefaultHostReadinessPresentation,
): (() => void) | null {
  if (variant.kind !== "update-host") return null;
  if (!presentation.canManageHost) return null;
  if (!hostUpdateActionApplies(variant.detail, getClientAppVersion())) {
    return null;
  }
  return presentation.forceProvisioning;
}

/**
 * The rich local-bootstrap body, or null when this wait is not about this
 * machine.
 *
 * Only the `offline` variant gets it: a plan gate and a version mismatch are
 * both about a host that is up and answering, so a bootstrap log and a
 * "Configure shell…" button would be diagnostics for a failure that did not
 * happen.
 *
 * `LocalHostLoadingContent` is rendered at `stage="loading"` on purpose - its
 * slow-stage branch draws its own Retry, and a modal states its actions in one
 * row rather than two places. The spawn diagnostics that branch also carries
 * are NOT dropped with it: they are drawn beside it by `LocalBootstrapAttempts`
 * below, on the arm where they are true. That the bootstrap.log path survives
 * this move is the whole point - it is the one thing that lets a user take a
 * stuck startup somewhere else, and it has been orphaned by a surface move
 * once already.
 */
function buildLocalBootstrapBody(args: {
  readonly variant: WindowNarrationVariant;
  readonly presentation: DefaultHostReadinessPresentation;
  readonly localLifecycle: boolean;
  readonly progress: HostProgressView | null;
  readonly cause: WindowNarrationCause;
}): ReactNode | null {
  if (args.variant.kind !== "offline") return null;
  if (!args.localLifecycle) return null;
  return (
    <>
      <LocalHostLoadingContent
        stage="loading"
        progress={args.progress}
        onConfigureShell={args.presentation.configureShell}
        onRetry={args.presentation.requestRespawn}
        retryPending={args.presentation.respawnPending}
      />
      {/* Only once nothing can serve the window. Under a cold start that is
          still progressing there is no failed attempt to explain, and shell
          and exit-code detail beneath a healthy spinner reads as an error. */}
      {args.cause === "no-usable-host" ? <LocalBootstrapAttempts /> : null}
    </>
  );
}

/**
 * What the last bootstrap attempt tried, and where the full log lives.
 *
 * A single read, not a poll: while a user is staring at a failure card there
 * is nothing to gain from re-running the CLI underneath them, and the recovery
 * actions invalidate this query when they fire.
 */
function LocalBootstrapAttempts(): ReactNode {
  const status = useRunnerTraycerHostStatusQuery({ pollIntervalMs: null });
  if (status.data === undefined) return null;
  const summary = summariseBootstrapAttempts(status.data.bootstrapMarkers);
  if (summary === null) return null;
  return (
    <BootstrapAttemptDetails
      summary={summary}
      bootstrapLogPath={status.data.bootstrapLogPath}
    />
  );
}
