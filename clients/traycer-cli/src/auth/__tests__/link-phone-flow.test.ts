import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  linkLoginStatusViaHttp,
  respondLinkLoginViaHttp,
} from "../../../../shared/auth/link-login";
import { runLinkPhoneFlow } from "../link-phone-flow";
import { validateStoredCredentials } from "../validate";
import { noopLogger } from "../../logger";
import { CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

// The QR encoder is faked outright: this suite is about the flow's states, and
// the payload it encodes is covered by the shared client's own suite.
vi.mock("qrcode", () => ({
  default: { toString: vi.fn(() => Promise.resolve("[qr]")) },
}));

// Mint is the CLI's own `fetch` (it needs the 409/400 statuses the shared
// client folds away), so it is stubbed at the global instead.
vi.mock("../../../../shared/auth/link-login", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/link-login")
    >();
  return {
    ...actual,
    linkLoginStatusViaHttp: vi.fn(),
    respondLinkLoginViaHttp: vi.fn(),
  };
});

vi.mock("../validate", () => ({ validateStoredCredentials: vi.fn() }));

// The approval prompt. `answer.current` is what the human "types".
const answer = vi.hoisted(() => ({ current: "" }));
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_prompt: string, callback: (value: string) => void) => {
      callback(answer.current);
    },
    close: () => {},
  }),
}));

const statusMock = vi.mocked(linkLoginStatusViaHttp);
const respondMock = vi.mocked(respondLinkLoginViaHttp);
const credentialsMock = vi.mocked(validateStoredCredentials);

const POLL_MS = 2_000;
const REMINT_MS = 50_000;

function makeCtx(overrides: {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly nonInteractive: boolean;
}): CommandContext {
  const runtime: RuntimeContext = {
    json: overrides.json,
    quiet: overrides.quiet,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: overrides.nonInteractive,
    environment: "production",
    logger: noopLogger,
  };
  return {
    runtime,
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function interactiveCtx(): CommandContext {
  return makeCtx({ json: false, quiet: true, nonInteractive: false });
}

/** Every `humanRequired` block this run printed, concatenated. */
function printed(ctx: CommandContext): string {
  return vi.mocked(ctx.output.humanRequired).mock.calls.join("\n");
}

/**
 * The three fields the mint path reads off a `fetch` response. Declaring them
 * beats casting a literal to the full DOM `Response`, and it documents exactly
 * how much of the interface the flow depends on.
 */
interface MintResponseStub {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

function mintResponse(code: string): MintResponseStub {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        code,
        expires_in: 60,
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }),
  };
}

function mintRefusal(status: number): MintResponseStub {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: "refused" }),
  };
}

const CLAIMED = {
  kind: "ok" as const,
  response: {
    status: "claimed" as const,
    claimant: {
      address: "203.0.113.7",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      location: "Bengaluru, IN",
      claimedAt: 1,
    },
  },
};

const UNCLAIMED = {
  kind: "ok" as const,
  response: { status: "unclaimed" as const, claimant: null },
};

let fetchMock: Mock<() => Promise<MintResponseStub>>;
let originalIsTty: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  answer.current = "";
  originalIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  credentialsMock.mockResolvedValue({
    kind: "valid",
    credentials: {
      token: "bearer-1",
      refreshToken: "refresh-1",
      savedAt: new Date(0).toISOString(),
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
    },
  });
  fetchMock = vi.fn(() => Promise.resolve(mintResponse("ABCDE-FGHJK")));
  vi.stubGlobal("fetch", fetchMock);
  statusMock.mockResolvedValue(UNCLAIMED);
  respondMock.mockResolvedValue({ kind: "ok" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalIsTty,
  });
});

/**
 * Runs the flow far enough for `ticks` status polls to land. The flow sleeps
 * between polls, so the timers have to be driven for it to make progress.
 */
async function runWithPolls(
  ctx: CommandContext,
  ticks: number,
): Promise<PromiseSettledResult<unknown>> {
  const settled = Promise.allSettled([
    runLinkPhoneFlow(ctx, { showQr: true }),
  ]);
  for (let i = 0; i < ticks; i++) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  }
  const [result] = await settled;
  return result;
}

