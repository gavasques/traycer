import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";

/**
 * Surface-pin `effective` pointer (selection model §2).
 *
 * Named alias (overhaul doctrine rule 1): temporarily the legacy active host.
 * P1.2 swaps only this backing to real `effectiveHostId`; no consumer of
 * `useSurfaceHostPin` / `useEffectiveHostId` changes then.
 */
export function useEffectiveHostId(): string | null {
  return useReactiveActiveHostId();
}
