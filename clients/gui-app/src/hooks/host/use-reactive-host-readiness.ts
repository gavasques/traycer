import { useCallback, useSyncExternalStore } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

export interface ReactiveHostReadiness {
  readonly hostId: string | null;
  readonly requestContextUserId: string | null;
  readonly isReady: boolean;
}

const SNAPSHOT_SEPARATOR = "\u0000";

/**
 * TWO SUBSCRIPTIONS, one of which is on its way out (redesign P4.1 / P4.2).
 *
 * `client.onChange` is the active slot's change event. It is what tells this
 * hook to look again today, and P4.2 deletes it along with the slot.
 *
 * `subscribeAnyHostRowChanged` is the registry's replacement: a host's
 * directory row landing (or its lease moving) is a fact about that HOST, not
 * about a privileged binding, so it outlives the slot. The COARSE registry
 * signal is the right one here precisely because this hook cannot name its
 * host at subscribe time - it reads the id off whatever client it was handed,
 * and a pinned requester answers `null` until the row exists. Naming the host
 * would mean naming the very thing that has not arrived yet.
 *
 * Both arms are wired at once on purpose. Today's behavior is unchanged (the
 * slot event still fires; the registry arm is redundant), and after P4.2
 * removes the first arm the second already carries it - so that deletion is a
 * deletion, not a migration. The `useSyncExternalStore` snapshot is a string
 * compared by value, so a redundant wake re-renders nothing.
 */
export function useReactiveHostReadiness<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): ReactiveHostReadiness {
  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribeRegistry = subscribeAnyHostRowChanged(callback);
      if (client === null) {
        return unsubscribeRegistry;
      }
      const unsubscribe = client.onChange(() => {
        callback();
      });
      return () => {
        unsubscribe();
        unsubscribeRegistry();
      };
    },
    [client],
  );
  const getSnapshot = useCallback(
    () => readHostReadinessSnapshot(client),
    [client],
  );
  return parseHostReadinessSnapshot(
    useSyncExternalStore(subscribe, getSnapshot, () =>
      readHostReadinessSnapshot(null),
    ),
  );
}

function readHostReadinessSnapshot<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): string {
  return [
    client?.getActiveHostId() ?? "",
    client?.getRequestContextUserId() ?? "",
  ].join(SNAPSHOT_SEPARATOR);
}

function parseHostReadinessSnapshot(snapshot: string): ReactiveHostReadiness {
  const separatorIndex = snapshot.indexOf(SNAPSHOT_SEPARATOR);
  const hostId = normalizeSnapshotPart(snapshot.slice(0, separatorIndex));
  const requestContextUserId = normalizeSnapshotPart(
    snapshot.slice(separatorIndex + SNAPSHOT_SEPARATOR.length),
  );
  return {
    hostId,
    requestContextUserId,
    isReady: hostId !== null && requestContextUserId !== null,
  };
}

function normalizeSnapshotPart(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  return value;
}
