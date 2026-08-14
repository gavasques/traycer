import "../../../../__tests__/test-browser-apis";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";

// Host-backed chrome only; the registry accessors the header reads for the
// epic's title and permission role stay REAL here - they are the half of the
// cold-restore path under test.
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <button type="button" aria-label="Usage limits" />,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <button type="button" aria-label="Resource monitor" />
  ),
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => (
    <button type="button" aria-label="Notifications" />
  ),
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ mutate: vi.fn(), isPending: false }),
}));

const EPIC_ID = "epic-cold";
const TAB_ID = "tab-cold";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

/** The session the epic route's provider would have registered by now. */
function registerSession(title: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: fakeStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.store.setState({
    epic: { title, updatedAt: 1, isTitleEditedByUser: false },
    permissionRole: "owner",
  });
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => handle);
  return handle;
}

function seedTabRecord(name: string): void {
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name } },
  });
}

function renderEpicRoute(): void {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MobileAppHeader />
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics/$epicId/$tabId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/epics/${EPIC_ID}/${TAB_ID}`],
    }),
  });
  render(<RouterProvider router={router} />);
}

/**
 * A cold restore lands on the epic route with nothing primed: no canvas tab
 * record for the restored tab id, and no surface has published anything into
 * the header's action slot. Nothing in this harness mounts the epic route's
 * session effects at all, which is the point - the header has to stand up the
 * title and the switcher from the route and the session registry alone.
 */
describe("MobileAppHeader on a cold-restored epic route", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ tabsById: {} });
    useMobileHeaderStore.setState({ rightActions: null });
    __getOpenEpicRegistryForTests().disposeAll();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    useEpicCanvasStore.setState({ tabsById: {} });
    useMobileHeaderStore.setState({ rightActions: null });
  });

  it("renders the tab switcher with no tab record and no slot writer", async () => {
    renderEpicRoute();

    expect(
      await screen.findByTestId("mobile-epic-switcher-trigger"),
    ).not.toBeNull();
  });

  it("titles the header from the live session when no tab record exists", async () => {
    registerSession("Ship the mobile header");
    renderEpicRoute();

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Ship the mobile header",
      ),
    );
  });

  it("holds an empty title slot until a source resolves, then resolves", async () => {
    renderEpicRoute();
    await screen.findByTestId("mobile-epic-switcher-trigger");
    // No stand-in: an unresolved name renders no title rather than a
    // placeholder the real name would then replace.
    expect(screen.queryByTestId("mobile-header-title")).toBeNull();

    registerSession("Resolved later");

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Resolved later",
      ),
    );
  });

  it("falls back to the persisted tab record before the session registers", async () => {
    seedTabRecord("Persisted name");
    renderEpicRoute();

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Persisted name",
      ),
    );
  });

  it("prefers the live session title over a stale tab record", async () => {
    seedTabRecord("Stale name");
    registerSession("Live name");
    renderEpicRoute();

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Live name",
      ),
    );
  });

  // A tab record can carry a blank name; showing it would open the rename
  // field on an epic that does have a title.
  it("treats a blank tab record name as unresolved", async () => {
    seedTabRecord("   ");
    renderEpicRoute();
    await screen.findByTestId("mobile-epic-switcher-trigger");

    expect(screen.queryByTestId("mobile-header-title")).toBeNull();
  });
});
