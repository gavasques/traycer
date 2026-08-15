/**
 * The QR payload contract: whatever the desktop encodes, the phone's parser
 * must recover — and pasted prose, foreign QRs, and malformed codes must all
 * come back `null` rather than being sent to the redeem endpoint.
 */
import { describe, expect, it } from "vitest";
import {
  buildLinkLoginQrPayload,
  parseLinkLoginInput,
} from "../link-login";

// Shape parity with authn's generator: base64url of 32 random bytes.
const CODE = "A".repeat(43);

describe("QR payload build/parse", () => {
  it("round-trips the v1 payload", () => {
    const payload = buildLinkLoginQrPayload(CODE);
    expect(payload).toBe(`traycer://link-login?code=${CODE}`);
    expect(parseLinkLoginInput(payload)).toBe(CODE);
  });

  it("accepts the bare code (manual-entry path), with surrounding whitespace", () => {
    expect(parseLinkLoginInput(CODE)).toBe(CODE);
    expect(parseLinkLoginInput(`  ${CODE}\n`)).toBe(CODE);
  });

  it("rejects text that carries no plausible code", () => {
    expect(parseLinkLoginInput("")).toBeNull();
    expect(parseLinkLoginInput("hello world")).toBeNull();
    expect(parseLinkLoginInput("A".repeat(42))).toBeNull();
    expect(parseLinkLoginInput("A".repeat(44))).toBeNull();
    expect(parseLinkLoginInput(`${"A".repeat(42)}!`)).toBeNull();
  });

  it("rejects foreign URLs and near-miss payloads", () => {
    expect(parseLinkLoginInput(`https://evil.test/?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`other://link-login?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`traycer://elsewhere?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login")).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login?code=short")).toBeNull();
  });
});
