import type { ReactNode } from "react";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  HostCompatibilityContext,
  useHostCompatibilityAuthorityReport,
  useHostCompatibilityProbe,
} from "@/lib/host/compatibility-state";

export function HostCompatibilityProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const compatibility = useHostCompatibilityProbe();
  // The probe's verdict is also SELECTION evidence (D13/C4): reported from
  // here, one level up from the state machine, because that machine is a
  // render function and reporting from render double-fires under StrictMode.
  useHostCompatibilityAuthorityReport(compatibility, useEffectiveHostId());
  return (
    <HostCompatibilityContext.Provider value={compatibility}>
      {props.children}
    </HostCompatibilityContext.Provider>
  );
}
