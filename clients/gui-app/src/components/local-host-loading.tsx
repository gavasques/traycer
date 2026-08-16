import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  HOST_PROGRESS_IDLE_HEADING,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { AppHeader } from "@/components/layout/header/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";
import { BootstrapAttemptDetails } from "@/components/host/bootstrap-attempt-details";
import { summariseBootstrapAttempts } from "@/components/host/bootstrap-attempt-summary";

export type LocalHostLoadingStage = "loading" | "slow";

export interface LocalHostLoadingProps {
  readonly stage: LocalHostLoadingStage;
  readonly progress: HostProgressView | null;
  /**
   * Called when the user clicks "Configure shell…". The caller drives
   * router navigation directly because the loading card is rendered
   * alongside the (unmounted) RouterProvider, so `<Link>` would not have
   * router context. Once navigation completes, the gate observes the
   * `/settings/shell` path and unmounts this card in favour of children.
   */
  readonly onConfigureShell: () => void;
}

/**
 * Poll cadence for the bootstrap.log tail while details are open. Tight
 * enough to feel live; only runs while the disclosure is expanded so the
 * CLI subprocess cost is paid only when the user is actively watching.
 */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

/**
 * Full-screen host-boot splash. Owns the outer app chrome (header + centered
 * card) and its own respawn mutation, then delegates everything inside the
 * card to `LocalHostLoadingContent`.
 *
 * NOT RENDERED IN PRODUCTION. `DefaultHostReadyGate` now supplies the
 * full-screen chrome and drives the body through `fallbackContent`, which
 * covers all eleven readiness kinds WITH their recovery actions - this wrapper
 * only ever expressed three. It is retained because `local-host-loading.test.tsx`
 * exercises the still-live `LocalHostLoadingContent` through it (identity badge,
 * slow-start Retry, download progress, setup copy). Re-point those at
 * `LocalHostLoadingContent` directly, then remove this.
 */
export function LocalHostLoading(props: LocalHostLoadingProps): ReactNode {
  const respawn = useRunnerRequestHostRespawn();

  return (
    <div
      data-testid="local-host-loading"
      data-stage={props.stage}
      className="flex min-h-svh w-full flex-col bg-background text-foreground"
    >
      <AppHeader variant="host-loading" />
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
            <LocalHostLoadingContent
              stage={props.stage}
              progress={props.progress}
              onConfigureShell={props.onConfigureShell}
              onRetry={() => respawn.mutate()}
              retryPending={respawn.isPending}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export interface LocalHostLoadingContentProps {
  readonly stage: LocalHostLoadingStage;
  /**
   * The shared host-progress view (F19's one copy table), not a raw lane
   * event. Built by the caller so this body and Settings ▸ Host read the same
   * table: they used to phrase the same install two different ways, one keyed
   * on the progress stage and one on the mutation kind.
   */
  readonly progress: HostProgressView | null;
  readonly onConfigureShell: () => void;
  /**
   * Drives the slow-stage Retry button. Injected rather than reading
   * `useRunnerRequestHostRespawn()` directly so callers control who owns
   * the respawn mutation - the full-screen `LocalHostLoading` splash owns
   * its own, while the slot-sized readiness-controller fallback routes
   * through the controller's single shared respawn lock.
   */
  readonly onRetry: () => void;
  readonly retryPending: boolean;
}

/**
 * Slot-friendly loading body: spinner, progress heading/detail, the
 * download progress bar, slow-stage copy + Retry, and the bootstrap-log
 * disclosure (with the "Configure shell…" shortcut). Deliberately has no
 * outer full-screen chrome (no `min-h-svh` wrapper, no `<AppHeader>`, no
 * `<Card>`) so it can be reused both by the full-screen `LocalHostLoading`
 * splash and by a slot-sized fallback that already provides its own
 * bounded, centered layout.
 */
export function LocalHostLoadingContent(
  props: LocalHostLoadingContentProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  const hasCli = runnerHost.traycerCli !== null;
  const [showDetails, setShowDetails] = useState<boolean>(false);
  // Only poll while the disclosure is open. Cache stays warm if the user
  // toggles closed-then-open quickly.
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: showDetails ? BOOTSTRAP_TAIL_POLL_MS : null,
  });
  const tail = status.data?.bootstrapLogTail ?? "";
  const progressView = props.progress;
  // Only on the slow stage: while a start is progressing normally there is no
  // failed attempt to explain, and showing spawn diagnostics under a healthy
  // spinner reads as an error. Recomputed per render rather than memoised -
  // it is a scan of a short marker list behind a 30s-stale query.
  const attemptSummary =
    props.stage === "slow" && status.data !== undefined
      ? summariseBootstrapAttempts(status.data.bootstrapMarkers)
      : null;

  return (
    <>
      <AgentSpinningDots
        testId="local-host-loading-spinner"
        variant="pulse"
        className="h-8 min-w-8 text-title-md text-foreground"
      />
      <p className="text-ui font-medium text-foreground">
        {progressView?.heading ?? HOST_PROGRESS_IDLE_HEADING}
      </p>
      <ProgressLines view={progressView} />
      {props.stage === "slow" ? (
        <div
          data-testid="local-host-loading-slow-copy"
          className="flex flex-col items-center gap-3"
        >
          <p className="text-ui-sm text-muted-foreground">
            Local host is taking longer than expected.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.retryPending}
            onClick={props.onRetry}
            data-testid="local-host-retry"
          >
            <span className="inline-flex items-center gap-1.5">
              <span>Retry</span>
              {props.retryPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="local-host-retry-spinner"
                  variant={undefined}
                />
              ) : null}
            </span>
          </Button>
        </div>
      ) : null}
      {attemptSummary !== null ? (
        <BootstrapAttemptDetails
          summary={attemptSummary}
          bootstrapLogPath={status.data?.bootstrapLogPath ?? null}
        />
      ) : null}
      {hasCli ? (
        <DetailsDisclosure
          open={showDetails}
          onToggle={() => setShowDetails((v) => !v)}
          tail={tail}
          onConfigureShell={props.onConfigureShell}
        />
      ) : null}
    </>
  );
}

