import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  animate,
  m,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type AnimationPlaybackControls,
  type PanInfo,
} from "motion/react";
import {
  NAV_DRAWER_SETTLE,
  NAV_DRAWER_SETTLE_REDUCED,
  resolvesToOpen,
} from "@/components/layout/shell/nav-drawer-motion";
import { useEdgeDragToOpenNav } from "@/components/layout/shell/use-edge-drag-to-open-nav";
import { useModalSurfaceContainment } from "@/components/layout/shell/use-modal-surface-containment";
import { cn } from "@/lib/utils";

interface MobileNavDrawerSurfaceProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly children: ReactNode;
}

/**
 * The mobile navigation drawer's frame: one motion-owned panel that the finger
 * drags in both directions, plus the modal semantics that attach to it once it
 * has settled open.
 *
 * VISUAL AND SEMANTIC STATE ARE DECOUPLED, and that split is the whole design.
 * The visual state is a continuous `x` the drag engine owns - it tracks the
 * finger 1:1, springs, and can be interrupted mid-flight. The semantic state is
 * the discrete `open` boolean, and it flips only at a settled endpoint. A
 * panel that is 30% out may still spring back, so trapping focus into it would
 * trap focus into something about to disappear; and an assistive-technology
 * user has no "mid-drag" state at all, so what they are told must key off a
 * binary settle rather than off a transform.
 *
 * The panel is mounted for the app's whole life, parked off screen by the
 * wrapper's transform. It has to be: the drag engine's imperative start
 * forwards to components that have already subscribed, so against an unmounted
 * panel it is a silent no-op, and mounting on gesture start cannot work either
 * because the pointer event that would have begun the drag is gone by the time
 * the new subtree has rendered.
 *
 * Both directions are one drag on one element. The open pull comes in through
 * the edge recognizer, which hands its pointer event to the same drag controls
 * the panel exposes; the close pull is a pointer landing on the panel itself.
 * One engine, one spring, one release rule - so the drawer arrives and leaves
 * with the weight of a single physical object.
 */
