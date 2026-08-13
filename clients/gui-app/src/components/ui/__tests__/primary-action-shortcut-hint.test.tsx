import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setMobileApp } from "@/lib/mobile-app";
import { modLabel } from "@/lib/keybindings/platform";
import { Button } from "@/components/ui/button";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

// A representative call site: the mod+Enter chip shared by every primary
// action button (Submit, Next, Start, ...). Proves the gate reaches a real
// rendered button, and that hiding the chip never empties the button's label.
function renderSubmitButton() {
  return render(
    <Button type="button">
      Submit
      <PrimaryActionShortcutHint />
    </Button>,
  );
}

describe("<PrimaryActionShortcutHint /> inside a labelled button", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("shows the mod+Enter chip alongside the label outside the mobile app", () => {
    renderSubmitButton();
    // The chip is `aria-hidden` (it duplicates the visible label rather than
    // adding information), so the accessible name stays exactly "Submit"
    // even while the glyphs are on screen.
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button.textContent).toContain(modLabel());
    expect(button.textContent).toContain("↵");
  });

  it("drops the chip on the installed mobile app but keeps the label", () => {
    setMobileApp(true);
    renderSubmitButton();
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button.textContent).toBe("Submit");
    expect(button.textContent).not.toContain(modLabel());
    expect(button.textContent).not.toContain("↵");
  });
});
