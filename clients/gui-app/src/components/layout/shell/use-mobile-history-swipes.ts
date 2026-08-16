import { useRouter } from "@tanstack/react-router";
import { useEdgeNavSwipe } from "@/components/layout/shell/use-edge-nav-swipe";
import { goBack, goForward } from "@/lib/commands/actions";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * Binds the edge navigation swipes to the app's in-app history navigation - the
 * SAME `goBack` / `goForward` the desktop title bar's arrows and the command
 * palette call, on the current router. The phone has no room for those arrows,
 * so the gesture is the affordance; making it a second implementation of "go
 * back" would be two answers to one question, and they would drift.
 *
 * The drawer claims both screen edges while it is out: its panel covers the
 * leading one and its scrim the rest, and both are already inside a drag of
 * their own. Read from the store at pointer-down rather than subscribed to,
 * because the listeners are installed once and the answer is only needed at the
 * instant a finger lands.
 */
export function useMobileHistorySwipes(): void {
  const router = useRouter();
  useEdgeNavSwipe({
    onNavigate: (direction) => {
      if (direction === "back") {
        goBack(router);
        return;
      }
      goForward(router);
    },
    edgesClaimed: () => useMobileNavStore.getState().open,
  });
}
