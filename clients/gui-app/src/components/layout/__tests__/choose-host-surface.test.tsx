import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostDirectory,
  type HostDirectoryService,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { lastLocalHostIdKey, lastSelectedHostKey } from "@/lib/persist";
import { ChooseHostSurface } from "@/components/layout/choose-host-surface";

const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

const hostA: HostDirectoryEntry = {
  hostId: "host-a",
  label: "Host A",
  kind: "remote",
  websocketUrl: "wss://host-a.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const hostB: HostDirectoryEntry = {
  hostId: "host-b",
  label: "Host B",
  kind: "remote",
  websocketUrl: "wss://host-b.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const hostC: HostDirectoryEntry = {
  hostId: "host-c",
  label: "Host C",
  kind: "remote",
  websocketUrl: null,
  version: "0.0.0-mock",
  transportDialability: "not-dialable",
};

function makeHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildMessengerFactory(): MessengerFactory<HostRpcRegistry> {
  // `<ChooseHostSurface />` never issues an RPC call, so no handlers are
  // registered - a call reaching this messenger would be a test bug, and the
  // mock throws loudly for an unregistered method rather than hanging.
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {},
    });
}

interface DirectoryHandle {
  readonly getDirectory: () => HostDirectoryService | null;
}

function renderChooseHostSurface(
  entries: readonly HostDirectoryEntry[],
): DirectoryHandle {
  const host = makeHost();
  const queryClient = buildQueryClient();
  const directoryHolder: { current: HostDirectoryService | null } = {
    current: null,
  };

  function DirectoryProbe(): ReactNode {
    const directory = useHostDirectory();
    useEffect(() => {
      directoryHolder.current = directory;
    });
    return null;
  }

  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={buildMessengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries })}
          fallback={<div data-testid="runtime-fallback">loading</div>}
        >
          <DirectoryProbe />
          <ChooseHostSurface />
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return { getDirectory: () => directoryHolder.current };
}

describe("<ChooseHostSurface />", () => {
  beforeEach(() => {
    window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
    window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
    window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
  });

  it("renders one row per directory entry and disables the offline row", async () => {
    renderChooseHostSurface([hostA, hostB, hostC]);

    await screen.findByTestId("choose-host-surface");
    const rowA = await screen.findByTestId("choose-host-host-a");
    const rowB = await screen.findByTestId("choose-host-host-b");
    const rowC = await screen.findByTestId("choose-host-host-c");

    expect(rowA.hasAttribute("disabled")).toBe(false);
    expect(rowB.hasAttribute("disabled")).toBe(false);
    expect(rowC.hasAttribute("disabled")).toBe(true);
  });

  it("selects an online host on click", async () => {
    const { getDirectory } = renderChooseHostSurface([hostA, hostB, hostC]);
    const rowA = await screen.findByTestId("choose-host-host-a");

    expect(getDirectory()?.getSelected()).toBeNull();

    fireEvent.click(rowA);

    await waitFor(() => {
      expect(getDirectory()?.getSelected()?.hostId).toBe(hostA.hostId);
    });
  });

  it("does nothing when the disabled offline row is clicked - the P1 dead-end regression", async () => {
    // Pins the fix: selecting an offline host used to strand the mobile
    // shell on a dead-end unavailable screen. The row is disabled, and a
    // click must not reach `HostDirectoryService.selectById()` at all.
    const { getDirectory } = renderChooseHostSurface([hostA, hostB, hostC]);
    const rowC = await screen.findByTestId("choose-host-host-c");

    expect(rowC.hasAttribute("disabled")).toBe(true);
    fireEvent.click(rowC);

    expect(getDirectory()?.getSelected()).toBeNull();
  });
});
