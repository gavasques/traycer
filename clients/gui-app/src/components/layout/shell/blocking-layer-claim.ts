import { useEffect } from "react";

/**
 * A count, not a boolean, because two blocking surfaces can overlap and the
 * first one to unmount must not hand the app back while the second is still
 * up. Module-scoped for the same reason the DOM barrier it complements is
 * document-scoped: "is the app reachable right now" is one question with one
 * answer, whoever is asking.
 */
let claims = 0;

/**
 * Declares that a surface is blocking the app underneath it, and returns the
 * release. Paired calls only - a claim that is never released leaves the app
 * permanently unreachable to anything that asks.
 */
export function claimBlockingLayer(): () => void {
  claims += 1;
  let released = false;
  return () => {
    // Idempotent because an effect cleanup can be invoked more than once under
    // a remount, and a double release would decrement a count this claim only
    // ever incremented once - handing the app back while a second surface is
    // still blocking it.
    if (released) return;
    released = true;
    claims -= 1;
  };
}

/** Whether any surface currently claims to be blocking the app. */
export function blockingLayerClaimed(): boolean {
  return claims > 0;
}

/**
 * The claim as a surface declares it: held for as long as `active`, released on
 * unmount.
 *
 * For blocking surfaces that do NOT go through the dismissable-layer
 * primitive's modal machinery - the ones that implement containment
 * themselves, by inerting a subtree rather than by making the whole document
 * inert. Those never set the body barrier `modalLayerCoversApp` reads, so
 * without this they are invisible to anything asking whether the app is
 * reachable, and a document-level gesture recognizer would answer a swipe over
 * a modal the user is required to address.
 *
 * A surface that mounts an ordinary modal dialog needs none of this: the
 * barrier already speaks for it, and claiming as well would be a second source
 * of truth for the same fact.
 */
export function useBlockingLayerClaim(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return claimBlockingLayer();
  }, [active]);
}
