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
  useAuthLinkLoginStatus: vi.fn(),
  useRespondLinkLoginMutation: vi.fn(),
}));

vi.mock("@/hooks/auth/use-link-login-code-query", () => ({
  LINK_LOGIN_REMINT_MS: 50_000,
  useAuthLinkLoginCode: mocks.useAuthLinkLoginCode,
}));

vi.mock("@/hooks/auth/use-link-login-status-query", () => ({
  useAuthLinkLoginStatus: mocks.useAuthLinkLoginStatus,
}));

vi.mock("@/hooks/auth/use-respond-link-login-mutation", () => ({
  useRespondLinkLoginMutation: mocks.useRespondLinkLoginMutation,
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
      code: "ABCDE-FGHJK",
      expires_in: 60,
      expires_at: Math.floor(nowMs / 1000) + 60,
    },
  };
}

function statusResult(data: unknown) {
  return {
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    data,
  };
}

function respondIdle() {
  return { isPending: false, mutate: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult(null));
  mocks.useRespondLinkLoginMutation.mockReturnValue(respondIdle());
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

  it("swaps the QR for an Approve/Reject confirmation when the code is claimed", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult({
        status: "claimed",
        claimant: {
          address: "192.168.29.87",
          userAgent: "TraycerMobile/1.0 (iPhone)",
          location: "Bengaluru, IN",
          claimedAt: Date.now(),
        },
      }),
    );
    const respond = respondIdle();
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    expect(screen.getByTestId("link-phone-claimant").textContent).toContain(
      "192.168.29.87",
    );
    expect(screen.queryByTestId("link-phone-countdown")).toBeNull();
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "ABCDE-FGHJK", approve: true },
      expect.anything(),
    );
  });

  it("a claim on the PREVIOUS code (rotation grace) still surfaces the approval", () => {
    // First render shows code A; rotation replaces it with B.
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "AAAAA-AAAAA", expires_in: 60, expires_at: 1 },
    });
    const view = render(<LinkPhonePanel />);
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "BBBBB-BBBBB", expires_in: 60, expires_at: 2 },
    });
    view.rerender(<LinkPhonePanel />);
    // The phone claimed A just before rotation; B is untouched.
    mocks.useAuthLinkLoginStatus.mockImplementation((code: string | null) =>
      statusResult(
        code === "AAAAA-AAAAA"
          ? {
              status: "claimed",
              claimant: {
                address: "10.0.0.9",
                userAgent: "TraycerMobile/1.0 (iPhone)",
                location: null,
                claimedAt: 100,
              },
            }
          : null,
      ),
    );
    const respond = respondIdle();
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "AAAAA-AAAAA", approve: true },
      expect.anything(),
    );
  });

  it("claims on BOTH live codes resolve deterministically to the earliest", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "AAAAA-AAAAA", expires_in: 60, expires_at: 1 },
    });
    const view = render(<LinkPhonePanel />);
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "BBBBB-BBBBB", expires_in: 60, expires_at: 2 },
    });
    view.rerender(<LinkPhonePanel />);
    const claimFor = (address: string, claimedAt: number) => ({
      status: "claimed",
      claimant: { address, userAgent: null, location: null, claimedAt },
    });
    mocks.useAuthLinkLoginStatus.mockImplementation((code: string | null) => {
      if (code === "AAAAA-AAAAA") {
        return statusResult(claimFor("10.0.0.1", 100));
      }
      if (code === "BBBBB-BBBBB") {
        return statusResult(claimFor("10.0.0.2", 200));
      }
      return statusResult(null);
    });
    const respond = respondIdle();
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    view.rerender(<LinkPhonePanel />);
    // The earlier claim (on A) wins the single confirmation card.
    expect(screen.getByTestId("link-phone-claimant").textContent).toContain(
      "10.0.0.1",
    );
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "AAAAA-AAAAA", approve: true },
      expect.anything(),
    );
  });

  it("states that a code is single-use and short-lived", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-single-use-hint").textContent).toBe(
      "Each code links one phone, expires in a minute, and needs your approval here.",
    );
    // The raw code stays available for the manual-entry path.
    expect(screen.getByText("ABCDE-FGHJK")).toBeTruthy();
  });
});