describe("runLinkPhoneFlow", () => {
  it("prints the QR, the typeable code and the single-phone hint", async () => {
    statusMock.mockResolvedValue(CLAIMED);
    const ctx = interactiveCtx();

    await runWithPolls(ctx, 1);

    const output = printed(ctx);
    expect(output).toContain("[qr]");
    expect(output).toContain("ABCDE-FGHJK");
    expect(output).toContain("Each code signs in one phone");
  });

  it("watches the code it just minted", async () => {
    statusMock.mockResolvedValue(CLAIMED);

    await runWithPolls(interactiveCtx(), 1);

    expect(statusMock.mock.calls[0]?.[2]).toBe("ABCDE-FGHJK");
  });

  it("approves on an explicit yes and reports the phone is signing in", async () => {
    statusMock.mockResolvedValue(CLAIMED);
    answer.current = "y";

    const result = await runWithPolls(interactiveCtx(), 1);

    expect(respondMock).toHaveBeenCalledWith(
      expect.any(String),
      "bearer-1",
      "ABCDE-FGHJK",
      true,
    );
    expect(result.status).toBe("fulfilled");
    expect(result.status === "fulfilled" ? result.value : null).toMatchObject({
      decision: "approved",
    });
  });

  it("rejects on a bare newline - the confirm gate needs a deliberate yes", async () => {
    statusMock.mockResolvedValue(CLAIMED);
    answer.current = "";

    const result = await runWithPolls(interactiveCtx(), 1);

    expect(respondMock).toHaveBeenCalledWith(
      expect.any(String),
      "bearer-1",
      "ABCDE-FGHJK",
      false,
    );
    expect(result.status === "fulfilled" ? result.value : null).toMatchObject({
      decision: "rejected",
    });
  });

  it("names the claimant's address and location in the prompt block", async () => {
    statusMock.mockResolvedValue(CLAIMED);
    const ctx = interactiveCtx();

    await runWithPolls(ctx, 1);

    const output = printed(ctx);
    expect(output).toContain("203.0.113.7");
    expect(output).toContain("Bengaluru, IN");
    expect(output).toContain("Only approve if you scanned this code yourself");
  });

  it("exits with a supersession message when the printed code is gone", async () => {
    statusMock.mockResolvedValue({ kind: "gone" });

    const result = await runWithPolls(interactiveCtx(), 1);

    expect(result.status).toBe("rejected");
    const error = result.status === "rejected" ? result.reason : null;
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("replaced by one minted");
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("explains a mint refused while a claim already awaits a decision", async () => {
    fetchMock.mockResolvedValue(mintRefusal(409));

    const result = await runWithPolls(interactiveCtx(), 1);

    expect(result.status).toBe("rejected");
    expect(
      (result.status === "rejected" ? result.reason : new Error("")).message,
    ).toContain("already awaiting your approval");
  });

  it("rotates the code while nothing claims it", async () => {
    fetchMock
      .mockResolvedValueOnce(mintResponse("ABCDE-FGHJK"))
      .mockResolvedValue(mintResponse("KLMNP-QRSTV"));
    const ctx = interactiveCtx();

    const settled = Promise.allSettled([
      runLinkPhoneFlow(ctx, { showQr: true }),
    ]);
    await vi.advanceTimersByTimeAsync(REMINT_MS + POLL_MS);
    statusMock.mockResolvedValue(CLAIMED);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(printed(ctx)).toContain("KLMNP-QRSTV");
    // The watch follows the rotation onto the code now on screen.
    expect(statusMock.mock.calls.at(-1)?.[2]).toBe("KLMNP-QRSTV");
  });

  it("refuses to run where no human can answer", async () => {
    const ctx = makeCtx({ json: true, quiet: false, nonInteractive: false });

    await expect(
      runLinkPhoneFlow(ctx, { showQr: true }),
    ).rejects.toThrowError(/interactive terminal/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when stdin is not a terminal", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    await expect(
      runLinkPhoneFlow(interactiveCtx(), { showQr: true }),
    ).rejects.toThrowError(/stdin attached to a terminal/);
  });

  it("does not sign in when the user is not logged in", async () => {
    credentialsMock.mockResolvedValue({ kind: "no-credentials" });

    await expect(
      runLinkPhoneFlow(interactiveCtx(), { showQr: true }),
    ).rejects.toThrowError(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
