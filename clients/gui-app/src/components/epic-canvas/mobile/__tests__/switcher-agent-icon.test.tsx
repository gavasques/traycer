import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentIcon } from "@/components/epic-canvas/mobile/switcher-agent-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import type { AgentActivityTier } from "@/lib/agent-activity";
import type {
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";

// Drive the epic-selector reads the icon (and the shared status mapping it now
// routes through) depends on. `tui` non-null + type "terminal-agent" reaches
// the TUI badge branch; `tier` is the awareness tier the desktop chat tree
// reads, so setting it here is what proves the switcher shares that source
// rather than the coarser working-id set it used to read.
const state = vi.hoisted(
  (): {
    tier: AgentActivityTier | null;
    gui: string | null;
    tui: string | null;
    role: "owner" | "viewer";
  } => ({ tier: null, gui: null, tui: null, role: "owner" }),
);
vi.mock("@/lib/epic-selectors", () => ({
  useEpicActiveAgentIds: () =>
    state.tier === null ? new Set<string>() : new Set<string>(["n1"]),
  useEpicAgentActivityTiers: () =>
    state.tier === null
      ? new Map<string, AgentActivityTier>()
      : new Map<string, AgentActivityTier>([["n1", state.tier]]),
  useEpicChatHarnessId: () => state.gui,
  useMaybeEpicTuiAgentHarnessId: () => state.tui,
  useEpicPermissionRole: () => state.role,
}));

const NO_INDICATORS: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};

const QUIET: HostNotificationsIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

function chatIndicators(
  flags: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorStateResponse {
  return { epics: {}, chats: { n1: { ...QUIET, ...flags } } };
}

function renderIcon(
  type: "chat" | "terminal-agent",
  indicators: HostNotificationsIndicatorStateResponse,
): ReactNode {
  return (
    <NotificationIndicatorsProvider indicators={indicators}>
      <SwitcherAgentIcon
        epicId="epic-1"
        nodeId="n1"
        type={type}
        hostId="host-A"
      />
    </NotificationIndicatorsProvider>
  );
}

afterEach(() => {
  cleanup();
  state.tier = null;
  state.gui = null;
  state.tui = null;
  state.role = "owner";
});

describe("<SwitcherAgentIcon /> identity glyphs", () => {
  it("marks a TUI agent with a high-contrast terminal badge chip (solid disc + ring cutout)", () => {
    state.tui = "claude";
    render(renderIcon("terminal-agent", NO_INDICATORS));
    const badge = screen.getByTestId("switcher-tui-badge-n1");
    // A solid accent disc ring-cut against the sheet surface - not the bare
    // muted glyph that vanished at phone size (the live-review defect).
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("bg-primary");
    expect(badge.className).toContain("ring-popover");
    // Still carries a terminal glyph, now legibly sized inside the disc.
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("shows no TUI badge for a plain GUI chat", () => {
    state.gui = "claude";
    render(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-tui-badge-n1")).toBeNull();
  });
});

describe("<SwitcherAgentIcon /> live status", () => {
  it.each(["chat", "terminal-agent"] as const)(
    "shows the working spinner for a %s whose awareness tier is a turn",
    (type) => {
      state.tier = "turn";
      state.gui = "claude";
      state.tui = "claude";
      render(renderIcon(type, NO_INDICATORS));
      expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();
    },
  );

  it.each(["chat", "terminal-agent"] as const)(
    "shows the muted background glyph, not the working spinner, for a background-only %s",
    (type) => {
      state.tier = "background";
      render(renderIcon(type, NO_INDICATORS));
      // The whole point of reading the TIER rather than the working-id set: the
      // switcher used to wear the busy spinner for both.
      expect(
        screen.getByTestId("switcher-agent-background-activity-n1"),
      ).toBeTruthy();
      expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
    },
  );

  it("drops the spinner when the agent stops working, with the sheet still open", () => {
    state.tier = "turn";
    state.gui = "claude";
    const view = render(renderIcon("chat", NO_INDICATORS));
    expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();

    state.tier = null;
    view.rerender(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
    // Back to the idle identity glyph: every status variant renders a
    // `role="status"` span, so their absence is the idle slot.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("picks up a status change pushed while the sheet is open", () => {
    const view = render(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-agent-failure-n1")).toBeNull();

    view.rerender(renderIcon("chat", chatIndicators({ unreadFailure: true })));
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
  });
});

describe("<SwitcherAgentIcon /> matches the desktop mapping", () => {
  // Desktop precedence (`NotificationIndicatorIcon`): attention tones first
  // (failure > fork > interview > approval), then the running tiers, then
  // unread-done. The switcher renders through that same component, so these
  // assert the shared vocabulary reaches the mobile rows at all - each state
  // previously rendered as a plain harness mark.
  const TONE_CASES: ReadonlyArray<{
    readonly name: string;
    readonly flags: Partial<HostNotificationsIndicatorState>;
    readonly testId: string;
  }> = [
    {
      name: "failure",
      flags: { unreadFailure: true },
      testId: "switcher-agent-failure-n1",
    },
    {
      name: "fork",
      flags: { pendingFork: true },
      testId: "switcher-agent-fork-n1",
    },
    {
      name: "interview",
      flags: { pendingInterview: true },
      testId: "switcher-agent-interview-n1",
    },
    {
      name: "approval",
      flags: { pendingApproval: true },
      testId: "switcher-agent-approval-n1",
    },
    {
      name: "unread-done",
      flags: { unreadDone: true },
      testId: "switcher-agent-done-n1",
    },
  ];

  it.each(TONE_CASES)("renders the desktop $name tone", (testCase) => {
    state.gui = "claude";
    render(renderIcon("chat", chatIndicators(testCase.flags)));
    expect(screen.getByTestId(testCase.testId)).toBeTruthy();
  });

  it("lets an attention tone outrank a running turn, as the desktop row does", () => {
    state.tier = "turn";
    render(
      renderIcon("terminal-agent", chatIndicators({ unreadFailure: true })),
    );
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
  });

  it("keeps the running turn ahead of unread-done, as the desktop row does", () => {
    state.tier = "turn";
    render(renderIcon("chat", chatIndicators({ unreadDone: true })));
    expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-done-n1")).toBeNull();
  });

  it("shows a viewer's read-only lock on a chat row", () => {
    state.role = "viewer";
    state.gui = "claude";
    render(renderIcon("chat", NO_INDICATORS));
    expect(screen.getByLabelText("Read-only agent")).toBeTruthy();
  });
});
