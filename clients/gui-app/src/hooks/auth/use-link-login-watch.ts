import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import { useAuthLinkLoginCode } from "@/hooks/auth/use-link-login-code-query";
import {
  useAuthLinkLoginStatus,
  type LinkLoginStatusDatum,
} from "@/hooks/auth/use-link-login-status-query";

/**
 * A live claim on this panel's code. The server enforces ONE live code per
 * user (minting atomically supersedes the previous unclaimed record, and is
 * refused while a claim is being decided), so the displayed code is the only
 * code that can ever report a claim — no multi-code bookkeeping exists.
 */
export interface LiveClaim {
  readonly code: string;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
}

export interface LinkLoginWatch {
  /** The live claim on the displayed code, if any. */
  readonly claim: LiveClaim | null;
  /** The mint query (rotation) — paused while a claim is live. */
  readonly code: UseQueryResult<MintLinkLoginCodeResponse | null>;
}

function claimFromStatus(
  code: string | null,
  datum: LinkLoginStatusDatum | null | undefined,
): LiveClaim | null {
  if (
    code === null ||
    datum === null ||
    datum === undefined ||
    datum === "gone" ||
    datum.status !== "claimed" ||
    datum.claimant === null
  ) {
    return null;
  }
  return {
    code,
    address: datum.claimant.address,
    userAgent: datum.claimant.userAgent,
    location: datum.claimant.location,
  };
}

/** A displayed code the server will never let anyone claim again. */
function isDeadDatum(datum: LinkLoginStatusDatum | null | undefined): boolean {
  if (datum === "gone") {
    return true;
  }
  return datum !== null && datum !== undefined && datum.status === "denied";
}

/**
 * Owns the Link-a-phone panel's code lifecycle: rotates the public code
 * while nothing is claimed, watches THE displayed code (the server's
 * one-live-code policy makes it the only claimable one), pauses rotation the
 * moment its claim appears, and refreshes the displayed code immediately
 * when it dies externally (denied elsewhere, expired, consumed) instead of
 * waiting out the rotation interval.
 */
export function useLinkLoginWatch(enabled: boolean): LinkLoginWatch {
  const [watchedCode, setWatchedCode] = useState<string | null>(null);

  const status = useAuthLinkLoginStatus(enabled ? watchedCode : null);
  const claim = claimFromStatus(watchedCode, status.data);

  const code = useAuthLinkLoginCode(enabled && claim === null);
  const minted = code.data ?? null;

  // Adjust-during-render (guarded): follow the mint onto the code now on
  // screen. Never while a claim is live — the claimed code stays watched
  // until the decision resolves it, and the mint query is paused anyway.
  if (claim === null && minted !== null && watchedCode !== minted.code) {
    setWatchedCode(minted.code);
  }

  // External death of the displayed code (denied in another window, expired,
  // consumed): refresh immediately rather than showing a dead QR until the
  // rotation interval. One refetch per observed code; the effect is external
  // sync (query → query), not a state transition.
  const refreshedForCode = useRef<string | null>(null);
  const displayedDatum =
    minted !== null && watchedCode === minted.code ? status.data : null;
  const codeRefetch = code.refetch;
  useEffect(() => {
    if (minted === null || claim !== null) {
      return;
    }
    if (
      isDeadDatum(displayedDatum) &&
      refreshedForCode.current !== minted.code
    ) {
      refreshedForCode.current = minted.code;
      void codeRefetch();
    }
  }, [claim, codeRefetch, displayedDatum, minted]);

  return { claim, code };
}
