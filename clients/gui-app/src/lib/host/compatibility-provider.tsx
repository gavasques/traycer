import type { ReactNode } from "react";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  HostCompatibilityContext,
  useHostCompatibilityAuthorityReport,
  useHostCompatibilityProbe,
  useHostStatusReprobeOnRepoint,
} from "@/lib/host/compatibility-state";

export function HostCompatibilityProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const effectiveHostId = useEffectiveHostId();
  const compatibility = useHostCompatibilityProbe();
  // The probe's verdict is also SELECTION evidence (D13/C4): reported from
  // here, one level up from the state machine, because that machine is a
  // render function and reporting from render double-fires under StrictMode.
  useHostCompatibilityAuthorityReport(compatibility, effectiveHostId);
  // A host becoming effective re-probes it. Here rather than inside the probe
  // hook because the trigger is the POINTER moving, which the probe cannot
  // see: it only ever knows the host it is currently keyed to.
  useHostStatusReprobeOnRepoint(effectiveHostId);
  return (
    <HostCompatibilityContext.Provider value={compatibility}>
      {props.children}
    </HostCompatibilityContext.Provider>
  );
}
