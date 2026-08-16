/**
 * The Link-a-phone panel under the server's one-live-code policy: the
 * countdown derives the next-mint moment from the mint response alone, the
 * displayed code is the ONLY watched code (a claim on it swaps the QR for
 * the confirmation card), a rejection resumes rotation with a fresh code,
 * and the one-time nature of a code is stated in copy.
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

const CLAIMED_STATUS = {
  status: "claimed",
  claimant: {
    address: "192.168.29.87",
    userAgent: "TraycerMobile/1.0 (iPhone)",
    location: "Bengaluru, IN",
    claimedAt: 100,
  },
};

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

describe("LinkPhonePanel", () => {
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

  it("watches only the displayed code; its claim swaps the QR for the confirmation and approves", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    const view = render(<LinkPhonePanel />);
    // The watch is on exactly the displayed code.
    const watched = mocks.useAuthLinkLoginStatus.mock.calls
      .map((call: unknown[]) => call[0])
      .filter((code): code is string => typeof code === "string");
    expect(new Set(watched)).toEqual(new Set(["ABCDE-FGHJK"]));

    mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult(CLAIMED_STATUS));
    const respond = respondIdle();
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    view.rerender(<LinkPhonePanel />);
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

  it("a rejection resumes rotation with a fresh code", () => {
    const codeQuery = queryResultWithCode(Date.now());
    mocks.useAuthLinkLoginCode.mockReturnValue(codeQuery);
    mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult(CLAIMED_STATUS));
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("ok");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-reject").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "ABCDE-FGHJK", approve: false },
      expect.anything(),
    );
    // The rejected claim released the server's per-user lock; the panel
    // immediately requests a fresh code instead of waiting out the interval.
    expect(codeQuery.refetch).toHaveBeenCalled();
  });

  it("rotation replaces the watched code with the newly displayed one", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "AAAAA-AAAAA", expires_in: 60, expires_at: 1 },
    });
    const view = render(<LinkPhonePanel />);
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "BBBBB-BBBBB", expires_in: 60, expires_at: 2 },
    });
    mocks.useAuthLinkLoginStatus.mockClear();
    view.rerender(<LinkPhonePanel />);
    // The superseded code is dead at the server; the committed render (the
    // adjust-during-render pass settles before commit) watches only B.
    const lastWatched = mocks.useAuthLinkLoginStatus.mock.calls
      .map((call: unknown[]) => call[0])
      .at(-1);
    expect(lastWatched).toBe("BBBBB-BBBBB");
    expect(screen.getByText("BBBBB-BBBBB")).toBeTruthy();
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
