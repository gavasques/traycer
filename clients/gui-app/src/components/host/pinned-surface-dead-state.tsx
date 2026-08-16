import type { ReactNode } from "react";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { Button } from "@/components/ui/button";

/**
 * D6 inline dead state for a pinned surface whose host is unreachable.
 * The pin is kept. Reselect is the surface's own host picker; this block
 * only adds the "use active host" follow-effective affordance.
 *
 * A pin whose host has left the directory does not print the raw id.
 *
 * VOCABULARY NOTE (redesign P4.3) — this used to claim its status words match
 * `hostOptionStatusWord`, "plan-restricted → 'requires upgrade'; otherwise
 * 'unreachable'". The first half still holds. The second no longer does:
 * picker rows now speak the lease-derived health vocabulary, where that state
 * is "offline", and `unreachable` is not a row word at all.
 *
 * The divergence is PRE-EXISTING rather than introduced there. The tile family
 * already disagreed with itself — `tile-host-load-copy.ts` has worded the same
 * dead lease as "offline" since P3.3, from the lease reason, while this banner
 * words it from `HostUnavailability` via the reachability/deadline machinery.
 * P4.3 made Settings agree with the lease vocabulary, which leaves this the
 * one surface still saying "unreachable" and so makes the older split visible.
 *
 * The RENDERED copy is deliberately untouched here: changing it is a product
 * decision, and it is queued for the phase walkthrough alongside this surface's
 * other open item (`usePinnedSurfaceDead` inheriting F4's deadline, a D6
 * behaviour change already flagged there). This note exists so the next reader
 * inherits the real state instead of a claim that stopped being true.
 */
export interface PinnedSurfaceDeadStateProps {
  readonly hostLabel: string;
  readonly unavailability: HostUnavailability | null;
  readonly vanished: boolean;
  readonly onUseActiveHost: () => void;
  readonly testId: string;
}

function pinnedSurfaceDeadHeadline(
  props: Pick<
    PinnedSurfaceDeadStateProps,
    "hostLabel" | "unavailability" | "vanished"
  >,
): string {
  if (props.vanished) {
    return "The pinned host is no longer connected";
  }
  if (props.unavailability === "plan-restricted") {
    return `${props.hostLabel} requires upgrade`;
  }
  return `${props.hostLabel} is unreachable`;
}

export function PinnedSurfaceDeadState(
  props: PinnedSurfaceDeadStateProps,
): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
    >
      <p className="max-w-md">
        {pinnedSurfaceDeadHeadline(props)}. This surface stays pinned here.
        Reselect a host above, or follow the active host.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onUseActiveHost}
        data-testid={`${props.testId}-use-active`}
      >
        Use active host
      </Button>
    </div>
  );
}
