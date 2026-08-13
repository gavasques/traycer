import type { ValueAnimationTransition } from "motion/react";

/**
 * The physical constants and the release rule for the navigation drawer's
 * follow-the-finger drag. Kept apart from the surface that renders it so the
 * decision the release makes is a pure function with no DOM in reach.
 */

/**
 * How far from the left edge a pointer must land for the pull to be a drawer
 * gesture rather than a touch on whatever surface is underneath.
 *
 * The only absolute measurement in this file, and it is absolute because the
 * thing it describes is: a fingertip is the same size on a 4.7" phone as on a
 * tablet, so a zone expressed as a fraction of the viewport would be an
 * unhittable sliver on one and a wide dead band on the other. Every other
 * threshold here is either a viewport fraction or density-independent physics.
 *
 * The strip is carved out of whichever surface is underneath - a chat timeline,
 * the canvas, a terminal - so every pixel of it is a pixel those surfaces lose.
 * Wide enough for a thumb reaching across the screen, narrow enough that
 * content is not routinely touched here.
 */
export const NAV_DRAWER_EDGE_ZONE_PX = 32;

/**
 * Release speed that commits the gesture on its own, in px per SECOND - the
 * unit motion reports pointer velocity in, so it crosses no conversion.
 *
 * The speed arm is what separates a gesture that feels connected to the hand
 * from one that feels dutiful: a flick that has barely travelled still commits,
 * the way every platform drawer behaves. It needs no minimum distance of its
 * own, because the intent classifier already required travel before the drag
 * could begin.
 */
export const NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S = 500;

/**
 * Fraction of the PANEL's own travel a slow release must have covered to
 * commit.
 *
 * Measured against the panel rather than the viewport, and that distinction is
 * load-bearing rather than cosmetic. The panel is `w-3/4` capped at a maximum,
 * so on a wide screen it stops growing while the viewport keeps going: a
 * viewport-derived arm on a landscape tablet lands further out than the panel
 * can ever travel, and no slow drag commits in either direction - the gesture
 * silently degrades to flick-only. Deriving from the travel that actually
 * exists makes the arm reachable at every size by construction, and asks for
 * the same share of the panel on every device.
 */
export const NAV_DRAWER_COMMIT_TRAVEL_FRACTION = 1 / 3;

/**
 * The settle. One spring for both directions, because one physical object
 * cannot arrive by one rule and leave by another - a drawer that opens with a
 * different weight than it closes reads as two surfaces wearing the same
 * pixels.
 *
 * `visualDuration` describes the time to visually arrive rather than the time
 * for the spring's tail to decay, so this stays a ~220ms settle regardless of
 * how far the panel has left to travel; the near-zero bounce keeps it from
 * overshooting into the gap it just closed.
 */
export const NAV_DRAWER_SETTLE: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.22,
  bounce: 0.05,
};

/**
 * The settle under a reduced-motion preference: arrive, do not travel. The drag
 * itself is untouched - direct manipulation is not motion the interface chose
 * to play, it is the finger, and taking it away would leave no gesture at all.
 */
export const NAV_DRAWER_SETTLE_REDUCED: ValueAnimationTransition<number> = {
  duration: 0,
};

export interface NavDrawerRelease {
  /** Panel travel at release: 0 fully closed, `widthPx` fully open. */
  readonly positionPx: number;
  /** Measured panel width, so nothing here assumes a drawer size. */
  readonly widthPx: number;
  /** Signed pointer velocity along x at release, px per second. */
  readonly velocityPxPerS: number;
  /** Which resting position the gesture began from. */
  readonly openAtGestureStart: boolean;
}

/**
 * Where a released drag settles to.
 *
 * Velocity is read first and in absolute terms: a fast flick decides the
 * direction whatever the distance says, including the flick that reverses a
 * drag most of the way through. Only a release that is effectively stationary
 * falls through to the distance arm, and that arm measures travel FROM the
 * resting position the gesture started at - so the same share of the panel
 * opens a closed drawer and closes an open one.
 *
 * The distance arm is derived here rather than passed in, which is what keeps
 * it inside the travel the panel actually has. A caller that computed the
 * threshold from anything else - a viewport, a breakpoint, a constant - could
 * hand in a distance the drag can never reach, and the failure would look like
 * a drawer that simply ignores slow drags rather than like a bad number.
 */
export function resolvesToOpen(release: NavDrawerRelease): boolean {
  if (release.velocityPxPerS > NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S) return true;
  if (release.velocityPxPerS < -NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S) {
    return false;
  }
  const commitTravelPx = release.widthPx * NAV_DRAWER_COMMIT_TRAVEL_FRACTION;
  if (release.openAtGestureStart) {
    return release.widthPx - release.positionPx < commitTravelPx;
  }
  return release.positionPx >= commitTravelPx;
}
