import { useEffect, useState } from "react";
import { QrCode, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LINK_LOGIN_REMINT_MS,
  useAuthLinkLoginCode,
} from "@/hooks/auth/use-link-login-code-query";
import {
  useAuthLinkLoginStatus,
  type LinkLoginStatusDatum,
} from "@/hooks/auth/use-link-login-status-query";
import { useRespondLinkLoginMutation } from "@/hooks/auth/use-respond-link-login-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Renders the current public code as a QR. The data URL is derived state
 * from `code`; the effect exists only because the encoder's API is async.
 */
function LinkLoginQr(props: { readonly code: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(buildLinkLoginQrPayload(props.code), {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 8,
    }).then(
      (url) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      },
      () => {
        if (!cancelled) {
          setDataUrl(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.code]);

  if (dataUrl === null) {
    return <Skeleton className="aspect-square w-full max-w-64 rounded-lg" />;
  }
  return (
    <img
      src={dataUrl}
      alt="Link-a-phone QR code"
      // The QR is white-on-white by construction; the ring keeps it legible
      // as a tile on both themes without re-rendering the matrix.
      className="aspect-square w-full max-w-64 rounded-lg ring-1 ring-border/60"
    />
  );
}

/**
 * Ticks down to the moment the query's interval mints the next code. The
 * rotation happens `expiresIn − LINK_LOGIN_REMINT_MS/1000` seconds before the
 * shown code's expiry, so the target derives from the mint response the panel
 * already holds — no extra requests, just a local 1s clock.
 */
function LinkCodeRotation(props: {
  readonly expiresAtEpochSeconds: number;
  readonly expiresInSeconds: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const rotationLeadMs = props.expiresInSeconds * 1_000 - LINK_LOGIN_REMINT_MS;
  const nextCodeAtMs = props.expiresAtEpochSeconds * 1_000 - rotationLeadMs;
  const secondsLeft = Math.max(0, Math.ceil((nextCodeAtMs - nowMs) / 1_000));
  return (
    <p
      className="text-ui-xs text-muted-foreground tabular-nums"
      data-testid="link-phone-countdown"
    >
      New code in {secondsLeft}s
    </p>
  );
}

interface LiveClaim {
  readonly code: string;
  readonly claimedAt: number;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
}

function claimFromStatus(
  code: string | null,
  datum: LinkLoginStatusDatum | null | undefined,
): LiveClaim | null {
  if (
    code === null ||
    datum === null ||
    datum === undefined ||
    datum === "gone" ||
    datum.status !== "claimed" ||
    datum.claimant === null
  ) {
    return null;
  }
  return {
    code,
    claimedAt: datum.claimant.claimedAt ?? 0,
    address: datum.claimant.address,
    userAgent: datum.claimant.userAgent,
    location: datum.claimant.location,
  };
}

/**
 * First claim wins across EVERY code this panel still watches — including
 * the previous QR inside its rotation grace, so a phone that scanned just
 * before rotation still surfaces here. Ties resolve to the earliest claim.
 */
function earliestClaim(
  first: LiveClaim | null,
  second: LiveClaim | null,
): LiveClaim | null {
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }
  return second.claimedAt < first.claimedAt ? second : first;
}

/**
 * Best-effort device line for the confirmation prompt. Derived from the
 * claimant's User-Agent — descriptive, not authenticated; the copy labels it
 * approximate and the real trust anchor is "you minted this code and someone
 * just scanned it".
 */
function claimantDeviceLabel(claim: LiveClaim): string {
  const ua = claim.userAgent ?? "";
  if (ua.includes("iPhone")) {
    return "an iPhone";
  }
  if (ua.includes("iPad")) {
    return "an iPad";
  }
  if (ua.includes("Android")) {
    return "an Android device";
  }
  return "a device";
}

function ConfirmClaimCard(props: {
  readonly claim: LiveClaim;
  readonly busy: boolean;
  readonly onDecide: (approve: boolean) => void;
}) {
  const detailLine = [
    props.claim.address ?? "address unknown",
    props.claim.location ?? "location unknown",
    "just now",
  ].join(" · ");
  return (
    <div
      className="flex w-full max-w-md flex-col items-center gap-4"
      data-testid="link-phone-confirm"
    >
      <QrCode aria-hidden="true" className="text-muted-foreground" />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-ui-sm font-medium text-foreground">
          Approve sign-in from {claimantDeviceLabel(props.claim)}?
        </p>
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="link-phone-claimant"
        >
          {detailLine}
        </p>
        <p className="text-ui-xs text-muted-foreground">
          Details are approximate. Only approve if you scanned this code
          yourself.
        </p>
      </div>
      <div className="flex w-full items-center justify-center gap-3">
        <Button
          variant="default"
          disabled={props.busy}
          data-testid="link-phone-approve"
          onClick={() => {
            props.onDecide(true);
          }}
        >
          Approve
          {props.busy ? (
            <AgentSpinningDots
              variant="dots"
              className="ml-1.5"
              testId={undefined}
            />
          ) : null}
        </Button>
        <Button
          variant="outline"
          disabled={props.busy}
          data-testid="link-phone-reject"
          onClick={() => {
            props.onDecide(false);
          }}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

function ApprovedCard(props: { readonly onRestart: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3"
      data-testid="link-phone-approved"
    >
      <Smartphone aria-hidden="true" className="text-muted-foreground" />
      <p className="text-ui-sm text-foreground">
        Approved — the phone is signing in now.
      </p>
      <Button
        variant="outline"
        data-testid="link-phone-restart"
        onClick={props.onRestart}
      >
        Link another phone
      </Button>
    </div>
  );
}

function ShowingCard(props: {
  readonly minted: MintLinkLoginCodeResponse;
}) {
  return (
    <>
      <LinkLoginQr code={props.minted.code} />
      <div className="flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-ui-sm text-muted-foreground">
          In the mobile app, choose{" "}
          <span className="font-medium text-foreground">Scan QR code</span> —
          or type this code:
        </p>
        <code className="w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center font-mono text-ui-xs break-all select-all">
          {props.minted.code}
        </code>
        <div className="flex flex-col items-center gap-0.5">
          <LinkCodeRotation
            expiresAtEpochSeconds={props.minted.expires_at}
            expiresInSeconds={props.minted.expires_in}
          />
          <p
            className="text-ui-xs text-muted-foreground"
            data-testid="link-phone-single-use-hint"
          >
            Each code links one phone, expires in a minute, and needs your
            approval here.
          </p>
        </div>
      </div>
    </>
  );
}

function MintErrorCard(props: {
  readonly message: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-ui-sm text-destructive">{props.message}</p>
      <Button
        variant="outline"
        disabled={props.retrying}
        onClick={props.onRetry}
      >
        Try again
        {props.retrying ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

/**
 * Settings → Link a phone, confirm-gated. Shows a rotating public code
 * (QR + typeable text); when a phone claims it — the CURRENT code or the
 * previous one still inside its rotation grace — the QR swaps for an
 * Approve/Reject confirmation carrying the claimant's server-observed
 * metadata. Approval — never the scan — is what signs the phone in, and it
 * releases the session only to the claimant the user just reviewed.
 *
 * The panel watches every code it minted that could still be claimed (the
 * engine keeps a claimed record alive for its 2-minute approve window even
 * after the QR rotates), so first-claim-wins holds across the whole rotating
 * attempt, not per displayed alias.
 */
export function LinkPhonePanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const [approvedDone, setApprovedDone] = useState(false);
  const [mintedCodes, setMintedCodes] = useState<readonly string[]>([]);
  const respond = useRespondLinkLoginMutation();

  const watching = signedIn && !approvedDone;
  const currentStatus = useAuthLinkLoginStatus(
    watching ? (mintedCodes[0] ?? null) : null,
  );
  const previousStatus = useAuthLinkLoginStatus(
    watching ? (mintedCodes[1] ?? null) : null,
  );
  const claim = earliestClaim(
    claimFromStatus(mintedCodes[0] ?? null, currentStatus.data),
    claimFromStatus(mintedCodes[1] ?? null, previousStatus.data),
  );

  // Rotation freezes the moment any watched code is claimed: the user must
  // decide on THAT claimant, not be shown a fresh QR.
  const code = useAuthLinkLoginCode(watching && claim === null);
  const minted = code.data ?? null;
  if (minted !== null && mintedCodes[0] !== minted.code) {
    // Adjust-during-render (guarded): remember the codes this panel put on
    // screen. The two newest cover every still-claimable window — the 60s
    // code TTL spans at most one 50s rotation.
    setMintedCodes([minted.code, ...mintedCodes].slice(0, 2));
  }

  const restart = () => {
    setApprovedDone(false);
    void code.refetch();
  };

  const decide = (approve: boolean) => {
    if (claim === null) {
      return;
    }
    respond.mutate(
      { code: claim.code, approve },
      {
        onSuccess: (outcome) => {
          if (approve && (outcome === "ok" || outcome === "already-decided")) {
            setApprovedDone(true);
            return;
          }
          // Rejected (or the record vanished): resume with a fresh code.
          void code.refetch();
        },
        onError: () => {
          void code.refetch();
        },
      },
    );
  };

  let body: React.ReactNode;
  if (!signedIn) {
    body = (
      <p className="text-ui-sm text-muted-foreground">
        Sign in on this device first — the phone takes over this account.
      </p>
    );
  } else if (approvedDone) {
    body = <ApprovedCard onRestart={restart} />;
  } else if (claim !== null) {
    body = (
      <ConfirmClaimCard
        claim={claim}
        busy={respond.isPending}
        onDecide={decide}
      />
    );
  } else if (minted !== null) {
    body = <ShowingCard minted={minted} />;
  } else if (code.isError) {
    body = (
      <MintErrorCard
        message={
          code.error instanceof Error
            ? code.error.message
            : "Could not mint a link code."
        }
        retrying={code.isRefetching}
        onRetry={() => {
          void code.refetch();
        }}
      />
    );
  } else {
    body = (
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="aspect-square w-full max-w-64 rounded-lg" />
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }

  return (
    <SettingsPanelShell
      title="Link a phone"
      description="Sign the Traycer mobile app in by scanning a code from this device. Scanning alone signs nothing in — you approve each phone here before it gets access."
    >
      <div className="flex flex-col items-center gap-6 p-6">{body}</div>
    </SettingsPanelShell>
  );
}
