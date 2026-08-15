/**
 * The QR payload contract: whatever the desktop encodes, the phone's parser
 * must recover in NORMALIZED form — and pasted prose, foreign QRs, and
 * malformed codes must all come back `null` rather than being sent to the
 * claim endpoint.
 */
import { describe, expect, it } from "vitest";
import {
  buildLinkLoginQrPayload,
  normalizeLinkLoginCodeInput,
  parseLinkLoginInput,
} from "../link-login";

// Display form as the desktop mints it; Crockford, no I/L/O/U.
const CODE = "ABCDE-FGHJK";
const NORMALIZED = "ABCDEFGHJK";

describe("QR payload build/parse", () => {
  it("round-trips the v1 payload into the normalized code", () => {
    const payload = buildLinkLoginQrPayload(CODE);
    expect(payload).toBe(`traycer://link-login?code=${CODE}`);
    expect(parseLinkLoginInput(payload)).toBe(NORMALIZED);
  });

  it("accepts typed codes in any dash/case variation the normalization covers", () => {
    expect(parseLinkLoginInput(CODE)).toBe(NORMALIZED);
    expect(parseLinkLoginInput("abcde-fghjk")).toBe(NORMALIZED);
    expect(parseLinkLoginInput("  abcdefghjk\n")).toBe(NORMALIZED);
    // The Crockford visual folds: I/L -> 1, O -> 0.
    expect(parseLinkLoginInput("abcde-fghil")).toBe(
      normalizeLinkLoginCodeInput("ABCDEFGH11"),
    );
  });

  it("rejects text that carries no plausible code", () => {
    expect(parseLinkLoginInput("")).toBeNull();
    // NB: ten-letter prose CAN normalize into code shape ("hello world" →
    // HE110W0R1D via the visual folds) — that matches the device approval
    // page's typing contract, and the server uniform-rejects unknown codes.
    expect(parseLinkLoginInput("clearly not a code")).toBeNull();
    expect(parseLinkLoginInput("ABCDE-FGHJ")).toBeNull(); // 9 chars
    expect(parseLinkLoginInput("ABCDE-FGHJKM")).toBeNull(); // 11 chars
    expect(parseLinkLoginInput("ABCDE-FGHU!")).toBeNull(); // outside alphabet
  });

  it("rejects foreign URLs and near-miss payloads", () => {
    expect(parseLinkLoginInput(`https://evil.test/?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`other://link-login?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`traycer://elsewhere?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login")).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login?code=nope")).toBeNull();
  });
});
