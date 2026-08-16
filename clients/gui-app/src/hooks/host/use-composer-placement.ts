import { useCallback, useMemo } from "react";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import {
  usePinnedSurfaceDead,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import {
  composerHostLabel,
  type LandingPlacementTarget,
} from "@/lib/composer/landing-placement";

export interface ComposerPlacement {
  /** The window's composer pin. Write it from the picker; read `target` for use. */
  readonly pin: SurfaceHostPin;
  /** Everything submit-time re-validation needs (selection model §54). */
  readonly target: LandingPlacementTarget;
  /** Names an arbitrary host for notice copy, resolved late. */
  readonly hostLabelFor: (hostId: string | null) => string;
}

/**
 * One resolution of "where would this composer place new work" (redesign
 * P1.2), so the chip, the RPCs the composer makes, its creates, and its
 * submit-time refusal can never be derived independently and disagree.
 *
 * The client comes from `pin.selection`, not from the resolution: a FOLLOWING
 * composer keeps the app-wide bound client - which the selection-authority
 * bridge holds on the effective host - and only a pin resolves a separate
 * requester for its own machine.
 */
export function useComposerPlacement(): ComposerPlacement {
  const pin = useComposerSurfaceHostPin();
  const client = useHostClientForHostId(pin.selection);
  const pinnedDead = usePinnedSurfaceDead(pin);
  const directory = useHostDirectoryList();
  const entries = directory.data ?? null;
  const hostLabelFor = useCallback(
    (hostId: string | null) => composerHostLabel(entries, hostId),
    [entries],
  );
  const resolvedHostId = pin.resolvedHostId;
  const target = useMemo<LandingPlacementTarget>(
    () => ({
      resolvedHostId,
      client,
      hostLabel: composerHostLabel(entries, resolvedHostId),
      isPinned: pin.isPinned,
      // A pin whose host left the directory entirely is dead in the same way
      // an unreachable one is: there is nothing to create on.
      pinnedHostDead: pinnedDead.isDead || pinnedDead.vanished,
    }),
    [
      client,
      entries,
      pin.isPinned,
      pinnedDead.isDead,
      pinnedDead.vanished,
      resolvedHostId,
    ],
  );
  return { pin, target, hostLabelFor };
}
