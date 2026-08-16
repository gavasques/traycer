import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../../config";
import type { PreferredHostStore } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { environmentSubdir } from "../host/host-paths";

const PREFERRED_HOST_STATE_VERSION = 1;

interface PreferredHostStoreLogger {
  warn(message: string, meta: unknown): void;
}

/**
 * Environment-scoped, mirroring `resolveDesktopStateFilePath`: a staging
 * window must not inherit the host a production window was activated on -
 * the ids name registry rows in different clouds.
 */
export function resolvePreferredHostFilePath(): string {
  const base = environmentSubdir(
    join(homedir(), ".traycer"),
    config.environment,
  );
  return join(base, "desktop-preferred-host.json");
}

/**
 * Durable, IDENTITY-SCOPED home of `preferredHostId` (G1).
 *
 * SYNCHRONOUS on purpose. The engine loads the preference inside the identity
 * transaction that establishes the identity, and an async load would land
 * after the first derivation - the user would watch the app pick a host and
 * then move. The file holds one short string per account and is written only
 * on Activate or a deregister-clear, so the main thread pays a rare small
 * write, never a hot path.
 *
 * A bucket is DELETED on sign-out rather than merely scoped: persistence
 * exists to survive a restart, not a user switch, and a shared machine must
 * not show the previous user their host choice. Scoping alone would already
 * stop account B inheriting account A's id; deleting also honours the
 * "sign-out wipes" half of G1.
 */
export class DesktopPreferredHostStore implements PreferredHostStore {
  private readonly filePath: string;
  private readonly logger: PreferredHostStoreLogger;
  /** Lazily read once, then authoritative: this process is the only writer. */
  private byIdentity: Map<string, string> | null = null;

  constructor(filePath: string, logger: PreferredHostStoreLogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    return this.read().get(identityKey) ?? null;
  }

  save(identityKey: string | null, hostId: string | null): void {
    if (identityKey === null) return;
    const entries = this.read();
    if (hostId === null) {
      if (!entries.delete(identityKey)) return;
    } else {
      if (entries.get(identityKey) === hostId) return;
      entries.set(identityKey, hostId);
    }
    this.write(entries);
  }

  private read(): Map<string, string> {
    const cached = this.byIdentity;
    if (cached !== null) return cached;
    const entries = new Map<string, string>();
    this.byIdentity = entries;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      // No file yet (the common first-run case) or unreadable: an absent
      // preference is a legitimate state - derivation defaults to local.
      return entries;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return entries;
      const record: Record<string, unknown> = { ...parsed };
      if (record["version"] !== PREFERRED_HOST_STATE_VERSION) return entries;
      const byIdentity = record["byIdentity"];
      if (byIdentity === null || typeof byIdentity !== "object") return entries;
      for (const [key, value] of Object.entries({ ...byIdentity })) {
        if (typeof value === "string" && value.length > 0) {
          entries.set(key, value);
        }
      }
    } catch (error: unknown) {
      // A corrupt file degrades to "no preference", never to a crash: the
      // whole point of this value is that losing it is survivable.
      this.logger.warn("[selection-preferred] unreadable state file", {
        error: String(error),
      });
    }
    return entries;
  }

  private write(entries: Map<string, string>): void {
    const payload = JSON.stringify({
      version: PREFERRED_HOST_STATE_VERSION,
      byIdentity: Object.fromEntries(entries),
    });
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that reads as "no preference" on the next launch.
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, payload, "utf8");
      renameSync(temporaryPath, this.filePath);
    } catch (error: unknown) {
      this.logger.warn("[selection-preferred] state write failed", {
        error: String(error),
      });
    }
  }
}
