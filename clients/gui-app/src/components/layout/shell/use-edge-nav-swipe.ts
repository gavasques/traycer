import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
  withinTextEntry,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/**
 * Width of the strip at each screen edge that answers a navigation swipe.
 *
 * The only absolute measurement here, and it is absolute because the thing it
 * describes is: a fingertip is the same size on a 4.7" phone as on a tablet, so
 * a zone expressed as a fraction of the viewport would be an unhittable sliver
 * on one and a wide dead band on the other.
 *
 * The strip is carved out of whichever surface is underneath - a chat timeline,
 * the canvas, a terminal - so every pixel of it is a pixel those surfaces lose.
 * Wide enough for a thumb reaching across the screen, narrow enough that
 * content is not routinely touched here. The epic row's swipe tray reserves a
 * strip of the same width for the same reason, and yields it to this.
 */
const EDGE_ZONE_PX = 32;

export type EdgeNavDirection = "back" | "forward";

export interface EdgeNavSwipeHandlers {
  /**
   * Called once, on the move that declares the drag a navigation swipe. The
   * caller performs the navigation; nothing about the gesture survives past
   * this call.
   */
  readonly onNavigate: (direction: EdgeNavDirection) => void;
  /**
   * Whether something on screen already owns the screen edges - the navigation
   * drawer while it is out, a modal layer, a surface blocking the app by its
   * own means. Asked at pointer-down AND on every move the gesture has not yet
   * committed to, so a surface that appears mid-contact takes the edges with it
   * rather than inheriting a swipe aimed at the screen it replaced.
   */
  readonly edgesClaimed: () => boolean;
}

interface EdgeNavSwipeTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly direction: EdgeNavDirection;
}

/**
 * The platform's navigation swipes: a drag inward from the leading edge goes
 * BACK, a drag inward from the trailing edge goes FORWARD. Both are
 * accelerators for navigation the app offers elsewhere, which is what lets them
 * be invisible - a gesture with no affordance may never be the only way to
 * reach something.
 *
 * Each edge answers ONE direction, the one that travels inward from it, and the
 * classifier's counter-direction arm enforces it: a leftward drag that starts
 * at the leading edge is a swipe away from the screen, not a back that changed
 * its mind. That is what keeps the two zones from ever both claiming a gesture,
 * and it matches every system where the same strip does not answer both ways.
 *
 * The zones are measured from the app surface rather than from raw viewport
 * coordinates. In landscape the sensor housing's inset can be wider than a zone
 * itself, which would leave the whole strip inside the cutout with no touch
 * able to reach it - so the inset moves where a zone starts without changing
 * how wide it is. Bounded on both sides for that reason: one bound alone would
 * stretch the strip back over the cutout it was moved out of.
 *
 * A pointer passes through two states. It is unclaimed until the motion
 * declares an axis (`classifyDirectionalIntent`), which is what lets a vertical
 * scroll that starts in a zone stay a scroll and a tap near the edge stay a
 * tap. Once it activates the classifier is never consulted again - the gesture
 * is over at that instant, since navigation is a discrete step rather than
 * something the finger drags.
 *
 * Two surfaces are refused outright, both because the finger is already inside
 * a gesture of their own: anything that pans sideways
 * (`ownsHorizontalGesture` - a tab rail, a code block, the attachment strip),
 * and any text entry (`withinTextEntry`), where a horizontal drag is the caret
 * being dragged through the text. The composer spans the full width, so its own
 * left edge sits in the leading zone; without that second check every attempt
 * to select a word at the start of a line would navigate away from the draft.
 *
 * Listens in the CAPTURE phase at the document, so a surface that stops
 * propagation for its own handling cannot silently disable navigation. Passive
 * throughout: it never calls `preventDefault`, and a non-passive
 * document-level listener would tax every scroll in the app for a gesture that
 * fires rarely.
 */
export function useEdgeNavSwipe(handlers: EdgeNavSwipeHandlers): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time the shell re-renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // PRODUCT gate, not a layout one: a narrow desktop browser renders the
    // mobile shell, and an edge drag there is a trackpad user's horizontal
    // scroll rather than a navigation swipe. It also has the header's
    // back/forward arrows, which this gesture is the phone's stand-in for.
    if (!isMobileApp()) return;
    let tracking: EdgeNavSwipeTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a
      // navigation swipe, and the tracked pointer's coordinates stop describing
      // the gesture as a whole.
      if (tracking !== null) {
        tracking = null;
        return;
      }
      if (!event.isPrimary) return;
      if (handlersRef.current.edgesClaimed()) return;
      const direction = edgeDirectionAt(event.clientX);
      if (direction === null) return;
      if (ownsHorizontalGesture(event.target)) return;
      if (withinTextEntry(event.target)) return;
      tracking = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        direction,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Asked again on every undecided move, not only at pointer-down. A
      // blocking surface can arrive DURING the contact - a migration frame
      // lands, a dialog opens on a keystroke elsewhere - and the finger that
      // was travelling over an ordinary screen is now travelling over a
      // surface the user has to address. Nothing about when a claimant
      // registers can cover that; only re-asking can. The gesture is dropped
      // rather than held, because a claim that appears mid-contact does not
      // retract when the layer closes: the swipe that started under one screen
      // is not owed to the next one.
      if (handlersRef.current.edgesClaimed()) {
        tracking = null;
        return;
      }
      // Travel along the swipe's own inward direction, so one classifier reads
      // both edges and each is positive to itself.
      const travelPx =
        started.direction === "back"
          ? event.clientX - started.x
          : started.x - event.clientX;
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
      // One navigation per pointer. The rest of the drag is nothing: the step
      // has already happened, and a second one would take the user two
      // surfaces back for a single swipe.
      tracking = null;
      handlersRef.current.onNavigate(started.direction);
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

/**
 * Which navigation an edge answers, or `null` for the screen between them.
 *
 * The leading edge is checked first so a viewport narrow enough for the two
 * zones to overlap resolves to one of them rather than to whichever comparison
 * ran last. Back wins that tie because it is the gesture with somewhere to go:
 * forward only exists after a back.
 */
function edgeDirectionAt(clientX: number): EdgeNavDirection | null {
  const insets = readSafeAreaInsets();
  const surfaceLeft = insets.left;
  if (clientX >= surfaceLeft && clientX <= surfaceLeft + EDGE_ZONE_PX) {
    return "back";
  }
  const surfaceRight = window.innerWidth - insets.right;
  if (clientX <= surfaceRight && clientX >= surfaceRight - EDGE_ZONE_PX) {
    return "forward";
  }
  return null;
}
