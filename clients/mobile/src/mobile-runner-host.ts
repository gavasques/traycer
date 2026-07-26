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
  credentialsIdentityFromAuthenticatedUser,
  refreshOnceAbortable,
  validateAuthTokenIdentityAccessOnceAbortable,
  validateAuthTokenIdentityAccessOnly,
} from "@traycer-clients/shared/auth/auth-validation";
import type {
  CredentialsMigrationOutcome,
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
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
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
  readonly tokenStore: ITokenStore;
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
    this.tokenStore = new MobileTokenStore(
      this.secureStorage,
      options.authnBaseUrl,
    );
    this.deviceFlow = new MobileDeviceFlowHost(
      options.authnBaseUrl,
      options.hostLabel,
    );
  }

  beginAuthAttempt(): void {
    // Device-flow tokens arrive through `deviceFlow`; there is no callback
    // payload or attempt-specific URL state in the mobile shell.
  }

  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    // Access-only (tech plan §3): a stale token comes back `rejected` and the
    // caller routes the refresh spend through the locked `tokenStore.rotate`,
    // so validation can never consume a refresh token.
    return validateAuthTokenIdentityAccessOnly(this.authnBaseUrl, token);
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

// Must not be "traycer.token"/"traycer.refresh-token": AuthService owns those
// as the retired legacy per-window slots and wipes them at startup after its
// migration pre-step, which would destroy this store's credentials.
const MOBILE_TOKEN_STORE_KEY = "traycer.credentials";
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

/**
 * Secure-storage-backed `ITokenStore` holding the full `StoredCredentials`
 * JSON under a single key. Mirrors the shared mock's rotate/migration
 * semantics (same guards, real HTTP refresh) - mobile has a single JS runtime
 * and no shared credentials file, so there is no cross-process lock; the
 * sequential guards inside `rotate` are the whole protocol.
 */
class MobileTokenStore implements ITokenStore {
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();
  private revision = 0;

  constructor(
    private readonly secureStorage: ISecureStorage,
    private readonly authnBaseUrl: string,
  ) {}

  async get(): Promise<StoredCredentials | null> {
    return parseStoredCredentials(
      await this.secureStorage.get(MOBILE_TOKEN_STORE_KEY),
    );
  }

  async signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    await this.write({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      authnBaseUrl: this.authnBaseUrl,
      savedAt: new Date().toISOString(),
      user: identity,
    });
  }

  async rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    const stored = await this.get();
    if (stored === null) {
      return { outcome: "deleted", pair: null };
    }
    if (stored.user.id !== expected.userId) {
      return { outcome: "user-mismatch", pair: stored };
    }
    if (stored.token !== expected.token) {
      return { outcome: "superseded", pair: stored };
    }
    const refreshed = await refreshOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: stored.token,
      refreshToken: stored.refreshToken,
      signal: null,
    });
    if (refreshed.kind === "network-error") {
      return { outcome: "refresh-network", pair: null };
    }
    if (refreshed.kind === "rejected") {
      return { outcome: "refresh-rejected", pair: null };
    }
    const next: StoredCredentials = {
      ...stored,
      token: refreshed.token,
      refreshToken: refreshed.refreshToken,
      savedAt: new Date().toISOString(),
    };
    await this.write(next);
    return { outcome: "applied", pair: next };
  }

  async delete(): Promise<void> {
    await this.secureStorage.delete(MOBILE_TOKEN_STORE_KEY);
    this.notifyAfterMutation();
  }

  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    // Same branches as the shared mock: an existing credential wins, an
    // absent one adopts the spent legacy pair after a real probe + refresh.
    const existing = await this.get();
    if (existing !== null) {
      return "file-wins";
    }
    const probe = await validateAuthTokenIdentityAccessOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: legacy.token,
      signal: null,
    });
    if (probe.kind === "network-error") return "retryable";
    if (probe.kind !== "valid") return "identity-unknown";
    const refreshed = await refreshOnceAbortable({
      authnBaseUrl: this.authnBaseUrl,
      token: legacy.token,
      refreshToken: legacy.refreshToken,
      signal: null,
    });
    if (refreshed.kind === "network-error") return "retryable";
    if (refreshed.kind === "rejected") return "terminal-dead";
    await this.write({
      token: refreshed.token,
      refreshToken: refreshed.refreshToken,
      authnBaseUrl: this.authnBaseUrl,
      savedAt: new Date().toISOString(),
      user: credentialsIdentityFromAuthenticatedUser(probe.user),
    });
    return "committed";
  }

  private async write(credentials: StoredCredentials): Promise<void> {
    await this.secureStorage.set(
      MOBILE_TOKEN_STORE_KEY,
      JSON.stringify(credentials),
    );
    this.notifyAfterMutation();
  }

  // Self-writes notify on a microtask so the caller's apply path finishes
  // before the change event lands, matching the watcher-after-write ordering
  // the shared AuthService expects (see mock-runner-host.ts).
  private notifyAfterMutation(): void {
    queueMicrotask(() => {
      void this.get().then((stored) => {
        this.revision += 1;
        const change: TokenStoreChange = {
          present: stored !== null,
          userId: stored?.user.id ?? null,
          revision: this.revision,
        };
        for (const listener of this.listeners) {
          listener(change);
        }
      });
    });
  }
}

function parseStoredCredentials(raw: string | null): StoredCredentials | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const user = record.user;
  if (user === null || user === undefined || typeof user !== "object") {
    return null;
  }
  const userRecord = user as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.refreshToken !== "string" ||
    typeof record.authnBaseUrl !== "string" ||
    typeof record.savedAt !== "string" ||
    typeof userRecord.id !== "string" ||
    typeof userRecord.email !== "string" ||
    typeof userRecord.name !== "string"
  ) {
    // A pre-cutover `{token, refreshToken}` pair deliberately parses as
    // invalid: it reads as signed out and the user re-auths via device flow.
    return null;
  }
  return {
    token: record.token,
    refreshToken: record.refreshToken,
    authnBaseUrl: record.authnBaseUrl,
    savedAt: record.savedAt,
    user: {
      id: userRecord.id,
      email: userRecord.email,
      name: userRecord.name,
    },
  };
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
