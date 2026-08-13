import { describe, expect, it } from "vitest";
import {
  NAV_DRAWER_COMMIT_TRAVEL_FRACTION,
  resolvesToOpen,
  type NavDrawerRelease,
} from "@/components/layout/shell/nav-drawer-motion";

/**
 * A 300px panel, so the distance arm sits at 100px. Every case below is one of
 * these two releases with one field changed, and the case name says which - the
 * numbers themselves carry no meaning beyond landing on one side of that arm.
 */
const PANEL_WIDTH_PX = 300;
const COMMIT_TRAVEL_PX = PANEL_WIDTH_PX * NAV_DRAWER_COMMIT_TRAVEL_FRACTION;

const FROM_CLOSED: NavDrawerRelease = {
  positionPx: 0,
  widthPx: PANEL_WIDTH_PX,
  velocityPxPerS: 0,
  openAtGestureStart: false,
};

const FROM_OPEN: NavDrawerRelease = {
  positionPx: PANEL_WIDTH_PX,
  widthPx: PANEL_WIDTH_PX,
  velocityPxPerS: 0,
  openAtGestureStart: true,
};

describe("resolvesToOpen - from closed", () => {
  it("opens on a slow release past the distance arm", () => {
    expect(resolvesToOpen({ ...FROM_CLOSED, positionPx: 200 })).toBe(true);
  });

  it("springs back on a slow release short of the distance arm", () => {
    expect(resolvesToOpen({ ...FROM_CLOSED, positionPx: 60 })).toBe(false);
  });

  // The arm that makes the gesture feel connected to the hand rather than
  // dutiful: the platform's own drawers commit on a flick that has barely
  // moved, and a distance-only rule feels stuck beside them.
  it("opens on a flick that has barely travelled", () => {
    expect(
      resolvesToOpen({ ...FROM_CLOSED, positionPx: 10, velocityPxPerS: 900 }),
    ).toBe(true);
  });

  // Velocity is read before distance on purpose. A drag most of the way open
  // and then thrown back is a change of mind, and honouring the throw over the
  // distance already covered is what the hand expects.
  it("springs back when a nearly-open drag is flung the other way", () => {
    expect(
      resolvesToOpen({ ...FROM_CLOSED, positionPx: 280, velocityPxPerS: -900 }),
    ).toBe(false);
  });

  it("opens at exactly the distance arm", () => {
    expect(
      resolvesToOpen({ ...FROM_CLOSED, positionPx: COMMIT_TRAVEL_PX }),
    ).toBe(true);
  });
});

describe("resolvesToOpen - from open", () => {
  // Travel is measured from the resting position the gesture STARTED at, so the
  // same share of the panel that opens a closed drawer closes an open one - and
  // a short tug that lets go stays open.
  it("stays open when the release has not travelled far enough back", () => {
    expect(resolvesToOpen({ ...FROM_OPEN, positionPx: 250 })).toBe(true);
  });

  it("closes on a slow release past the distance arm", () => {
    expect(resolvesToOpen({ ...FROM_OPEN, positionPx: 100 })).toBe(false);
  });

  it("closes on a flick from near fully open", () => {
    expect(
      resolvesToOpen({ ...FROM_OPEN, positionPx: 295, velocityPxPerS: -900 }),
    ).toBe(false);
  });

  it("stays open when a nearly-closed drag is flung back open", () => {
    expect(
      resolvesToOpen({ ...FROM_OPEN, positionPx: 20, velocityPxPerS: 900 }),
    ).toBe(true);
  });
});

// Both velocity arms are strict comparisons, so a release sitting exactly on
// the threshold is not a flick and has to fall through to distance. Each
// direction is pinned separately because a stray `>=` on either one would
// retune the gesture in that direction alone, which is the kind of asymmetry
// nobody notices until the drawer opens more eagerly than it closes.
describe("resolvesToOpen - the velocity arms are exclusive", () => {
  it("falls through to distance at exactly the positive threshold", () => {
    expect(
      resolvesToOpen({ ...FROM_CLOSED, positionPx: 10, velocityPxPerS: 500 }),
    ).toBe(false);
  });

  it("falls through to distance at exactly the negative threshold", () => {
    expect(
      resolvesToOpen({ ...FROM_OPEN, positionPx: 295, velocityPxPerS: -500 }),
    ).toBe(true);
  });
});

/**
 * The distance arm has to stay inside the travel the panel actually has. A
 * threshold derived from anything wider than the panel - a viewport, say -
 * lands beyond what any drag can reach, and the drawer degrades to flick-only
 * with no error anywhere: slow drags simply stop working, in both directions.
 *
 * The widths span a phone panel, the capped tablet panel, and two sizes past
 * anything shipped, because the failure this guards against only appeared once
 * the panel stopped growing with the screen.
 */
describe("resolvesToOpen - the distance arm scales with the panel", () => {
  const WIDTHS = [240, 292, 384, 768, 1024];

  it("commits a slow drag that reaches the panel's full extent, at every width", () => {
    for (const widthPx of WIDTHS) {
      expect(
        resolvesToOpen({
          positionPx: widthPx,
          widthPx,
          velocityPxPerS: 0,
          openAtGestureStart: false,
        }),
      ).toBe(true);
    }
  });

  it("puts the arm at the same share of the panel at every width", () => {
    for (const widthPx of WIDTHS) {
      const arm = widthPx * NAV_DRAWER_COMMIT_TRAVEL_FRACTION;
      const shared = {
        widthPx,
        velocityPxPerS: 0,
        openAtGestureStart: false,
      };
      expect(resolvesToOpen({ ...shared, positionPx: arm })).toBe(true);
      expect(resolvesToOpen({ ...shared, positionPx: arm - 1 })).toBe(false);
    }
  });
});
