import "../../../../../__tests__/test-browser-apis";

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
} from "@/components/layout/shell/shell-gestures";
import { useEdgeDragToOpenNav } from "@/components/layout/shell/use-edge-drag-to-open-nav";
import { useDragToDismissKeyboard } from "@/components/layout/shell/use-drag-to-dismiss-keyboard";
import { setMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * jsdom implements `TouchEvent` but ships no working `Touch` constructor, so a
 * touch here is a plain `Event` wearing the one shape the production
 * listeners read off it: a `touches` list of `{ clientX, clientY }` points, a
 * `target`, and a `timeStamp`. Dispatched straight at `document` - where every
 * recognizer under test listens in the capture phase - with `target`
 * overridden via `defineProperty` so a single call site can stand in for a
 * touch that landed on any element, not just `document` itself.
 */
interface FakeTouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * The production listeners read `touches` through both index access and
 * `.item()` (the real `TouchList` shape) - a bare array only covers the
 * first, so `.item()` is bolted on to match.
 */
function makeTouchList(
  points: ReadonlyArray<FakeTouchPoint>,
): ReadonlyArray<FakeTouchPoint> & {
  item(index: number): FakeTouchPoint | null;
} {
  return Object.assign([...points], {
    item: (index: number): FakeTouchPoint | null => points[index] ?? null,
  });
}

function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  options: {
    readonly touches: ReadonlyArray<FakeTouchPoint>;
    readonly target: EventTarget;
    readonly timeStamp: number;
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: makeTouchList(options.touches),
    configurable: true,
  });
  Object.defineProperty(event, "target", {
    value: options.target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: options.timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

/**
 * `touchend`/`touchcancel` carry no per-touch data either listener under test
 * reads (both handlers take no event parameter), so this only needs a
 * `timeStamp` for callers that care about ordering.
 */
function dispatchTouchEnd(
  type: "touchend" | "touchcancel",
  timeStamp: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "timeStamp", {
    value: timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

/**
 * The drawer's edge recognizer reads POINTER events, because the drag engine it
 * hands the gesture to is pointer-only. jsdom has no usable `PointerEvent`
 * constructor either, so the same trick as above: a plain `Event` wearing the
 * fields the recognizer actually reads - a coordinate pair, an identity, a
 * primary flag, a target and a timestamp.
 */
function dispatchPointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  options: {
    readonly clientX: number;
    readonly clientY: number;
    readonly target: EventTarget;
    readonly timeStamp: number;
    readonly pointerId: number;
    readonly isPrimary: boolean;
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", {
    value: options.clientX,
    configurable: true,
  });
  Object.defineProperty(event, "clientY", {
    value: options.clientY,
    configurable: true,
  });
  Object.defineProperty(event, "pointerId", {
    value: options.pointerId,
    configurable: true,
  });
  Object.defineProperty(event, "isPrimary", {
    value: options.isPrimary,
    configurable: true,
  });
  Object.defineProperty(event, "target", {
    value: options.target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: options.timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

function dispatchScroll(target: Element, timeStamp: number): void {
  const event = new Event("scroll", { bubbles: false, cancelable: false });
  Object.defineProperty(event, "target", {
    value: target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

function stubHorizontalPan(
  el: HTMLElement,
  metrics: { readonly scrollWidth: number; readonly clientWidth: number },
): void {
  Object.defineProperty(el, "scrollWidth", {
    value: metrics.scrollWidth,
    configurable: true,
  });
  Object.defineProperty(el, "clientWidth", {
    value: metrics.clientWidth,
    configurable: true,
  });
}

function stubVerticalScroller(
  el: HTMLElement,
  metrics: {
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly scrollTop: number;
  },
): void {
  Object.defineProperty(el, "scrollHeight", {
    value: metrics.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: metrics.clientHeight,
    configurable: true,
  });
  el.scrollTop = metrics.scrollTop;
}

let activeUnmounts: Array<() => void> = [];

interface EdgeDragActivation {
  readonly travelPx: number;
  readonly clientX: number;
}

/** The predicate for a screen with nothing already claiming the edge. */
const NOTHING_CLAIMED = (): boolean => false;

/**
 * The recognizer reports activations rather than opening the drawer itself, so
 * a probe records them. Deciding whether the drawer ends up open belongs to the
 * release rule (`resolvesToOpen`), not here - all this hook settles is whether
 * a pointer at the screen edge is a drawer pull at all.
 */
function mountEdgeDrag(options: {
  readonly claimedElsewhere: (target: EventTarget | null) => boolean;
}): ReadonlyArray<EdgeDragActivation> {
  const activations: EdgeDragActivation[] = [];
  const { unmount } = renderHook(() =>
    useEdgeDragToOpenNav({
      onActivate: (event, travelPx) => {
        activations.push({ travelPx, clientX: event.clientX });
      },
      claimedElsewhere: options.claimedElsewhere,
    }),
  );
  activeUnmounts.push(unmount);
  return activations;
}

function mountKeyboardDismiss(): void {
  const { unmount } = renderHook(() => useDragToDismissKeyboard());
  activeUnmounts.push(unmount);
}

function focusInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  return input;
}

afterEach(() => {
  activeUnmounts.forEach((unmount) => {
    unmount();
  });
  activeUnmounts = [];
  document.body.innerHTML = "";
  setMobileApp(false);
  useMobileNavStore.setState({ open: false });
});

describe("classifyDirectionalIntent", () => {
  it("activates once primary travel clears the threshold and leads the cross axis", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 20, crossPx: 0, elapsedMs: 100 }),
    ).toBe("activate");
  });

  it("fails at exactly the counter-direction threshold", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: -10, crossPx: 0, elapsedMs: 100 }),
    ).toBe("fail");
  });

  it("fails when cross-axis travel exceeds its budget and dominates the primary axis", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 5, crossPx: 15, elapsedMs: 100 }),
    ).toBe("fail");
  });

  it("waits while primary travel is under the activate threshold and not yet failing", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 10, crossPx: 0, elapsedMs: 100 }),
    ).toBe("wait");
  });

  it("stays wait for a 12px-primary / 4px-cross drag rather than activating early", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 12, crossPx: 4, elapsedMs: 100 }),
    ).toBe("wait");
  });
});

