import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * D6 inline dead state for a pinned surface whose host is unreachable.
 * The pin is kept. Reselect is the surface's own host picker; this block
 * only adds the "use active host" follow-effective affordance.
 */
export interface PinnedSurfaceDeadStateProps {
  readonly hostLabel: string;
  readonly onUseActiveHost: () => void;
  readonly testId: string;
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
        {props.hostLabel} is offline. This surface stays pinned here. Reselect
        a host above, or follow the active host.
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
