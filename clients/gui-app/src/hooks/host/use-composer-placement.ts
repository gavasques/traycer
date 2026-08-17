import { useCallback, useMemo } from "react";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import type { SurfaceHostPin } from "@/hooks/host/use-surface-host-pin";
import { isSurfacePinDeposed } from "@/stores/host/surface-host-selection-store";
import {
  composerHostLabel,
  type LandingPlacementTarget,
} from "@/lib/composer/landing-placement";

export interface ComposerPlacement {
  /** The window's composer pin. Write it from the picker; read below for use. */
  readonly pin: SurfaceHostPin;
  /**
   * READ scope: the client this composer's queries (catalog, mentions,
   * workspace resolution, usage) run on. Mutable while following, which is
   * correct for reads - they should re-point when derivation moves.
   */
  readonly target: LandingPlacementTarget;
  /**
   * SUBMIT scope: identical except its client is FROZEN to `resolvedHostId`
   * for the duration of a submit. Pass this - never `target` - to anything
   * that creates. See the frozen-requester note below.
   */
  readonly submitTarget: LandingPlacementTarget;
  /** Names an arbitrary host for notice copy, resolved late. */
  readonly hostLabelFor: (hostId: string | null) => string;
}

/**
 * One resolution of "where would this composer place new work" (redesign
 * P1.2), so the chip, the RPCs the composer makes, its creates, and its
 * submit-time refusal can never be derived independently and disagree.
 *
 * `overrideHostId` is a caller-supplied host that outranks the pin: the
 * new-conversation modal's row-scoped request names one, and the picker goes
 * inert for it (§55). `null` means "this surface owns its placement", which is
 * the landing composer and the modal opened from the app-wide sidebar - both
 * resolve `pin ?? effective` and both write the same window-keyed pin.
 *
 * **Two clients, deliberately.**
 *
 * `target.client` follows `pin.honoredSelection`, so a composer that is
 * unpinned - or pinned to a host that has died, which resolves the same way -
 * reads through the app-wide bound client and re-points when derivation moves.
 * That is right for queries and wrong for creates: the app-wide client rebinds IN
 * PLACE, so a multi-RPC submit chain (`epic.create` → `agent.tui.prepareLaunch`
 * → `epic.createTuiAgent`) that awaits between steps can have later steps land
 * on host B against an epic created on host A. Nothing in the chain would
 * notice, because the client object never changed identity.
 *
 * `submitTarget.client` therefore resolves the RESOLVED host id, not the pin -
 * `useHostClientForHostId(resolvedHostId)` returns a pinned requester whose
 * `getActiveHostId()` is frozen to that id for life, so every RPC in a chain
 * provably targets the host the placement resolved, even while following. When
 * that host cannot be addressed at all the requester is `null`, which
 * `resolveLandingPlacement` refuses on - an honest refusal instead of a
 * silently re-pointed create.
 */
export function useComposerPlacement(
  overrideHostId: string | null,
): ComposerPlacement {
  const pin = useComposerSurfaceHostPin();
  const resolvedHostId = overrideHostId ?? pin.resolvedHostId;
  // `honoredSelection`, not `selection`: a deposed pin reads through the
  // ambient client (which is the effective host) exactly as a following
  // composer does, so the reads land where the chip says. Reading `selection`
  // here would point every composer query at the dead machine.
  const readClient = useHostClientForHostId(
    overrideHostId ?? pin.honoredSelection,
  );
  const submitClient = useHostClientForHostId(resolvedHostId);
  // OVERRIDE ONLY. A pin that dies has already re-resolved to `effective` by
  // the time submit runs - `pin.resolvedHostId` is the live host, so there is
  // nothing here to refuse. A caller-NAMED host does not re-resolve (naming it
  // is the request), so it is the one thing left that can be dead at submit.
  //
  // Derived from the lease, on the same rule the pin resolver uses, so the two
  // cannot disagree about what "dead" means.
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  const namedHostDead =
    overrideHostId !== null &&
    isSurfacePinDeposed(overrideHostId, { authorityAttached, leases });
  const directory = useHostDirectoryList();
  const entries = directory.data ?? null;
  const hostLabelFor = useCallback(
    (hostId: string | null) => composerHostLabel(entries, hostId),
    [entries],
  );
  const isPinned = overrideHostId !== null || pin.isPinned;
  const target = useMemo<LandingPlacementTarget>(
    () => ({
      resolvedHostId,
      client: readClient,
      hostLabel: composerHostLabel(entries, resolvedHostId),
      isPinned,
      namedHostDead,
    }),
    [entries, isPinned, namedHostDead, readClient, resolvedHostId],
  );
  const submitTarget = useMemo<LandingPlacementTarget>(
    () => ({ ...target, client: submitClient }),
    [submitClient, target],
  );
  return { pin, target, submitTarget, hostLabelFor };
}
