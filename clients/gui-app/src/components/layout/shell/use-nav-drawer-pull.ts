import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
} from "@/components/layout/shell/shell-gestures";
import { NAV_DRAWER_EDGE_ZONE_PX } from "@/components/layout/shell/nav-drawer-motion";
import { isMobileApp } from "@/lib/mobile-app";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

export interface NavDrawerPullHandlers {
  /**
   * Called once, on the move that declares the drag ours: the pointer event
   * that declared it, the travel along the pull's OWN direction, and which
   * direction that was. The caller hands the event straight to the drag engine
   * and owns everything after this point; the recognizer forgets the gesture.
   */
  readonly onActivate: (
    event: PointerEvent,
    travelPx: number,
    closing: boolean,
  ) => void;
  /** Whether the pointer landed on the drawer panel itself. */
  readonly withinPanel: (target: EventTarget | null) => boolean;
  /**
   * Whether the pointer landed anywhere on the drawer's own layer.
   *
   * Asked of the hit test rather than of the drawer's state, and that is what
   * makes it correct: the scrim only accepts pointers while it is showing
   * something, so a pointer reaching it IS the statement that the layer owns
   * this gesture. A predicate mirroring `open` instead would be blind for the
   * length of an opening settle, when the scrim is live but the drawer is not
   * yet open - and a pointer landing there would be claimed twice, once by the
   * scrim and once here, leaving two pan sessions driving one transform.
   */
  readonly withinLayer: (target: EventTarget | null) => boolean;
}

interface NavDrawerPullTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  /** Which way this pull has to travel to count as intent. */
  readonly closing: boolean;
}

/**
 * Arbitration for both drawer pulls: the left-edge pull that opens it, and the
 * pull on the panel itself that closes it. The header's hamburger stays either
 * way - a gesture with no visible affordance cannot be the sole path to a
 * navigation surface, so these are accelerators.
 *
 * ONE classifier for both, and that is the point. The panel is a scrolling
 * surface, so the question "is this drag mine" is sharper there than at the
 * screen edge: the finger is usually asking to scroll, and a horizontal drag
 * engine that claims on raw travel takes a share of those. Any second answer to
 * that question - a drag engine's own axis lock, say - is a second set of
 * thresholds deciding the same thing, and the two disagree exactly where it
 * shows: on the near-vertical drags a hand makes by the hundred.
 *
 * This recognizer decides ONE thing - whether a pointer is a drawer pull - and
 * then gets out of the way. It does not decide whether the drawer opens or
 * closes; that is the release's job, and by then the panel has been tracking
 * the finger long enough for the user to have watched the answer coming and
 * changed their mind.
 *
 * The pointer passes through three states. It is unclaimed until the motion
 * declares an axis (`classifyDirectionalIntent`), which is what lets a vertical
 * scroll that starts in the edge zone stay a scroll. Once it activates the
 * classifier is never consulted again: a committed horizontal drag that later
 * curves downward is still the drawer's, and re-classifying per move is how a
 * recognizer cancels itself mid-gesture.
 *
 * Pointer events rather than touch events because the drag engine's gesture
 * stack is pointer-only and needs a real `PointerEvent` to adopt the gesture
 * from here. The classifier reads nothing but `clientX` / `clientY` /
 * `timeStamp`, all of which both event families carry.
 *
 * The system back-swipe would contend for exactly this edge, but WKWebView
 * leaves `allowsBackForwardNavigationGestures` off unless an app turns it on
 * and the mobile shell never does - the horizontal axis at the edge is
 * unowned, and should stay that way.
 *
 * Listens in the CAPTURE phase at the document, so a surface that stops
 * propagation for its own handling cannot silently disable the drawer. Passive
 * throughout: it never calls `preventDefault`, and a non-passive
 * document-level listener would tax every scroll in the app for a gesture that
 * fires rarely.
 */
export function useNavDrawerPull(handlers: NavDrawerPullHandlers): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time the surface re-renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // PRODUCT gate, not a layout one: a narrow desktop browser renders the
    // mobile shell, and an edge drag there is a trackpad user's horizontal
    // scroll rather than a drawer pull.
    if (!isMobileApp()) return;
    let tracking: NavDrawerPullTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a
      // drawer pull, and the tracked pointer's coordinates stop describing the
      // gesture as a whole.
      if (tracking !== null) {
        tracking = null;
        return;
      }
      if (!event.isPrimary) return;
      // Landing ON the panel is a close pull, whatever the drawer's semantic
      // state says: the panel is `inert` whenever it is parked shut, so a
      // pointer can only reach it while it is on screen - settled open, or
      // still travelling, which is what makes a settle interruptible.
      const closing = handlersRef.current.withinPanel(event.target);
      if (!closing) {
        // Anything else on the layer is the scrim, which claims its own
        // pointers the instant they land and needs no classifier. Standing
        // down here is what keeps a single gesture from being started twice.
        if (handlersRef.current.withinLayer(event.target)) return;
        // The zone is 32px of APP SURFACE. In landscape the surface does not
        // begin at zero - the sensor housing's inset can be wider than the
        // zone itself, which would leave the whole thing inside the cutout
        // with no touch able to reach it - so the inset moves where the zone
        // starts without changing how wide it is. Bounded on BOTH sides for
        // that reason: an upper bound alone would stretch the strip back over
        // the cutout it was moved out of, making it the inset's width plus the
        // zone's rather than the zone's alone.
        const surfaceLeft = readSafeAreaInsets().left;
        if (event.clientX < surfaceLeft) return;
        if (event.clientX > surfaceLeft + NAV_DRAWER_EDGE_ZONE_PX) return;
      }
      // A focused text entry is deliberately NOT a reason to stand down. The
      // edge belongs to the drawer whether or not the keyboard is up, and
      // asking for the menu mid-draft is an ordinary thing to do - the caller
      // drops the keyboard as part of opening, so the two do not have to share
      // the screen. A tap still reaches the field: nothing is claimed until the
      // classifier sees 15px of horizontal-dominant travel.
      if (ownsHorizontalGesture(event.target)) return;
      tracking = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        closing,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Travel along the pull's own direction, so one classifier reads both:
      // rightward opens, leftward closes, and each is positive to itself.
      const travelPx = started.closing
        ? started.x - event.clientX
        : event.clientX - started.x;
      const intent = classifyDirectionalIntent({
        primaryPx: travelPx,
        crossPx: event.clientY - started.y,
        elapsedMs: event.timeStamp - started.at,
      });
      if (intent === "fail") {
        tracking = null;
        return;
      }
      if (intent === "wait") return;
      // One activation per pointer: the rest of this gesture belongs to the
      // panel, which tracks the finger and decides for itself at release.
      tracking = null;
      handlersRef.current.onActivate(event, travelPx, started.closing);
    };

    const endGesture = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      tracking = null;
    };

    const options = { capture: true, passive: true };
    document.addEventListener("pointerdown", handlePointerDown, options);
    document.addEventListener("pointermove", handlePointerMove, options);
    document.addEventListener("pointerup", endGesture, options);
    document.addEventListener("pointercancel", endGesture, options);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      document.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      document.removeEventListener("pointerup", endGesture, { capture: true });
      document.removeEventListener("pointercancel", endGesture, {
        capture: true,
      });
    };
  }, []);
}
