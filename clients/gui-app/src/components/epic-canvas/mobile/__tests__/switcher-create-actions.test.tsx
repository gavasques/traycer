import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherNewArtifactMenu } from "@/components/epic-canvas/mobile/switcher-create-actions";

const spies = vi.hoisted(() => ({
  createArtifact: vi.fn(),
}));

vi.mock("@/components/epic-canvas/mobile/use-switcher-create-artifact", () => ({
  useSwitcherCreateArtifact: () => ({
    create: spies.createArtifact,
    isPending: false,
  }),
}));

beforeEach(() => {
  spies.createArtifact.mockClear();
});
afterEach(cleanup);

describe("<SwitcherNewArtifactMenu />", () => {
  it("creates the chosen artifact kind through the shared create hook", () => {
    render(
      <SwitcherNewArtifactMenu
        epicId="epic-1"
        tabId="tab-1"
        onClose={() => {}}
      />,
    );
    fireEvent.pointerDown(screen.getByTestId("switcher-new-artifact"));
    fireEvent.click(screen.getByTestId("switcher-new-artifact-spec"));
    expect(spies.createArtifact).toHaveBeenCalledWith("spec");
  });
});
