import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostClient,
  useHostRuntimeClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Resolves the `HostClient` for an explicit host id captured elsewhere (a
 * tab's bound host threaded through as a plain id, a fork dialog's fixed
 * host). `null` follows the app-wide effective host; every explicit id
 * receives a pinned requester, including when it currently matches that
 * host. This prevents a fixed-host caller from silently moving when the
 * effective host changes before its next render. Every surface that
 * must agree on "which host does this id resolve to" (a tab's own consumers
 * via `useTabHostClient`, the picker's `runTargetHostId` / create-profile
 * capability gate, `ProviderProfileAddFlowHost` itself) shares this one
 * resolution - same entry lookup order, same `null` conditions - so they can
 * never disagree about the target host, or about whether it has resolved yet
 * in a given paint.
 *
 * Both branches now resolve the same way (redesign D17 / P2.1): the `null`
 * branch hands back the effective host's pinned requester rather than the
 * spine itself, so "following" is a resolution of the selection layer's id -
 * not a privileged client that re-aims itself underneath its holder.
 */
export function useHostClientForHostId(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const followingClient = useHostClient();
  // The SPINE for the lookups below: they ask "does the directory know this
  // id", which is a question about the client's directory view, not about
  // whichever host is currently effective.
  const defaultClient = useHostRuntimeClient();
  const directory = useHostDirectoryList();
  const targetEntry = useMemo(() => {
    if (hostId === null) return null;

    // HostRuntime's directory is authoritative and already hydrated before it
    // publishes `defaultClient`. The Query snapshot exists to make directory
    // changes reactive, but can still be undefined on this hook's first render.
    const liveEntry = defaultClient.resolveHostById(hostId);
    if (liveEntry !== null) return liveEntry;

    // Standalone/test clients may only resolve their active entry. Preserve
    // that entry as the same pinned requester while the Query snapshot catches
    // up; returning `defaultClient` here would make the explicit id mutable.
    const activeEntry = defaultClient.getActiveHost();
    if (activeEntry !== null && activeEntry.hostId === hostId) {
      return activeEntry;
    }

    return (
      (directory.data ?? []).find((entry) => entry.hostId === hostId) ?? null
    );
  }, [defaultClient, directory.data, hostId]);
  const transientClient = useHostClientFor(targetEntry);
  return hostId === null ? followingClient : transientClient;
}
