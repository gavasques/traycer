// The whole chain the mobile back swipe rides, end to end on the history a
// phone actually gets: a PLAIN memory history with no persistent-history
// controller brand, which is what the Capacitor bundle boots with. The pieces
// are all real - the tab-navigation controller, its route bridge, the tabs
// store and the shared `goBack` action - because the claim under test is that
// they compose, not that any one of them works.
//
// What makes this worth pinning: `goBack` refused outright on an unbranded
// history until the fallback existed, so every assertion here would have held
// against a shell where the swipe did nothing at all. The activations before
// the back are what make it a real re-activation rather than a no-op.
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouter,
  type RouterHistory,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
import { setMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import {
  __resetTabNavigationControllerForTesting,
  activateTabIntent,
  historyTabIntent,
  settingsTabIntent,
} from "@/lib/tab-navigation";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridgeHydrated: () => true,
}));

// The bridge mounts at the signed-in root on every shell, phone included.
// `navigate` is published from inside the router so activations run against the
// same instance the history under test belongs to.
const navigateProbe: {
  current: UseNavigateResult<string> | null;
} = { current: null };

function ShellLike() {
  const router = useRouter();
  useEffect(() => {
    navigateProbe.current = router.navigate;
  });
  return (
    <>
      <TabNavigationRouteBridge />
      <Outlet />
    </>
  );
}

function buildRouter() {
  const rootRoute = createRootRoute({ component: ShellLike });
  // A splat child rather than the app's real route tree: this suite is about
  // where navigation LANDS, and every landing here is a top-level surface whose
  // component would only add loaders to wait on.
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <div data-testid="surface" />,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  return {
    history,
    router: createRouter({
      routeTree: rootRoute.addChildren([anyRoute]),
      history,
    }),
  };
}

function focusedKind(): string | null {
  return selectHostFocusedRef(useTabsStore.getState())?.kind ?? null;
}

/**
 * The app's real route tree, for the suite that only needs router CONTEXT -
 * the swipe hook reads `useRouter().history` and never renders a route.
 */
function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getActiveHostId: () => null,
      getHostClient: () => null,
    },
  });
}

const activeUnmounts: Array<() => void> = [];

beforeEach(() => {
  navigateProbe.current = null;
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  vi.spyOn(
    DesktopTabsPersistence,
    "consumeDesktopRestoredRoute",
  ).mockReturnValue(null);
  __resetTabNavigationControllerForTesting();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetTabNavigationControllerForTesting();
});

describe("mobile back navigation over a plain history", () => {
  async function activateSettingsThenHistory(): Promise<void> {
    const navigate = navigateProbe.current;
    if (navigate === null) throw new Error("router never published navigate");
    await act(async () => {
      activateTabIntent(navigate, settingsTabIntent("general"), undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
    await act(async () => {
      activateTabIntent(navigate, historyTabIntent(), undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("history");
    });
  }

  it("re-activates the previous surface on a back step", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    await activateSettingsThenHistory();

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });

    // The history moved, the bridge observed a BACK, and the controller
    // resolved the landed location back onto the surface that owns it.
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });
  });

  it("returns to the later surface on a forward step", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    await activateSettingsThenHistory();
    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(focusedKind()).toBe("settings");
    });

    await act(async () => {
      goForward({ history });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(focusedKind()).toBe("history");
    });
  });

  // The gesture fires wherever the user is, including on a session that has
  // never navigated. Nothing to step to is not an error state - it is the
  // ordinary case on a freshly-launched app, and it has to leave the surface
  // exactly as it found it.
  it("leaves a fresh session untouched when there is nothing behind it", async () => {
    const { history, router } = buildRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(navigateProbe.current).not.toBeNull();
    });
    const before = router.state.location.pathname;

    await act(async () => {
      goBack({ history });
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe(before);
    expect(focusedKind()).toBeNull();
  });
});

/**
 * The seam between the recognizer and the navigation: that an edge swipe
 * reaches the SHARED action rather than a second implementation of "go back".
 * The recognizer's own arbitration is pinned in the shell-gesture suite; what
 * is asserted here is only which call it lands on.
 */
describe("useMobileHistorySwipes", () => {
  function dispatchPointer(
    type: "pointerdown" | "pointermove",
    options: {
      readonly clientX: number;
      readonly timeStamp: number;
    },
  ): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({
      clientX: options.clientX,
      clientY: 300,
      pointerId: 1,
      isPrimary: true,
      target: document.body,
      timeStamp: options.timeStamp,
    })) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    document.dispatchEvent(event);
  }

  function swipeFromEdge(edge: "leading" | "trailing"): void {
    const from = edge === "leading" ? 8 : window.innerWidth - 8;
    const to = edge === "leading" ? 80 : window.innerWidth - 80;
    act(() => {
      dispatchPointer("pointerdown", { clientX: from, timeStamp: 0 });
      dispatchPointer("pointermove", { clientX: to, timeStamp: 100 });
    });
  }

  function mountSwipes(history: RouterHistory): AppRouter {
    const router = makeRouter(history);
    const { unmount } = renderHook(() => useMobileHistorySwipes(), {
      wrapper: ({ children }) => (
        <RouterContextProvider router={router}>
          {children}
        </RouterContextProvider>
      ),
    });
    activeUnmounts.push(unmount);
    return router;
  }

  beforeEach(() => {
    setMobileApp(true);
  });

  afterEach(() => {
    setMobileApp(false);
    useMobileNavStore.setState({ open: false });
    for (const unmount of activeUnmounts.splice(0)) unmount();
  });

  it("sends a leading-edge swipe to the shared back action", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    mountSwipes(history);

    swipeFromEdge("leading");

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("sends a trailing-edge swipe to the shared forward action", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const forwardSpy = vi.spyOn(history, "forward");
    mountSwipes(history);

    swipeFromEdge("trailing");

    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });

  // The drawer covers both edges while it is out, and its own panel is already
  // tracking the finger.
  it("stands down while the navigation drawer is open", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    mountSwipes(history);
    useMobileNavStore.setState({ open: true });

    swipeFromEdge("leading");

    expect(backSpy).not.toHaveBeenCalled();
  });
});
