import { useMemo } from "react";
import { useHostBinding } from "@/lib/host";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

/**
 * Reactively projects the app-wide host id, resolved against the directory.
 *
 * This hook used to read `HostClient`'s active slot and subscribe to the slot's
 * change event. P4.2 deleted the slot, so it now resolves the selection layer's
 * `effectiveHostId` through the SAME id-pinned requester every other app-wide
 * consumer resolves through, and re-reads on the connection registry's row
 * signal. The answer is unchanged in both arms: the id once its directory row
 * exists, `null` while it does not - which is what the slot reported, because
 * the slot only ever held a row `selectById` had already resolved.
 *
 * It is therefore NOT `useEffectiveHostId()`, and the difference is the whole
 * reason this hook still exists: `useEffectiveHostId()` names the host the
 * authority DERIVED (`null` there means ∅, nothing usable), while this answers
 * whether that host is addressable YET. Consumers gating on "can I talk to a
 * host" want this one; consumers narrating the selection want that one. The
 * name is bind-era vocabulary and is retired by P4.3's convergence sweep.
 */
export function useReactiveActiveHostId(): string | null {
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  // Null-tolerant on purpose, and that is the one way this differs from
  // `useHostClient()`, which throws outside a `<HostRuntimeProvider>`. The
  // provider renders a fallback until its binding exists, so no production
  // consumer can observe the difference; a test rendering one of the 44
  // consumers without a runtime can, and the slot-era hook answered `null`
  // there rather than throwing.
  const client = useMemo(
    () =>
      binding === null
        ? null
        : binding.hostClient.createRequesterForHostId(effectiveHostId),
    [binding, effectiveHostId],
  );
  return useReactiveHostReadiness(client).hostId;
}
