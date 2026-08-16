import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";

/**
 * Reactively projects the canonical remote-aware owner identity (R-1) for the
 * "default host" scope from a `HostClient`'s live active host + signed-in
 * user - `null` until both are known.
 *
 * Subscribes via `client.onChange`, so a same-`hostId` public-key rotation -
 * which `HostClient.bind`'s `sameHostTransport` check now treats as a
 * `host-updated` transition - is observed the same way a genuine host swap
 * is, instead of requiring an unrelated re-render to pick up the fresh key.
 *
 * ALSO via the connection registry, for the same reason and on the same
 * schedule as `useReactiveHostReadiness`: the slot event dies with P4.2, and
 * a public-key rotation is a ROW change the registry reports whether or not
 * anything re-binds. Note that this makes the registry arm load-bearing here
 * even before P4.2 - a rotation on a host that is not the bound one never
 * reached `bind()` at all.
 */
export function useReactiveOwnerIdentityKey<
  Registry extends VersionedRpcRegistry,
>(client: HostClient<Registry> | null): string | null {
  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribeRegistry = subscribeAnyHostRowChanged(callback);
      if (client === null) {
        return unsubscribeRegistry;
      }
      const unsubscribe = client.onChange(callback);
      return () => {
        unsubscribe();
        unsubscribeRegistry();
      };
    },
    [client],
  );
  const getSnapshot = useCallback(() => readOwnerIdentityKey(client), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function readOwnerIdentityKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  return remoteAwareOwnerIdentityKey(
    client?.getActiveHost() ?? null,
    client?.getRequestContextUserId() ?? null,
  );
}
