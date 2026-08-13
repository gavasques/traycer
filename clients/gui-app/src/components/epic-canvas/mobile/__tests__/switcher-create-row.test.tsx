import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherCreateRow } from "@/components/epic-canvas/mobile/switcher-create-row";

const spies = vi.hoisted(() => ({
  setComposerMode: vi.fn(),
  openModal: vi.fn(),
}));
const holder = vi.hoisted(() => ({ role: "owner" }));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => holder.role,
}));
vi.mock("@/stores/epics/new-conversation-modal-store", () => ({
  useNewConversationModalStore: {
    getState: () => ({ setComposerMode: spies.setComposerMode }),
  },
}));
vi.mock("@/stores/epics/new-conversation-modal-open-store", () => ({
  useNewConversationModalOpenStore: {
    getState: () => ({ open: spies.openModal }),
  },
}));
// The dialog shell pulls the desktop host/folder picker body (heavy: host
// queries, workspace search); stub it so this suite targets the create row's
// own wiring - whether it renders `open`.
vi.mock("@/components/epic-canvas/mobile/mobile-new-terminal-dialog", () => ({
  MobileNewTerminalDialog: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="mobile-epic-new-terminal-dialog" /> : null,
}));

const PROPS = { epicId: "epic-1", tabId: "tab-1", onClose: () => {} };

beforeEach(() => {
  holder.role = "owner";
  spies.setComposerMode.mockClear();
  spies.openModal.mockClear();
});
afterEach(cleanup);

describe("<SwitcherCreateRow />", () => {
  it("shows both New chat and New terminal for an editor", () => {
    render(<SwitcherCreateRow {...PROPS} />);
    expect(screen.getByTestId("switcher-new-chat")).toBeTruthy();
    expect(screen.getByTestId("switcher-new-terminal")).toBeTruthy();
  });

  it("renders nothing for a viewer", () => {
    holder.role = "viewer";
    const { container } = render(<SwitcherCreateRow {...PROPS} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("switcher-new-chat")).toBeNull();
    expect(screen.queryByTestId("switcher-new-terminal")).toBeNull();
  });

  it("New chat sets chat composer mode, opens the New Conversation modal for this epic/tab, and closes the sheet", () => {
    const onClose = vi.fn();
    render(<SwitcherCreateRow {...PROPS} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("switcher-new-chat"));
    expect(spies.setComposerMode).toHaveBeenCalledWith("epic-1", "chat");
    expect(spies.openModal).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-1",
        parentId: null,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("New terminal opens the terminal picker dialog", () => {
    render(<SwitcherCreateRow {...PROPS} />);
    expect(screen.queryByTestId("mobile-epic-new-terminal-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("switcher-new-terminal"));
    expect(screen.getByTestId("mobile-epic-new-terminal-dialog")).toBeTruthy();
  });
});
