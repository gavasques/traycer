import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceFlowResult } from "@traycer-clients/shared/platform/runner-host";
import { MobileRunnerHost } from "../src/mobile-runner-host";

const nativeMocks = vi.hoisted(() => ({
  browserOpen: vi.fn(),
  browserClose: vi.fn(),
  storageKeys: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock("@capacitor/browser", () => ({
  Browser: {
    open: nativeMocks.browserOpen,
    close: nativeMocks.browserClose,
  },
}));

vi.mock("capacitor-secure-storage-plugin", () => ({
  SecureStoragePlugin: {
    keys: nativeMocks.storageKeys,
    get: nativeMocks.storageGet,
    set: nativeMocks.storageSet,
    remove: nativeMocks.storageRemove,
  },
}));

function runner(): MobileRunnerHost {
  return new MobileRunnerHost({
    signInUrl: "http://localhost:32352/sign-in",
    authnBaseUrl: "http://localhost:32350",
    hostLabel: "test-slot",
  });
}

describe("MobileRunnerHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeMocks.storageKeys.mockResolvedValue({ value: [] });
    nativeMocks.browserOpen.mockResolvedValue(undefined);
    nativeMocks.browserClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats an absent secure-storage key as a signed-out session", async () => {
    const host = runner();

    await expect(host.tokenStore.get()).resolves.toBeNull();
    expect(nativeMocks.storageGet).not.toHaveBeenCalled();
  });

  it("publishes a null local-host snapshot synchronously", () => {
    const snapshots: unknown[] = [];

    runner().onLocalHostChange((snapshot) => snapshots.push(snapshot));

    expect(snapshots).toEqual([null]);
  });

  it("completes poll-only device authorization and closes the browser", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-code",
          user_code: "ABCDE-FGHIJ",
          verification_uri: "https://app.traycer.test/device",
          verification_uri_complete:
            "https://app.traycer.test/device?user_code=ABCDE-FGHIJ",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 428 }))
      .mockResolvedValueOnce(
        Response.json({ token: "access-token", refreshToken: "refresh-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const session = await runner().deviceFlow.start();
    expect(session).not.toBeNull();
    if (session === null) return;
    const result = new Promise<DeviceFlowResult>((resolve) => {
      session.onResult(resolve);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    session.pollNow();

    await expect(result).resolves.toEqual({
      kind: "authorized",
      token: "access-token",
      refreshToken: "refresh-token",
    });
    expect(nativeMocks.browserClose).toHaveBeenCalledOnce();
  });
});
