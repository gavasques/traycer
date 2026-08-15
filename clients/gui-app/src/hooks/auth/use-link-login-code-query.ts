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
// redeem before the pictured code expires.
const LINK_LOGIN_REMINT_MS = 50_000;

function linkLoginCodeQueryOptions(
  auth: AuthService | null,
  userId: string | null,
) {
  if (auth === null || userId === null) {
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
    // Rotation is interval-driven; a focus or remount must not burn extra
    // codes. `gcTime: 0` discards the code the moment the panel closes — a
    // cached one-time code has no legitimate later reader.
    refetchInterval: LINK_LOGIN_REMINT_MS,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/**
 * Mints and auto-rotates the "Link a phone" one-time code while the consuming
 * surface is mounted. Rotation stops when the last consumer unmounts and the
 * final code falls out of cache immediately.
 */
export function useAuthLinkLoginCode(): UseQueryResult<MintLinkLoginCodeResponse | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useQuery(linkLoginCodeQueryOptions(auth, userId));
}