describe("commitsDirectionalGesture", () => {
  const limits = { commitPx: 48, velocityPxPerMs: 0.5 };

  it("commits once distance alone clears commitPx", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 50, crossPx: 0, elapsedMs: 1000 },
        limits,
      ),
    ).toBe(true);
  });

  it("commits on average velocity before distance is reached", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 20, crossPx: 0, elapsedMs: 20 },
        limits,
      ),
    ).toBe(true);
  });

  it("stays uncommitted below both the distance and velocity arms", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 10, crossPx: 0, elapsedMs: 100 },
        limits,
      ),
    ).toBe(false);
  });

  it("rejects a zero-duration sample rather than treating it as infinitely fast", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 5, crossPx: 0, elapsedMs: 0 },
        limits,
      ),
    ).toBe(false);
  });
});

describe("useEdgeDragToOpenNav", () => {
  it("hands off the gesture once a rightward drag from the edge declares itself", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 36,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
    // The travel is reported so the panel can meet the finger where the drag
    // declared itself rather than 16px behind it.
    expect(activations[0]?.travelPx).toBe(16);
    expect(activations[0]?.clientX).toBe(36);
  });

  // The third state is the point. A two-state recognizer has to decide on the
  // first pixel, so it either steals scrolls or misses swipes; an ambiguous
  // drag stays unclaimed until it declares itself.
  it("waits through an undeclared move and activates on the one that declares", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 30,
      clientY: 100,
      target: document.body,
      timeStamp: 50,
      pointerId: 1,
      isPrimary: true,
    });
    expect(activations.length).toBe(0);
    dispatchPointer("pointermove", {
      clientX: 40,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
    expect(activations[0]?.travelPx).toBe(20);
  });

  // Everything after the handoff belongs to the drag engine. A second
  // activation would start a competing pan session against the same transform.
  it("activates at most once per pointer", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 40,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
  });

  it("never activates for a pointer that lands outside the edge zone", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 100,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 200,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("leaves a vertical-dominant drag from the edge to whatever is scrolling", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 25,
      clientY: 150,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // A finger that comes back toward where it started has changed its mind, and
  // the gesture stays dead for the rest of that pointer rather than re-arming
  // if it wanders forward again.
  it("abandons the gesture for good once the finger returns toward the edge", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 5,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("aborts once a second pointer joins mid-gesture", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    // A pinch or a two-finger pan; neither is a drawer pull, and the tracked
    // pointer stops describing the gesture as a whole.
    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: document.body,
      timeStamp: 50,
      pointerId: 2,
      isPrimary: false,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("ignores moves belonging to a pointer it is not tracking", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 2,
      isPrimary: false,
    });
    expect(activations.length).toBe(0);
    // The tracked pointer is untouched by the stray one and still activates.
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
  });

  it("never activates when the mobile app flag is off", () => {
    setMobileApp(false);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("no-ops when the drawer is already open", () => {
    setMobileApp(true);
    useMobileNavStore.setState({ open: true });
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("does not activate while a text entry is focused", () => {
    setMobileApp(true);
    focusInput();
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("does not activate on a surface that declares its own touch handling", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });
    const ownHandling = document.createElement("div");
    ownHandling.style.touchAction = "none";
    document.body.appendChild(ownHandling);

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: ownHandling,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: ownHandling,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // How the drawer's own layer keeps the recognizer off itself: once the panel
  // is on screen it covers the edge zone, and a pointer landing there is
  // already a drag the panel handles. Starting a second one against the same
  // element would leave two pan sessions fighting for one transform.
  it("stands down when the caller says the target is claimed elsewhere", () => {
    setMobileApp(true);
    const claimed = document.createElement("div");
    document.body.appendChild(claimed);
    const activations = mountEdgeDrag({
      claimedElsewhere: (target) => target === claimed,
    });

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: claimed,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: claimed,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });
});

describe("useDragToDismissKeyboard", () => {
  it("blurs on a tap outside the focused field", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).not.toBe(input);
  });

  it("does not blur on a tap inside the focused field", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();

    dispatchTouch("touchstart", {
      touches: [{ clientX: 10, clientY: 10 }],
      target: input,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(input);
  });

  it("does not treat a touch that travels past the tap slop as a tap", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    // Euclidean travel of ~8.49px, over the 8px slop, and primary/cross both
    // stay under the drag arm's own activate threshold so it never takes over
    // either.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 106, clientY: 106 }],
      target: outside,
      timeStamp: 50,
    });
    dispatchTouchEnd("touchend", 60);

    expect(document.activeElement).toBe(input);
  });

  it("does nothing on any arm when no text entry is focused", () => {
    setMobileApp(true);
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 100, clientY: 160 }],
      target: outside,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(document.body);
  });

  it("blurs on a downward drag past the commit distance over a non-scrollable target", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    // Activates (20px) but stays under the 40px commit distance.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 120 }],
      target,
      timeStamp: 100,
    });
    expect(document.activeElement).toBe(input);
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 145 }],
      target,
      timeStamp: 200,
    });

    expect(document.activeElement).not.toBe(input);
  });

  it("does not arm the drag arm over a scroller that is scrolled away from its top", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 50,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 0,
    });
    // Would clear the drag arm's commit distance if it were armed.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 160 }],
      target: scroller,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("blurs on a scroll flick sampled at least 30ms apart that exceeds the velocity threshold", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    // Away from its top, so the touchstart hands this drag to the scroller
    // rather than arming the drag arm - the scenario the sampler exists for.
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 100,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 990,
    });
    // Past the tap slop, so release reads the sampled scroll instead of
    // treating this as a stationary tap.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: scroller,
      timeStamp: 995,
    });
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 20;
    // 80px over 40ms is 2px/ms, past the 1.5px/ms dismiss threshold.
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).not.toBe(input);
  });

  it("does not blur on a gentle scroll under the velocity threshold", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 100,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 990,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: scroller,
      timeStamp: 995,
    });
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 80;
    // 20px over 40ms is 0.5px/ms, under the 1.5px/ms dismiss threshold.
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur on two fast scroll events with no live touch sequence", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    scroller.scrollTop = 100;

    // No touchstart ever ran, so the sampler has no touched node to bind this
    // scroll to - a fast flick elsewhere in the app must not read as the
    // user's own gesture just because a text entry happens to be focused.
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 20;
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur when an unrelated element scrolls fast during a live sequence elsewhere", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const elementA = document.createElement("div");
    const elementB = document.createElement("div");
    document.body.appendChild(elementA);
    document.body.appendChild(elementB);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: elementA,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: elementA,
      timeStamp: 10,
    });
    // B is a sibling of A, neither an ancestor nor the touched node itself -
    // its scroll is not the live gesture's, however fast it moves.
    elementB.scrollTop = 100;
    dispatchScroll(elementB, 1000);
    elementB.scrollTop = 20;
    dispatchScroll(elementB, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur on an upward drag", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 50 }],
      target,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur for a gesture on a surface that declares its own touch handling", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const ownHandling = document.createElement("div");
    ownHandling.style.touchAction = "none";
    document.body.appendChild(ownHandling);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: ownHandling,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 150 }],
      target: ownHandling,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur the newly-focused field when focus moves away mid-gesture before the tap commits", () => {
    setMobileApp(true);
    focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    // A route change or picker autofocusing its own field mid-gesture - the
    // dismiss is still pinned to the field the gesture started on, not
    // whichever one happens to hold focus at release.
    const fieldB = focusInput();
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(fieldB);
  });

  it("does not blur the newly-focused field when focus moves away mid-gesture before the drag commits", () => {
    setMobileApp(true);
    focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    // Activates (20px) but stays under the 40px commit distance.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 120 }],
      target,
      timeStamp: 100,
    });
    const fieldB = focusInput();
    // Crosses the commit distance, which dismisses synchronously from inside
    // this move rather than waiting for touchend.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 145 }],
      target,
      timeStamp: 200,
    });

    expect(document.activeElement).toBe(fieldB);
  });

  it("does not blur when the mobile app flag is off", () => {
    const input = focusInput();
    setMobileApp(false);
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(input);
  });
});

// `stubHorizontalPan` backs a case the module-level scenarios above don't
// otherwise exercise: a target that pans horizontally is still excluded from
// the edge drag even when it doesn't declare `touch-action: none` outright.
describe("useEdgeDragToOpenNav - horizontal pan surfaces", () => {
  it("does not activate on a rail that already pans sideways", () => {
    setMobileApp(true);
    const activations = mountEdgeDrag({ claimedElsewhere: NOTHING_CLAIMED });
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    stubHorizontalPan(rail, { scrollWidth: 600, clientWidth: 300 });
    document.body.appendChild(rail);

    dispatchPointer("pointerdown", {
      clientX: 20,
      clientY: 100,
      target: rail,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 90,
      clientY: 100,
      target: rail,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });
});
