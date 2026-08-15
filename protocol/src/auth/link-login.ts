import { z } from "zod";

/**
 * Client-side mirror of authn-v3's link-login DTOs — the QR "link a phone"
 * handoff. A signed-in client mints a one-time code
 * (`POST /api/v3/auth/link/mint`, bearer-authenticated); the phone redeems it
 * once (`POST /api/v3/auth/link/redeem`, unauthenticated — the code is the
 * whole authorization) for its own session-registry-backed token pair.
 *
 * Schemas are strict so a backend contract drift fails closed at the HTTP
 * boundary rather than handing an unparsed credential to the sign-in path.
 */

export type MintLinkLoginCodeResponse = {
  /** The raw one-time code. Exists only in this response and in the QR. */
  code: string;
  /** Seconds until the code expires; drives the QR re-mint cadence. */
  expires_in: number;
  /** Absolute expiry, epoch seconds. */
  expires_at: number;
};

export type RedeemLinkLoginCodeResponse = {
  token: string;
  refreshToken: string;
  familyId: string;
};

export const mintLinkLoginCodeResponseSchema: z.ZodType<MintLinkLoginCodeResponse> =
  z
    .object({
      code: z.string().min(1),
      expires_in: z.number().int().positive(),
      expires_at: z.number().int().positive(),
    })
    .strict();

export const redeemLinkLoginCodeResponseSchema: z.ZodType<RedeemLinkLoginCodeResponse> =
  z
    .object({
      token: z.string().min(1),
      refreshToken: z.string().min(1),
      familyId: z.string().min(1),
    })
    .strict();
