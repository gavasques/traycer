import { useCallback } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  gitDiffPanelSurfaceKey,
  resolvedSurfaceHostId,
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
  type SurfaceHostSelection,
  type SurfaceKind,
} from "@/stores/host/surface-host-selection-store";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface SurfaceHostPin {
  readonly selection: SurfaceHostSelection;
  readonly setSelection: (selection: SurfaceHostSelection) => void;
  readonly resolvedHostId: string | null;
  readonly isPinned: boolean;
  readonly latchOnFirstUse: () => void;
  readonly followEffective: () => void;
}

export function useSurfaceHostPin(surfaceKey: string): SurfaceHostPin {
  const stored = useSurfaceHostSelectionStore(
    (state) => state.selections[surfaceKey],
  );
  const selection: SurfaceHostSelection = stored ?? null;
  const setSelectionRaw = useSurfaceHostSelectionStore(
    (state) => state.setSelection,
  );
  const latchRaw = useSurfaceHostSelectionStore(
    (state) => state.latchOnFirstUse,
  );
  const effectiveHostId = useEffectiveHostId();
  const resolvedHostId = resolvedSurfaceHostId(selection, effectiveHostId);

  const setSelection = useCallback(
    (next: SurfaceHostSelection) => {
      setSelectionRaw(surfaceKey, next);
    },
    [setSelectionRaw, surfaceKey],
  );
  const latchOnFirstUse = useCallback(() => {
    if (resolvedHostId === null) return;
    latchRaw(surfaceKey, resolvedHostId);
  }, [latchRaw, resolvedHostId, surfaceKey]);
  const followEffective = useCallback(() => {
    setSelectionRaw(surfaceKey, null);
  }, [setSelectionRaw, surfaceKey]);

  return {
    selection,
    setSelection,
    resolvedHostId,
    isPinned: selection !== null,
    latchOnFirstUse,
    followEffective,
  };
}

export function useSurfaceHostClient(
  resolvedHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  return useHostClientForHostId(resolvedHostId);
}

export interface PinnedSurfaceDead {
  readonly isDead: boolean;
  readonly hostLabel: string;
  readonly unavailability: HostUnavailability | null;
  readonly vanished: boolean;
}

/** D6: pinned + unreachable. Following surfaces never take this arm. */
export function usePinnedSurfaceDead(pin: SurfaceHostPin): PinnedSurfaceDead {
  const reachability = useHostReachability(
    pin.selection ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const directory = useHostDirectoryList();
  const listed =
    pin.selection !== null &&
    (directory.data ?? []).some((entry) => entry.hostId === pin.selection);
  const vanished =
    pin.isPinned &&
    directory.data !== undefined &&
    directory.data.length > 0 &&
    !listed;
  return {
    isDead: pin.isPinned && reachability.status === "unreachable",
    hostLabel: vanished ? "The pinned host" : reachability.hostLabel,
    unavailability: reachability.unavailability,
    vanished,
  };
}

export function useTabSurfaceKey(
  kind: Extract<SurfaceKind, "file-tree" | "new-terminal">,
  tabId: string,
): string {
  return tabSurfaceKey(kind, tabId);
}

export function useGitDiffPanelSurfaceKey(tileRef: string): string {
  return gitDiffPanelSurfaceKey(tileRef);
}
