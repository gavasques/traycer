import { useMemo } from "react";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The runtime binding a host-scoped panel re-provides so every hook beneath it
 * targets the host the page is SHOWING rather than a spine that names none.
 *
 * THE ONE implementation of this rule. `providers-settings-panel.tsx` used to
 * carry a byte-equivalent copy inline; a rule that has been wrong in the same
 * way twice does not get a second home, and a fix that silently covered three
 * of the four re-providing panels would have read as complete.
 *
 * Three arms, and which one you are in is the whole question:
 *
 *   - `status === "ready"` with an explicit pick re-provides `scope.client`.
 *     That client addresses the host the page names, which is what stops one
 *     host's data rendering under another host's name.
 *   - `connecting`, `unreachable` and `vanished` return null. They have no
 *     client at all, re-providing a null one would make `useHostClient()`
 *     throw, and falling back to the ambient host is the substitution above.
 *     The panels gate those states rather than render through them.
 *   - `following` NOW RE-PROVIDES TOO, and it did not used to. The old comment
 *     said the ambient binding already IS the scoped host's — true while a
 *     privileged bound host existed, and false the moment redesign P4.2
 *     deleted the active slot. The ambient binding's `hostClient` is the
 *     window's spine: it owns the messenger, coordinator and request context,
 *     and it deliberately addresses NO host, so a panel left beneath it would
 *     resolve every read against nothing.
 *
 * The `following` client is NOT re-derived here. `use-host-scope.ts` already
 * answers it — `client: status === "following" ? ambientClient : overrideClient`,
 * where `ambientClient` is `useHostClient()`, the effective host's own
 * requester. Re-deriving it in this hook would put a second decider behind the
 * same question, which is the defect the whole selection layer is being
 * rebuilt to remove. All this hook decides now is WHETHER to re-provide.
 *
 * NAMED BEHAVIOR PROPERTY of that third arm: a `following` subtree now
 * re-renders when the effective host moves, where before it re-rendered only
 * when the ambient binding itself changed. That is the point rather than a
 * cost — a following panel must re-point when the host it follows moves — and
 * it is semantics-preserving today, because today the ambient binding IS the
 * effective host's. It becomes load-bearing after the slot is gone.
 */
export function useScopedHostBinding(
  scope: HostScope,
): HostRuntimeBinding<HostRpcRegistry> | null {
  const realBinding = useHostBinding();
  return useMemo(() => {
    if (realBinding === null) return null;
    // Fail closed on the status FIRST. `scope.client` is already null for
    // `connecting`/`unreachable`/`vanished`, but that is a guarantee made
    // upstream, and this is the boundary where re-providing the wrong client
    // renders one host's data under another host's name.
    if (scope.status !== "ready" && scope.status !== "following") return null;
    if (scope.client === null) return null;
    return { ...realBinding, hostClient: scope.client };
  }, [scope.status, scope.client, realBinding]);
}
