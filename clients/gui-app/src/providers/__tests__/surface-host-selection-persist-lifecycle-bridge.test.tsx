import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { SurfaceHostSelectionPersistLifecycleBridge } from "@/providers/surface-host-selection-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { gitDiffPanelSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { surfaceHostSelectionKey } from "@/lib/persist";

const GIT_KEY = gitDiffPanelSurfaceKey("tab-1");

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function resetStore(): void {
  useSurfaceHostSelectionStore.persist.setOptions({
    name: surfaceHostSelectionKey(null),
  });
  useSurfaceHostSelectionStore.getState().resetForTests();
}

function persistSnapshot(email: string | null, hostId: string): void {
  window.localStorage.setItem(
    surfaceHostSelectionKey(email),
    JSON.stringify({
      state: { selections: { [GIT_KEY]: hostId } },
      version: 1,
    }),
  );
}

describe("<SurfaceHostSelectionPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
  });

  it("retargets to the signed-in user's surface-pin bucket", async () => {
    persistSnapshot("a@b.com", "host-alice");

    render(
      <SurfaceHostSelectionPersistLifecycleBridge>
        <div />
      </SurfaceHostSelectionPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "a@b.com");
    });

    await waitFor(() => {
      expect(
        useSurfaceHostSelectionStore.getState().selections[GIT_KEY],
      ).toBe("host-alice");
    });
  });

  it("wipes pins on sign-out", async () => {
    persistSnapshot("a@b.com", "host-alice");
    render(
      <SurfaceHostSelectionPersistLifecycleBridge>
        <div />
      </SurfaceHostSelectionPersistLifecycleBridge>,
    );
    act(() => {
      resetAuth("signed-in", "a@b.com");
    });
    await waitFor(() => {
      expect(
        useSurfaceHostSelectionStore.getState().selections[GIT_KEY],
      ).toBe("host-alice");
    });

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
    });
  });
});
