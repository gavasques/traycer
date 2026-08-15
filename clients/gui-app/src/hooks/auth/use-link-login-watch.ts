import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import { useAuthLinkLoginCode } from "@/hooks/auth/use-link-login-code-query";
import {
  useAuthLinkLoginStatus,
  type LinkLoginStatusDatum,
} from "@/hooks/auth/use-link-login-status-query";

/**
 * A live claim on one of this panel's codes. The server's per-user claim
 * lock guarantees AT MOST ONE of these exists across the whole rotation
 * chain, so whichever watched code reports `claimed` IS the winner — no
 * client-side arbitration between snapshots is possible or needed.
 */
export interface LiveClaim {
  readonly code: string;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
}

export interface LinkLoginWatch {
  /** The single live claim, if any watched code reports one. */
  readonly claim: LiveClaim | null;
  /** The mint query (rotation) — paused while a claim is live. */
  readonly code: UseQueryResult<MintLinkLoginCodeResponse | null>;
}

// Watch slots for codes that might still be claimable or claimed. Rotation
// (50s cadence, 60s unclaimed TTL) keeps at most two codes live, and the
// server's per-user claim lock allows at most one claimed record across the
// chain; the extra slots absorb status responses lagging behind rotation. A
// code leaves the watch list ONLY when the server reports it gone
// (expired/consumed/denial lapsed), never by count alone: the overflow bound
// evicts from the tail codes the server confirms hold no live claim, then
// codes with no status yet, and never touches a claimed or approved record.
const WATCH_SLOTS = 4;

function claimFromStatus(
  code: string | undefined,
  datum: LinkLoginStatusDatum | null | undefined,
): LiveClaim | null {
  if (
    code === undefined ||
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

interface WatchEntry {
  readonly code: string;
  readonly datum: LinkLoginStatusDatum | null | undefined;
}

/**
 * Server-confirmed to hold no live claim (unclaimed, or denied and merely
 * awaiting its record's expiry) — safe to count-evict. A denied DISPLAYED
 * code is not pruned here so the death-refetch effect below still sees it.
 */
function isConfirmedNotClaimed(
  datum: LinkLoginStatusDatum | null | undefined,
): boolean {
  return (
    datum !== null &&
    datum !== undefined &&
    datum !== "gone" &&
    (datum.status === "unclaimed" || datum.status === "denied")
  );
}

function hasNoStatusYet(
  datum: LinkLoginStatusDatum | null | undefined,
): boolean {
  return datum === null || datum === undefined;
}

/**
 * Overflow bound for the watch list — a tail eviction that can never drop
 * the claim the panel exists to confirm. Preference order: codes the server
 * confirms hold no live claim, then codes with no status response yet
 * (reachable only if status polling is dark for several whole rotations
 * while minting stays healthy — and then a claim could not render anyway).
 * A claimed or approved record is never evicted, and neither is the
 * displayed head slot.
 */
function evictWatchOverflow(entries: readonly WatchEntry[]): WatchEntry[] {
  const kept = [...entries];
  for (const evictable of [isConfirmedNotClaimed, hasNoStatusYet]) {
    for (let i = kept.length - 1; i > 0 && kept.length > WATCH_SLOTS; i -= 1) {
      if (evictable(kept[i].datum)) {
        kept.splice(i, 1);
      }
    }
  }
  return kept;
}

/**
 * The next watch list: a code is DROPPED only when the server reports it
 * gone (expired, consumed, or a denial's record finally lapsing); a newly
 * minted code is prepended; overflow is bounded without ever count-evicting
 * a claimed record.
 */
function advanceWatchedCodes(
  watched: readonly string[],
  data: ReadonlyArray<LinkLoginStatusDatum | null | undefined>,
  mintedCode: string | null,
): readonly string[] {
  const live = watched
    .map((code, position) => ({ code, datum: data[position] }))
    .filter((entry) => entry.datum !== "gone");
  if (mintedCode === null || live[0]?.code === mintedCode) {
    return live.map((entry) => entry.code);
  }
  const withMint: WatchEntry[] = [{ code: mintedCode, datum: null }, ...live];
  return evictWatchOverflow(withMint).map((entry) => entry.code);
}

function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, position) => entry === right[position])
  );
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
 * while nothing is claimed, watches every code that might still be claimed
 * (retaining each until the server terminally resolves it), pauses rotation the
 * moment the single server-elected claim appears, and refreshes the
 * displayed code immediately when it dies externally (denied elsewhere,
 * expired, consumed) instead of waiting out the rotation interval.
 */
export function useLinkLoginWatch(enabled: boolean): LinkLoginWatch {
  const [watchedCodes, setWatchedCodes] = useState<readonly string[]>([]);

  const statusA = useAuthLinkLoginStatus(
    enabled ? (watchedCodes[0] ?? null) : null,
  );
  const statusB = useAuthLinkLoginStatus(
    enabled ? (watchedCodes[1] ?? null) : null,
  );
  const statusC = useAuthLinkLoginStatus(
    enabled ? (watchedCodes[2] ?? null) : null,
  );
  const statusD = useAuthLinkLoginStatus(
    enabled ? (watchedCodes[3] ?? null) : null,
  );
  const data = [statusA.data, statusB.data, statusC.data, statusD.data];

  const claim =
    claimFromStatus(watchedCodes[0], data[0]) ??
    claimFromStatus(watchedCodes[1], data[1]) ??
    claimFromStatus(watchedCodes[2], data[2]) ??
    claimFromStatus(watchedCodes[3], data[3]);

  const code = useAuthLinkLoginCode(enabled && claim === null);
  const minted = code.data ?? null;

  // Adjust-during-render (guarded): remember codes this panel put on screen,
  // and forget the ones the server says are gone.
  const nextWatched = advanceWatchedCodes(
    watchedCodes,
    data,
    minted === null ? null : minted.code,
  );
  if (!sameCodes(nextWatched, watchedCodes)) {
    setWatchedCodes(nextWatched);
  }

  // External death of the DISPLAYED code (denied in another window, expired,
  // consumed): refresh immediately rather than showing a dead QR until the
  // rotation interval. One refetch per observed code; the effect is external
  // sync (query → query), not a state transition.
  const refreshedForCode = useRef<string | null>(null);
  const displayedDatum =
    minted !== null && watchedCodes[0] === minted.code ? data[0] : null;
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
