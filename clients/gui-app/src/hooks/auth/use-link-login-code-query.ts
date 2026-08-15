import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

// Re-mint comfortably inside the code's 60s TTL, so the rendered QR is always
// live: a phone that scans just before rotation still has several seconds to
// redeem before the pictured code expires. Exported so the panel's countdown
// can derive the rotation moment from the same cadence rather than a copy.
export const LINK_LOGIN_REMINT_MS = 50_000;

function linkLoginCodeQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  active: boolean,
) {
  if (auth === null || userId === null || !active) {
    return queryOptions<MintLinkLoginCodeResponse | null>({
      queryKey: authQueryKeys.linkLoginCodeMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<MintLinkLoginCodeResponse | null>({
    queryKey: authQueryKeys.linkLoginCode(auth, userId),
    queryFn: async ({ signal }) => {
      const result = await auth.mintLinkLoginCode(signal);
      if (result.kind !== "ok") {
        // Thrown, not returned: the panel is an inline-error surface and the
        // query's error state is its retry affordance.
        throw new Error(
          result.kind === "unauthorized"
            ? "Your session could not authorize a link code."
            : "Could not reach the sign-in service.",
        );
      }
      return result.response;
    },
    // Rotation is interval-driven; a focus refetch must not burn extra codes,
    // but every fresh OPEN of the panel mints anew (`refetchOnMount:
    // "always"`) so a reopened panel never shows a code another consumer may
    // have spent. The short non-zero `gcTime` drops a closed panel's code
    // quickly — it must not be 0: under StrictMode's double mount a
    // zero-gcTime query is evicted between the paired mounts while its fetch
    // is in flight, every completion lands observer-less and is discarded,
    // and the query spins forever.
    refetchInterval: LINK_LOGIN_REMINT_MS,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 15_000,
    retry: false,
  });
}

/**
 * Mints and auto-rotates the "Link a phone" public code while the consuming
 * surface is mounted AND `active`. The panel deactivates the rotation the
 * moment a phone claims the displayed code — a fresh QR must not replace the
 * one whose claimant the user is being asked to approve.
 */
export function useAuthLinkLoginCode(
  active: boolean,
): UseQueryResult<MintLinkLoginCodeResponse | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useQuery(linkLoginCodeQueryOptions(auth, userId, active));
}
