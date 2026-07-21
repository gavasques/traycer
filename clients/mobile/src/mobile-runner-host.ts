import { Browser } from "@capacitor/browser";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import {
  applySlowDown,
  createPollSchedule,
  DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
  isDeviceExpired,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorizationResult,
  type DevicePollSchedule,
} from "@traycer-clients/shared/auth/device-auth";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import {
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  validateAuthTokenViaHttp,
} from "@traycer-clients/shared/auth/auth-validation";
import type {
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
  DeviceFlowAuthorization,
  DeviceFlowResult,
  DeviceFlowSession,
  IDeviceFlowHost,
  IHostPicker,
  INotificationHost,
  IRunnerHost,
  ISecureStorage,
  ITokenStore,
  ITrayState,
  IWorkspaceFoldersHost,
  LocalHostSnapshot,
  StoredAuthTokens,
  TrayEpic,
  TrayIndicatorState,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

export interface MobileRunnerHostOptions {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hostLabel: string;
}

export class MobileRunnerHost implements IRunnerHost {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hasLocalHost = false;
  readonly secureStorage: ISecureStorage = buildSecureStorage();
  readonly tokenStore: ITokenStore = buildTokenStore(this.secureStorage);
  readonly notifications: INotificationHost = buildNotifications();
  readonly tray: ITrayState = new MobileNoopTrayState();
  readonly hostPicker: IHostPicker = new MobileHostPicker();
  readonly workspaceFolders: IWorkspaceFoldersHost = {
    pickFolders: async (): Promise<readonly string[]> => [],
  };
  readonly fileDrops = {
    resolveDroppedFilePaths: async (
      files: readonly File[],
    ): Promise<readonly string[]> => {
      void files;
      return [];
    },
    copyDroppedFilePaths: async (
      paths: readonly string[],
    ): Promise<readonly string[]> => paths,
    readNativeClipboardFilePaths: async (): Promise<readonly string[]> => [],
  };
  readonly zoom = null;
  readonly service = null;
  readonly traycerCli = null;
  readonly migration = null;
  readonly hostManagement = null;
  readonly hostTray = null;
  readonly deviceFlow: IDeviceFlowHost;

  constructor(options: MobileRunnerHostOptions) {
    this.signInUrl = options.signInUrl;
    this.authnBaseUrl = options.authnBaseUrl;
    this.deviceFlow = new MobileDeviceFlowHost(
      options.authnBaseUrl,
      options.hostLabel,
    );
  }

  beginAuthAttempt(): void {
    // Device-flow tokens arrive through `deviceFlow`; there is no callback
    // payload or attempt-specific URL state in the mobile shell.
  }

  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult> {
    return validateAuthTokenViaHttp(this.authnBaseUrl, token, refreshToken);
  }

  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult> {
    return validateAuthTokenIdentityViaHttp(
      this.authnBaseUrl,
      token,
      refreshToken,
    );
  }

  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult> {
    return refreshAuthTokenViaHttp(this.authnBaseUrl, token, refreshToken);
  }

  async openExternalLink(url: string): Promise<void> {
    await Browser.open({ url, presentationStyle: "popover" });
  }

  async getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]> {
    void schemes;
    return [];
  }

  async requestMicrophoneAccess(): Promise<"granted" | "denied"> {
    return "granted";
  }

  async openMicrophoneSettings(): Promise<void> {
    // Mobile microphone permissions are driven by `getUserMedia`.
  }

  onAuthCallback(handler: () => void): Disposable {
    void handler;
    return disposable();
  }

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    handler(null);
    return disposable();
  }

  onSystemResumed(handler: () => void): Disposable {
    void handler;
    return disposable();
  }

  async requestHostRespawn(): Promise<void> {
    // The selected dev slot owns the host lifecycle.
  }
}

class MobileDeviceFlowHost implements IDeviceFlowHost {
  constructor(
    private readonly authnBaseUrl: string,
    private readonly hostLabel: string,
  ) {}

  async start(): Promise<DeviceFlowSession | null> {
    const authorization = await startDeviceAuthorization(
      this.authnBaseUrl,
      { clientId: "desktop", hostLabel: this.hostLabel },
      { signal: undefined, timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS },
    );
    if (authorization.kind !== "started") {
      return null;
    }
    return new MobileDeviceFlowSession(this.authnBaseUrl, authorization);
  }
}