/**
 * The lane's detail line and its progress bar, both of which only exist when
 * the lane has said something. Split out of the body so the body's branch
 * count stays about its own layout rather than about the view's optionality.
 */
function ProgressLines(props: {
  readonly view: HostProgressView | null;
}): ReactNode {
  const { view } = props;
  if (view === null) return null;
  return (
    <>
      {view.detail === null ? null : (
        <p
          data-testid="local-host-loading-progress-detail"
          className="text-ui-sm text-muted-foreground"
        >
          {view.detail}
        </p>
      )}
      {view.percent === null ? null : (
        <HostDownloadProgress
          percent={view.percent}
          shortLabel={view.shortLabel}
          transferLabel={view.transferLabel}
        />
      )}
    </>
  );
}

interface HostDownloadProgressProps {
  readonly percent: number;
  readonly shortLabel: string;
  readonly transferLabel: string | null;
}

function HostDownloadProgress(props: HostDownloadProgressProps) {
  return (
    <div
      data-testid="local-host-download-progress"
      className="flex w-full flex-col gap-2"
    >
      <div className="flex items-center justify-between text-ui-xs text-muted-foreground">
        <span>{props.transferLabel ?? props.shortLabel}</span>
        <span className="font-medium text-foreground">{props.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.percent}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${props.percent}%` }}
        />
      </div>
    </div>
  );
}

interface DetailsDisclosureProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tail: string;
  readonly onConfigureShell: () => void;
}

/**
 * Tucks the bootstrap.log tail and the "Configure shell…" affordance
 * behind a single text toggle. The default loading card stays clean
 * (spinner + heading + optional Retry); users only see logs and the
 * shell-settings shortcut when they explicitly ask.
 */
function DetailsDisclosure(props: DetailsDisclosureProps) {
  const Icon = props.open ? ChevronUp : ChevronDown;
  return (
    <div className="flex w-full flex-col items-stretch gap-3">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        data-testid="local-host-loading-toggle-details"
        className="inline-flex items-center justify-center gap-1 self-center text-ui-xs text-muted-foreground hover:text-foreground"
      >
        <span>{props.open ? "Hide details" : "Show details"}</span>
        <Icon className="size-3" />
      </button>
      {props.open ? (
        <>
          <BootstrapLogTail tail={props.tail} />
          <div className="flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={props.onConfigureShell}
              data-testid="local-host-open-shell-settings"
            >
              Configure shell…
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface BootstrapLogTailProps {
  readonly tail: string;
}

/**
 * Live tail of `~/.traycer/bootstrap.log`. Auto-scrolls to the bottom on
 * every refresh so the most recent line stays visible - same UX as a
 * `tail -f` in a terminal pane.
 */
function BootstrapLogTail(props: BootstrapLogTailProps) {
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.tail]);

  if (props.tail.length === 0) {
    return (
      <p
        data-testid="local-host-loading-empty-tail"
        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-center text-ui-xs text-muted-foreground"
      >
        Waiting for bootstrap output…
      </p>
    );
  }

  return (
    <pre
      ref={ref}
      data-testid="local-host-loading-log-tail"
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
