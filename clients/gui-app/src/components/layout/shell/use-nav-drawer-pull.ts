import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  isTextEntryFocused,
  ownsHorizontalGesture,
} from "@/components/layout/shell/shell-gestures";
import { NAV_DRAWER_EDGE_ZONE_PX } from "@/components/layout/shell/nav-drawer-motion";
import { isMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

export interface EdgeDragToOpenNavHandlers {
  /**
   * Called once, on the move that declares the drag ours, with the pointer
   * event that declared it and the horizontal travel so far. The caller hands
   * the event straight to the drag engine and owns everything after this
   * point; the recognizer forgets the gesture.
   */
  readonly onActivate: (event: PointerEvent, travelPx: number) => void;
  /**
   * Nodes the recognizer must not claim a touch from. The drawer's own layer
   * is the case that matters: once the panel is on screen it covers the edge
   * zone, and a pointer landing on it is already a drag the panel handles
   * itself - starting a second one against the same element would leave two
   * pan sessions fighting for one transform.
   */
  readonly claimedElsewhere: (target: EventTarget | null) => boolean;
}

interface EdgeDragTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/**
 * Left-edge pull that opens the mobile navigation drawer - the same surface the
 * header's hamburger opens. The hamburger stays: this is an accelerator, never
 * the only way in, because a gesture with no visible affordance cannot be the
 * sole path to a navigation surface.
 *
 * This recognizer decides ONE thing - whether a pointer that came down at the
 * screen edge is a drawer pull - and then gets out of the way. It does not
 * decide whether the drawer opens; that is the release's job, and by then the
 * panel has been tracking the finger long enough for the user to have watched
 * the answer coming and changed their mind.
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
export function useEdgeDragToOpenNav(
  handlers: EdgeDragToOpenNavHandlers,
): void {
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
    let tracking: EdgeDragTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a
      // drawer pull, and the tracked pointer's coordinates stop describing the
      // gesture as a whole.
      if (tracking !== null) {
        tracking = null;
        return;
      }
      if (!event.isPrimary) return;
      if (event.clientX > NAV_DRAWER_EDGE_ZONE_PX) return;
      // Read the store at gesture time rather than subscribing: the open state
      // changes on every hamburger tap, and re-running this effect to
      // re-attach four listeners for it is churn the gesture does not need.
      // Nothing here renders, so there is no stale-render hazard.
      if (useMobileNavStore.getState().open) return;
      if (handlersRef.current.claimedElsewhere(event.target)) return;
      // Dragging while the keyboard is up is how a thumb rests, not how a menu
      // is asked for - and opening the drawer would take the draft's focus
      // with it.
      if (isTextEntryFocused()) return;
      if (ownsHorizontalGesture(event.target)) return;
      tracking = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      const travelPx = event.clientX - started.x;
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
      handlersRef.current.onActivate(event, travelPx);
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
