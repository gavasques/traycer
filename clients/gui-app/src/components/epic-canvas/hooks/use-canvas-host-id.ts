import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";

/**
 * Returns the host currently serving the canvas. Unlike `useTabHostId`, this
 * deliberately follows the window's effective host selection.
 */
export function useCanvasHostId(): string | null {
  return useEffectiveHostId();
}