class MobileDeviceFlowSession implements DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization;
  private readonly abortController = new AbortController();
  private readonly handlers = new Set<(result: DeviceFlowResult) => void>();
  private settledResult: DeviceFlowResult | null = null;
  private wakePoll: (() => void) | null = null;

  constructor(
    private readonly authnBaseUrl: string,
    private readonly started: Extract<
      DeviceAuthorizationResult,
      { kind: "started" }
    >,
  ) {
    this.authorization = {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresInSeconds: started.expiresInSeconds,
      intervalSeconds: started.intervalSeconds,
    };
    void this.run();
  }

  onResult(handler: (result: DeviceFlowResult) => void): Disposable {
    if (this.settledResult !== null) {
      handler(this.settledResult);
      return disposable();
    }
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  pollNow(): void {
    this.wakePoll?.();
  }

  cancel(): void {
    this.abortController.abort();
    this.wakePoll?.();
    this.handlers.clear();
    void Browser.close().catch(() => undefined);
  }

  private async run(): Promise<void> {
    let schedule: DevicePollSchedule = createPollSchedule({
      intervalSeconds: this.started.intervalSeconds,
      expiresInSeconds: this.started.expiresInSeconds,
      startedAtMs: Date.now(),
    });
    while (!this.abortController.signal.aborted) {
      if (isDeviceExpired(schedule, Date.now())) {
        this.settle({ kind: "expired" });
        return;
      }
      const poll = await pollDeviceToken(
        this.authnBaseUrl,
        this.started.deviceCode,
        "desktop",
        {
          signal: this.abortController.signal,
          timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
        },
      );
      if (this.abortController.signal.aborted) {
        return;
      }
      switch (poll.kind) {
        case "authorized":
          this.settle({
            kind: "authorized",
            token: poll.token,
            refreshToken: poll.refreshToken,
          });
          return;
        case "access-denied":
          this.settle({ kind: "denied" });
          return;
        case "expired":
          this.settle({ kind: "expired" });
          return;
        case "invalid":
          this.settle({ kind: "error" });
          return;
        case "slow-down":
          schedule = applySlowDown(schedule, poll.retryAfterSeconds);
          break;
        case "authorization-pending":
        case "network-error":
          break;
      }
      await this.waitForNextPoll(schedule.intervalMs);
    }
  }

  private waitForNextPoll(intervalMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener("abort", finish);
        if (this.wakePoll === finish) {
          this.wakePoll = null;
        }
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      this.wakePoll = finish;
      this.abortController.signal.addEventListener("abort", finish, {
        once: true,
      });
    });
  }

  private settle(result: DeviceFlowResult): void {
    if (this.settledResult !== null || this.abortController.signal.aborted) {
      return;
    }
    this.settledResult = result;
    for (const handler of this.handlers) {
      handler(result);
    }
    this.handlers.clear();
    void Browser.close().catch(() => undefined);
  }
}

const MOBILE_TOKEN_STORE_KEY = "traycer.token";
const MISSING_STORAGE_ITEM = "Item with given key does not exist";

function buildSecureStorage(): ISecureStorage {
  return {
    get: async (key) => {
      const keys = await SecureStoragePlugin.keys();
      if (!keys.value.includes(key)) return null;
      return SecureStoragePlugin.get({ key })
        .then((result) => result.value)
        .catch((error: unknown) => {
          if (isMissingStorageItem(error)) return null;
          throw error;
        });
    },
    set: async (key, value) => {
      await SecureStoragePlugin.set({ key, value });
    },
    delete: async (key) => {
      const keys = await SecureStoragePlugin.keys();
      if (!keys.value.includes(key)) return;
      await SecureStoragePlugin.remove({ key }).catch((error: unknown) => {
        if (!isMissingStorageItem(error)) throw error;
      });
    },
  };
}

function isMissingStorageItem(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(MISSING_STORAGE_ITEM)
  );
}

function buildTokenStore(secureStorage: ISecureStorage): ITokenStore {
  return {
    get: async () =>
      parseStoredAuthTokens(await secureStorage.get(MOBILE_TOKEN_STORE_KEY)),
    set: async (tokens) => {
      await secureStorage.set(MOBILE_TOKEN_STORE_KEY, JSON.stringify(tokens));
    },
    delete: async () => {
      await secureStorage.delete(MOBILE_TOKEN_STORE_KEY);
    },
  };
}

function parseStoredAuthTokens(raw: string | null): StoredAuthTokens | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.refreshToken !== "string"
  ) {
    return null;
  }
  return { token: record.token, refreshToken: record.refreshToken };
}

function buildNotifications(): INotificationHost {
  return {
    show: async (title, body, payload, replaceKey, deliveryKey) => {
      void title;
      void body;
      void payload;
      void replaceKey;
      void deliveryKey;
    },
    onClick: (handler) => {
      void handler;
      return disposable();
    },
  };
}

function disposable(): Disposable {
  return { dispose: () => undefined };
}

class MobileNoopTrayState implements ITrayState {
  async setEpics(epics: readonly TrayEpic[]): Promise<void> {
    void epics;
  }

  async setIndicator(state: TrayIndicatorState): Promise<void> {
    void state;
  }

  onEpicSelected(handler: (epicId: string) => void): Disposable {
    void handler;
    return disposable();
  }
}

class MobileHostPicker implements IHostPicker {
  private open = false;
  private readonly handlers = new Set<(isOpen: boolean) => void>();

  get isOpen(): boolean {
    return this.open;
  }

  requestOpen(): void {
    this.setOpen(true);
  }

  requestClose(): void {
    this.setOpen(false);
  }

  onChange(handler: (isOpen: boolean) => void): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    for (const handler of this.handlers) {
      handler(open);
    }
  }
}
