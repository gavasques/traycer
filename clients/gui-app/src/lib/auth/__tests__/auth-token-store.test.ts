/**
 * The mutation-chain atomicity of `deleteIfToken`: the compare and the
 * conditional delete run as ONE chain link, so a successor's `signIn`
 * dispatched while the compare's read is still in flight serializes wholly
 * after the delete instead of being destroyed by a stale comparison — the
 * exact interleave a read-outside-the-chain undo would allow.
 */
import { describe, expect, it } from "vitest";
import type {
  ITokenStore,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
} from "@traycer-clients/shared/platform/runner-host";
import { AuthTokenStore } from "../auth-token-store";

const IDENTITY: StoredCredentialsIdentity = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
};

function pair(token: string): StoredCredentials {
  return {
    token,
    refreshToken: `${token}-refresh`,
    savedAt: "2024-01-01T00:00:00.000Z",
    user: IDENTITY,
  };
}

interface BackingStore {
  readonly store: ITokenStore;
  readonly state: {
    current: StoredCredentials | null;
    /** Consumed by the NEXT `get`: it awaits this gate before answering. */
    nextGetGate: Promise<void> | null;
    /** When set, `delete` rejects with this error. */
    deleteError: Error | null;
  };
  readonly calls: string[];
}

function makeBackingStore(initial: StoredCredentials | null): BackingStore {
  const calls: string[] = [];
  const state: BackingStore["state"] = {
    current: initial,
    nextGetGate: null,
    deleteError: null,
  };
  const store: ITokenStore = {
    get: async (): Promise<StoredCredentials | null> => {
      calls.push("get");
      const gate = state.nextGetGate;
      state.nextGetGate = null;
      if (gate !== null) {
        await gate;
      }
      return state.current;
    },
    signIn: async (
      tokens: StoredAuthTokens,
      identity: StoredCredentialsIdentity,
    ): Promise<void> => {
      calls.push("signIn");
      state.current = {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        savedAt: "2024-01-02T00:00:00.000Z",
        user: identity,
      };
    },
    rotate: async () => {
      throw new Error("rotate is not under test");
    },
    delete: async (): Promise<void> => {
      calls.push("delete");
      if (state.deleteError !== null) {
        throw state.deleteError;
      }
      state.current = null;
    },
    subscribe: () => ({ dispose: () => undefined }),
    migrateLegacyCredentials: async () => {
      throw new Error("migration is not under test");
    },
  };
  return { store, state, calls };
}

describe("AuthTokenStore.deleteIfToken", () => {
  it("deletes only an exact token match, keeps anything else", async () => {
    const backing = makeBackingStore(pair("b-token"));
    const store = new AuthTokenStore(backing.store);
    await expect(store.deleteIfToken("a-token")).resolves.toBe("kept");
    expect(backing.state.current?.token).toBe("b-token");

    await expect(store.deleteIfToken("b-token")).resolves.toBe("deleted");
    expect(backing.state.current).toBeNull();

    await expect(store.deleteIfToken("b-token")).resolves.toBe("kept");
  });

  it("a successor signIn dispatched mid-compare survives the undo", async () => {
    // A's stale pair is on disk; A's undo enters the chain and its read
    // stalls. B's signIn is dispatched while that read is in flight — the
    // interleave that, without the chain, would read A's token, then delete
    // B's freshly-written pair with a stale comparison.
    const backing = makeBackingStore(pair("a-token"));
    const store = new AuthTokenStore(backing.store);
    let releaseGet: () => void = () => undefined;
    backing.state.nextGetGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const undo = store.deleteIfToken("a-token");
    const successorWrite = store.signIn(
      { token: "b-token", refreshToken: "b-refresh" },
      IDENTITY,
    );
    releaseGet();

    // The undo owns the chain until BOTH its read and its delete finish; the
    // successor's write runs strictly after and survives.
    await expect(undo).resolves.toBe("deleted");
    await successorWrite;
    expect(backing.calls).toEqual(["get", "delete", "signIn"]);
    expect(backing.state.current?.token).toBe("b-token");
  });

  it("a store fault inside the compare-and-delete rejects instead of resolving", async () => {
    const backing = makeBackingStore(pair("a-token"));
    backing.state.deleteError = new Error("EIO: credentials file unwritable");
    const store = new AuthTokenStore(backing.store);
    await expect(store.deleteIfToken("a-token")).rejects.toThrow(
      "EIO: credentials file unwritable",
    );
    // The pair the delete failed to remove is still there — the caller must
    // hear about it, which is exactly why the rejection is not swallowed here.
    expect(backing.state.current?.token).toBe("a-token");
  });
});
