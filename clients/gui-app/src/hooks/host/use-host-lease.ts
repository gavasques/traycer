import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * This window's lease for ONE host (connection registry §1: all status UI
 * derives from the lease vocabulary - no surface reads sockets, probe caches,
 * or the cloud DTO directly).
 *
 * `null` means the authority has published no lease for this host. It is NOT
 * "dead": before this window's kernel attaches, every host answers `null`
 * because nobody has spoken yet. Any surface presenting a FAILURE off a null
 * lease must pair this with `useSelectionAuthorityAttached()`, which exists to
 * tell that bootstrap apart from the real ∅ - or, better, bound the wait with
 * `useBoundedHostLoad`, which does both.
 *
 * The per-host projection is deliberately the only one of its kind: a second
 * hook answering "what is host X's status" is how this codebase acquired the
 * layered narration this epic is deleting.
 */
export function useHostLease(hostId: string | null): HostLeaseSnapshot | null {
  return useSelectionAuthorityStore((state) =>
    hostId === null
      ? null
      : (state.leases.find((lease) => lease.hostId === hostId) ?? null),
  );
}

/**
 * Every published lease, for surfaces that render the FLEET rather than one
 * host (Settings' hosts list, the window modal's no-usable-host derivation).
 *
 * Returns the store's array by reference. `applyKernelSnapshot` stores a fresh
 * array per publish, so a consumer that re-derives from this (mapping,
 * filtering, building an object) must select with `useShallow` or memoize -
 * otherwise it re-renders on every kernel publish whether or not any lease it
 * cares about moved. `useHostLease` above has no such caveat: it selects an
 * ELEMENT, whose identity is the kernel's to keep stable.
 */
export function useHostLeases(): readonly HostLeaseSnapshot[] {
  return useSelectionAuthorityStore((state) => state.leases);
}
