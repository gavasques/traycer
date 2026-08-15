import type { ReactNode } from "react";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { Button } from "@/components/ui/button";

/**
 * D6 inline dead state for a pinned surface whose host is unreachable.
 * The pin is kept. Reselect is the surface's own host picker; this block
 * only adds the "use active host" follow-effective affordance.
 *
 * Status words match `hostOptionStatusWord` so the picker row and banner
 * agree: plan-restricted → "requires upgrade"; otherwise "unreachable".
 * A pin whose host has left the directory does not print the raw id.
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
