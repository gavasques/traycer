import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { PinnedSurfaceDeadState } from "@/components/host/pinned-surface-dead-state";
import {
  usePinnedSurfaceDead,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";

interface ReachabilityStub {
  status: "reachable" | "unreachable";
  hostLabel: string;
  unavailability: HostUnavailability | null;
}

interface DirectoryStub {
  data: Array<{ readonly hostId: string }> | undefined;
}

const reachability = vi.hoisted(
  (): ReachabilityStub => ({
    status: "unreachable",
    hostLabel: "MacBook",
    unavailability: "offline",
  }),
);

const directory = vi.hoisted(
  (): DirectoryStub => ({
    data: [{ hostId: "host-1" }],
  }),
);

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => reachability,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: directory.data,
    fetchStatus: "idle",
  }),
}));

function pinnedPin(): SurfaceHostPin {
  return {
    selection: "host-1",
    setSelection: () => undefined,
    resolvedHostId: "host-1",
    isPinned: true,
    latchOnFirstUse: () => undefined,
    followEffective: () => undefined,
  };
}

function DeadHarness(props: {
  readonly pin: SurfaceHostPin;
  readonly onUseActiveHost: () => void;
}) {
  const dead = usePinnedSurfaceDead(props.pin);
  if (!dead.isDead) return <div data-testid="surface-live">live</div>;
  return (
    <PinnedSurfaceDeadState
      hostLabel={dead.hostLabel}
      unavailability={dead.unavailability}
      vanished={dead.vanished}
      onUseActiveHost={props.onUseActiveHost}
      testId="surface-pinned-host-dead"
    />
  );
}

describe("<PinnedSurfaceDeadState /> via usePinnedSurfaceDead", () => {
  beforeEach(() => {
    reachability.status = "unreachable";
    reachability.hostLabel = "MacBook";
    reachability.unavailability = "offline";
    directory.data = [{ hostId: "host-1" }];
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the unreachable copy and keep-pin / follow-active affordances", () => {
    const onUseActiveHost = vi.fn();
    render(<DeadHarness pin={pinnedPin()} onUseActiveHost={onUseActiveHost} />);

    expect(screen.getByTestId("surface-pinned-host-dead")).toBeDefined();
    expect(screen.getByText(/MacBook is unreachable/)).toBeDefined();
    expect(screen.getByText(/stays pinned here/)).toBeDefined();
    expect(screen.getByText(/Reselect/)).toBeDefined();
    expect(screen.queryByText("Loading workspaces…")).toBeNull();
    fireEvent.click(screen.getByTestId("surface-pinned-host-dead-use-active"));
    expect(onUseActiveHost).toHaveBeenCalledTimes(1);
  });

  it("renders the requires-upgrade copy for a plan-restricted pin", () => {
    reachability.unavailability = "plan-restricted";
    render(
      <DeadHarness pin={pinnedPin()} onUseActiveHost={() => undefined} />,
    );

    expect(screen.getByText(/MacBook requires upgrade/)).toBeDefined();
    expect(screen.queryByText(/is offline/)).toBeNull();
  });

  it("degrades a removed-from-directory pin without printing the raw id", () => {
    directory.data = [{ hostId: "other-host" }];
    reachability.hostLabel = "host-1";
    render(
      <DeadHarness pin={pinnedPin()} onUseActiveHost={() => undefined} />,
    );

    expect(
      screen.getByText(/The pinned host is no longer connected/),
    ).toBeDefined();
    expect(screen.queryByText("host-1")).toBeNull();
    expect(screen.queryByText("Loading workspaces…")).toBeNull();
    expect(screen.getByTestId("surface-pinned-host-dead-use-active")).toBeDefined();
  });

  it("does not render the dead state while following", () => {
    render(
      <DeadHarness
        pin={{ ...pinnedPin(), isPinned: false, selection: null }}
        onUseActiveHost={() => undefined}
      />,
    );
    expect(screen.getByTestId("surface-live")).toBeDefined();
  });
});