export function MobileNavDrawerSurface(
  props: MobileNavDrawerSurfaceProps,
): ReactNode {
  const { open, onOpenChange, children } = props;
  const dragControls = useDragControls();
  // 0 is fully closed, `width` fully open. The wrapper carries the -100% that
  // parks the panel off screen, so this value never has to be seeded from a
  // measurement to render correctly on the very first frame.
  const x = useMotionValue(0);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const settleRef = useRef<AnimationPlaybackControls | null>(null);
  // The endpoint the running settle is travelling to, or null when none is.
  // Kept so a resize mid-flight can re-aim it at the width that now exists.
  const settleTargetRef = useRef<boolean | null>(null);
  const draggingRef = useRef(false);
  const openAtGestureStartRef = useRef(false);
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  // True from the moment a gesture or a programmatic settle takes the panel off
  // a resting position until it reaches the next one.
  const [inFlight, setInFlight] = useState(false);
  const reducedMotion = useReducedMotion();

  // `open` is the REQUEST - what a tap on the hamburger, a menu row or Escape
  // asked for. `settledOpen` is what is actually true of the surface right now.
  // They agree at rest and differ for the length of a settle, and every
  // semantic consequence keys off the second one: a panel still sliding into
  // place has trapped nothing yet, and one still sliding out is still covering
  // the app. Collapsing the two would announce a dialog to assistive
  // technology while it is off screen, and hand the app back while a drawer is
  // still on top of it.
  const [settledOpen, setSettledOpen] = useState(open);
  const settledOpenRef = useRef(settledOpen);
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    openRef.current = open;
    onOpenChangeRef.current = onOpenChange;
    reducedMotionRef.current = reducedMotion;
  });

  // Written through eagerly rather than left to the next render pass, so a
  // resize arriving before that commit still parks the panel on the right side.
  const commitSettled = useCallback((next: boolean): void => {
    settledOpenRef.current = next;
    setSettledOpen(next);
  }, []);

  const settle = useCallback(
    (toOpen: boolean): void => {
      settleRef.current?.stop();
      settleTargetRef.current = toOpen;
      setInFlight(true);
      settleRef.current = animate(x, toOpen ? widthRef.current : 0, {
        ...(reducedMotionRef.current === true
          ? NAV_DRAWER_SETTLE_REDUCED
          : NAV_DRAWER_SETTLE),
        // Only a settle that ARRIVES flips the semantics. An interrupted one
        // was overtaken - by a new gesture, a new request, or a resize - and
        // whatever overtook it owns the decision now.
        onComplete: () => {
          settleRef.current = null;
          settleTargetRef.current = null;
          setInFlight(false);
          commitSettled(toOpen);
          // A gesture can settle somewhere the request never asked for, so the
          // store is reconciled to what actually happened rather than the
          // other way round.
          if (openRef.current !== toOpen) onOpenChangeRef.current(toOpen);
        },
      });
    },
    [commitSettled, x],
  );

  // Measured, never assumed: the panel is fluid-width, and the same build runs
  // on a phone and on a tablet. A rotation can resize it under a resting panel
  // OR under one mid-settle, and both have to end up at the width that now
  // exists - a settle still aimed at the old one would strand the panel short
  // of its endpoint with nothing left to move it.
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (node === null) return;
    const sync = (): void => {
      widthRef.current = node.offsetWidth;
      setWidth(node.offsetWidth);
      if (draggingRef.current) return;
      const inFlightTarget = settleTargetRef.current;
      if (inFlightTarget !== null) {
        settle(inFlightTarget);
        return;
      }
      x.jump(settledOpenRef.current ? node.offsetWidth : 0);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [settle, x]);

  // The programmatic path in: the hamburger, a menu row that navigates away,
  // Escape. The request leads and the panel follows, but the SEMANTICS still
  // wait for the panel - so this only ever starts a settle, and that settle's
  // completion is what makes the request true.
  useEffect(() => {
    if (draggingRef.current) return;
    if (x.get() !== (open ? widthRef.current : 0)) {
      settle(open);
      return;
    }
    // Already standing at the endpoint the request asks for, so there is
    // nothing to travel and the semantics reconcile at once. This is also the
    // degenerate case of a panel that has never been laid out, where both
    // endpoints are the same place.
    settleRef.current?.stop();
    settleRef.current = null;
    settleTargetRef.current = null;
    setInFlight(false);
    commitSettled(open);
  }, [commitSettled, open, settle, x]);

  const handleDragStart = useCallback((): void => {
    draggingRef.current = true;
    openAtGestureStartRef.current = settledOpenRef.current;
    settleRef.current?.stop();
    settleRef.current = null;
    settleTargetRef.current = null;
    setInFlight(true);
  }, []);

  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo): void => {
      draggingRef.current = false;
      settle(
        resolvesToOpen({
          positionPx: x.get(),
          widthPx: widthRef.current,
          velocityPxPerS: info.velocity.x,
          openAtGestureStart: openAtGestureStartRef.current,
        }),
      );
    },
    [settle, x],
  );

  useEdgeDragToOpenNav({
    onActivate: (event, travelPx) => {
      settleRef.current?.stop();
      settleRef.current = null;
      settleTargetRef.current = null;
      setInFlight(true);
      // Meet the finger where the drag declared itself, so what follows is 1:1
      // against the ORIGINAL touch-down rather than against the point 15px
      // later where the classifier made up its mind. The drag engine reads the
      // live value as its origin, so seeding it here is all the handoff needs.
      x.jump(Math.min(Math.max(travelPx, 0), widthRef.current));
      dragControls.start(event);
      // A pointer that lifts between the classifier activating and the drag
      // engine's first move would otherwise leave the panel parked at that
      // seeded offset with nothing left to release it.
      const finish = (): void => {
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        if (draggingRef.current) return;
        settle(settledOpenRef.current);
      };
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    claimedElsewhere: (target) =>
      target instanceof Node && (layerRef.current?.contains(target) ?? false),
  });

  const dismiss = useCallback((): void => {
    onOpenChangeRef.current(false);
  }, []);

  useModalSurfaceContainment({
    active: settledOpen,
    layerRef,
    focusRef: panelRef,
    onDismiss: dismiss,
  });

  // The scrim is the drag made legible: it is the panel's own position read as
  // opacity, so half a drawer is half a scrim and a spring-back takes the
  // darkening with it. A degenerate range before the first measurement would
  // make the transform undefined rather than merely wrong.
  const scrimOpacity = useTransform(x, [0, Math.max(width, 1)], [0, 1]);

  // Interactive whenever the panel is settled open; also whenever it is moving,
  // so a spring in flight can be caught and dragged the other way. Inert only
  // at rest and closed - which is where a keyboard user could otherwise tab
  // into an off-screen menu.
  const inert = !settledOpen && !inFlight;

  return createPortal(
    <div
      ref={layerRef}
      className="pointer-events-none fixed inset-0 z-50"
      data-testid="mobile-nav-drawer-layer"
    >
      <m.div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-black/40 supports-backdrop-filter:backdrop-blur-xs",
          settledOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ opacity: scrimOpacity }}
        onClick={() => {
          onOpenChange(false);
        }}
      />
      {/* The park. Keeping the closed rest position in CSS rather than in the
          motion value means the very first paint is already correct, with no
          frame at x=0 while a layout effect measures the panel. */}
      <div className="absolute inset-y-0 left-0 w-3/4 -translate-x-full sm:max-w-sm">
        <m.div
          ref={panelRef}
          role="dialog"
          aria-modal={settledOpen}
          aria-label="Menu"
          aria-hidden={!settledOpen}
          inert={inert}
          tabIndex={-1}
          drag="x"
          dragControls={dragControls}
          dragConstraints={{ left: 0, right: width }}
          // Rubber-band only at the closed stop, where the give happens off
          // screen. Elasticity at the open stop would pull the panel past its
          // own edge and open a gap at the screen edge behind it.
          dragElastic={{ left: 0.2, right: 0, top: 0, bottom: 0 }}
          // The release rule decides, not inertia - momentum would carry the
          // panel past the endpoint the release just chose.
          dragMomentum={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          style={{ x }}
          className="pointer-events-auto flex h-full w-full flex-col border-r bg-popover bg-clip-padding pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-lg outline-none"
          data-testid="mobile-nav-drawer"
          data-mobile-shell-touch-scope=""
        >
          {children}
        </m.div>
      </div>
    </div>,
    document.body,
  );
}
