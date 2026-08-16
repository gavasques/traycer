import { beforeEach, describe, expect, it } from "vitest";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { ALL_NOTIFICATION_CATEGORIES } from "@/lib/notifications/notification-category";

const PERSIST_KEY = "traycer-gui-app:notifications-filter";

describe("notifications popover store filter persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useNotificationsPopoverStore.setState({
      open: false,
      unreadOnly: false,
      categories: ALL_NOTIFICATION_CATEGORIES,
      originUnavailable: false,
      originUnavailableHostLabel: null,
    });
  });

  it("keeps the filters across close and reopen", () => {
    const store = useNotificationsPopoverStore.getState();
    store.setUnreadOnly(true);
    store.toggleCategory("system");

    useNotificationsPopoverStore.getState().setOpen(false);
    useNotificationsPopoverStore.getState().setOpen(true);

    const state = useNotificationsPopoverStore.getState();
    expect(state.unreadOnly).toBe(true);
    expect(state.categories.has("system")).toBe(false);
    expect(state.categories.has("task")).toBe(true);
  });

  it("persists only the filter slice, categories as an array", () => {
    const store = useNotificationsPopoverStore.getState();
    store.setUnreadOnly(true);
    store.toggleCategory("collaboration");

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed: unknown = JSON.parse(raw ?? "");
    expect(parsed).toMatchObject({
      state: {
        unreadOnly: true,
        categories: expect.arrayContaining(["task", "system"]),
      },
    });
    expect(parsed).not.toMatchObject({ state: { open: expect.anything() } });
  });

  it("rehydrates the filters and drops unknown category names", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { unreadOnly: true, categories: ["task", "bogus"] },
        version: 1,
      }),
    );

    await useNotificationsPopoverStore.persist.rehydrate();

    const state = useNotificationsPopoverStore.getState();
    expect(state.unreadOnly).toBe(true);
    expect([...state.categories]).toEqual(["task"]);
    // Open-cycle state never rides the persisted record.
    expect(state.open).toBe(false);
  });

  it("falls back to defaults on a malformed persisted record", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { unreadOnly: "yes", categories: 7 }, version: 1 }),
    );

    await useNotificationsPopoverStore.persist.rehydrate();

    const state = useNotificationsPopoverStore.getState();
    expect(state.unreadOnly).toBe(false);
    expect(state.categories).toEqual(ALL_NOTIFICATION_CATEGORIES);
  });
});
