/**
 * The Link-a-phone panel's rotation affordances: the countdown derives the
 * next-mint moment from the mint response alone (expiry minus the rotation
 * lead) and ticks on a local clock, and the one-time nature of a code is
 * stated in copy — both must hold with no requests beyond the mint the query
 * already performed.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useAuthLinkLoginCode: vi.fn(),
}));

vi.mock("@/hooks/auth/use-link-login-code-query", () => ({
  LINK_LOGIN_REMINT_MS: 50_000,
  useAuthLinkLoginCode: mocks.useAuthLinkLoginCode,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: "signed-in" }),
}));

import { LinkPhonePanel } from "../link-phone-panel";

function queryResultWithCode(nowMs: number) {
  return {
    isPending: false,
    isError: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(),
    data: {
      code: "A".repeat(43),
      expires_in: 60,
      expires_at: Math.floor(nowMs / 1000) + 60,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("LinkPhonePanel rotation affordances", () => {
  it("counts down to the next mint from the shown code's expiry and ticks locally", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    render(<LinkPhonePanel />);
    // TTL 60s, rotation lead 10s -> the next code lands 50s after mint.
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 50s",
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 40s",
    );
    // The clock clamps at zero while the interval refetch is in flight.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 0s",
    );
  });

  it("states that a code is single-use and short-lived", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    render(<LinkPhonePanel />);
    expect(
      screen.getByTestId("link-phone-single-use-hint").textContent,
    ).toBe("Each code signs in one phone and expires in a minute.");
    // The raw code stays available for the manual-entry path.
    expect(screen.getByText("A".repeat(43))).toBeTruthy();
  });
});
