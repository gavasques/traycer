import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_PERSIST_VERSION,
  surfaceHostSelectionKey,
} from "@/lib/persist";
import {
  composerSurfaceKey,
  gitDiffPanelSurfaceKey,
  notifyEffectiveHostChanged,
  resolvedSurfaceHostId,
  subscribeFollowingSurfaceReset,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

const PERSIST_KEY = surfaceHostSelectionKey(null);
const GIT_KEY = gitDiffPanelSurfaceKey("tab-1");
const TREE_KEY = "file-tree-test";

function resetStore(): void {
  window.localStorage.clear();
  useSurfaceHostSelectionStore.persist.setOptions({ name: PERSIST_KEY });
  useSurfaceHostSelectionStore.getState().resetForTests();
}

describe("useSurfaceHostSelectionStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("starts following: missing key is null, resolved falls through to effective", () => {
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      undefined,
    );
    expect(
      resolvedSurfaceHostId(null, "host-active", {
        authorityAttached: false,
        leases: [],
      }),
    ).toBe("host-active");
  });

  it("pins one instance without touching a sibling", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection(GIT_KEY, "host-b");
    store.setSelection(TREE_KEY, "host-c");

    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-b",
    );
    expect(useSurfaceHostSelectionStore.getState().selections[TREE_KEY]).toBe(
      "host-c",
    );
    expect(
      resolvedSurfaceHostId("host-b", "host-active", {
        authorityAttached: false,
        leases: [],
      }),
    ).toBe("host-b");
  });

  it("setSelection(null) returns the instance to following", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection(GIT_KEY, "host-b");
    store.setSelection(GIT_KEY, null);

    expect(
      useSurfaceHostSelectionStore.getState().selections[GIT_KEY],
    ).toBeUndefined();
  });

  it("latchOnFirstUse pins a follower and is a no-op once pinned", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.latchOnFirstUse(GIT_KEY, "host-active");
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-active",
    );

    store.latchOnFirstUse(GIT_KEY, "host-other");
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-active",
    );
  });

  it("notifyEffectiveHostChanged fires the G4 reset hook only when effective moves", () => {
    const seen: Array<{
      readonly previousEffectiveHostId: string | null;
      readonly nextEffectiveHostId: string | null;
    }> = [];
    const unsubscribe = subscribeFollowingSurfaceReset((event) => {
      seen.push(event);
    });

    notifyEffectiveHostChanged("host-a", "host-a");
    notifyEffectiveHostChanged("host-a", "host-b");
    unsubscribe();
    notifyEffectiveHostChanged("host-b", "host-c");

    expect(seen).toEqual([
      { previousEffectiveHostId: "host-a", nextEffectiveHostId: "host-b" },
    ]);
  });

  it("reserves a composer window key without requiring a consumer", () => {
    expect(composerSurfaceKey("window-1")).toBe("composer\u001fwindow-1");
    expect(composerSurfaceKey(null)).toBe("composer\u001fbrowser");
  });

  it("persists pins and drops invalid rehydrated entries", async () => {
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { selections: { [GIT_KEY]: "host-b" } },
      version: CURRENT_PERSIST_VERSION,
    });

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { selections: { [GIT_KEY]: "host-b", bad: 1, "": "x" } },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useSurfaceHostSelectionStore.persist.rehydrate();
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({
      [GIT_KEY]: "host-b",
    });
  });
});
