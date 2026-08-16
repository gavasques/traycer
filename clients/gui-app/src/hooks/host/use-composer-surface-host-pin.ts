import { useMemo } from "react";
import {
  useSurfaceHostPin,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { composerSurfaceKey } from "@/stores/host/surface-host-selection-store";

/**
 * The composer's surface key: window-scoped (selection model §2 / M4).
 *
 * The composer is the one multi-instance surface whose instances must AGREE -
 * a window shows at most one placement composer at a time (the landing
 * composer, or the app-wide new-conversation modal opened over it), and they
 * all place new work on the same machine. Keying per component instance would
 * let the modal silently contradict the landing chip behind it.
 *
 * Outside desktop there is no windows bridge, so `resolveSurfaceWindowId`
 * folds the whole browser tab onto one key.
 */
export function useComposerSurfaceHostKey(): string {
  const windowId = useWindowsBridge()?.windowId ?? null;
  return useMemo(() => composerSurfaceKey(windowId), [windowId]);
}

/**
 * This window's composer host pin. `selection === null` follows the effective
 * host; `resolvedHostId` is what the chip renders and what every create the
 * composer performs must address (selection model §54 - the composer is
 * placement, and its resolved host decides where a chat/epic lives for life).
 *
 * Writing it is the ONLY thing the composer's host picker does: it never
 * moves the app-wide selection, which is Settings ▸ Activate's alone.
 */
export function useComposerSurfaceHostPin(): SurfaceHostPin {
  const surfaceKey = useComposerSurfaceHostKey();
  return useSurfaceHostPin(surfaceKey);
}
