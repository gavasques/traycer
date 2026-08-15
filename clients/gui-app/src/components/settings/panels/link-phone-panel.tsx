import { useEffect, useState } from "react";
import { QrCode, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LINK_LOGIN_REMINT_MS,
  useAuthLinkLoginCode,
} from "@/hooks/auth/use-link-login-code-query";
import { useAuthLinkLoginStatus } from "@/hooks/auth/use-link-login-status-query";
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

interface ClaimantView {
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
}

/**
 * Best-effort device line for the confirmation prompt. Derived from the
 * claimant's User-Agent — descriptive, not authenticated; the copy labels it
 * approximate and the real trust anchor is "you minted this code and someone
 * just scanned it".
 */
function claimantDeviceLabel(claimant: ClaimantView): string {
  const ua = claimant.userAgent ?? "";
  if (ua.includes("iPhone")) return "an iPhone";
  if (ua.includes("iPad")) return "an iPad";
  if (ua.includes("Android")) return "an Android device";
  return "a device";
}

type PanelPhase =
  | { readonly kind: "showing" }
  | { readonly kind: "deciding"; readonly code: string }
  | { readonly kind: "approved" };

/**
 * Settings → Link a phone, confirm-gated. Shows a rotating public code
 * (QR + typeable text); when a phone claims it, the QR swaps for an
 * Approve/Reject confirmation carrying the claimant's server-observed
 * metadata. Approval — never the scan — is what signs the phone in, and it
 * releases the session only to the claimant the user just reviewed.
 */
export function LinkPhonePanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const [phase, setPhase] = useState<PanelPhase>({ kind: "showing" });
  const showing = phase.kind === "showing";
  const code = useAuthLinkLoginCode(signedIn && showing);
  const watchedCode =
    phase.kind === "deciding"
      ? phase.code
      : showing && code.data !== null && code.data !== undefined
        ? code.data.code
        : null;
  const status = useAuthLinkLoginStatus(signedIn ? watchedCode : null);
  const respond = useRespondLinkLoginMutation();

  const statusData = status.data;
  useEffect(() => {
    if (watchedCode === null) {
      return;
    }
    if (phase.kind === "showing") {
      if (
        statusData !== null &&
        statusData !== undefined &&
        statusData !== "gone" &&
        statusData.status === "claimed"
      ) {
        // Freeze rotation: the user must decide on THIS code's claimant.
        setPhase({ kind: "deciding", code: watchedCode });
      }
      return;
    }
    if (phase.kind === "deciding") {
      if (statusData === "gone") {
        // The claim window elapsed (or the record was consumed elsewhere);
        // fall back to a fresh QR.
        setPhase({ kind: "showing" });
        void code.refetch();
        return;
      }
      if (
        statusData !== null &&
        statusData !== undefined &&
        statusData.status === "denied"
      ) {
        setPhase({ kind: "showing" });
        void code.refetch();
      }
    }
  }, [phase, statusData, watchedCode, code]);

  const decide = (approve: boolean) => {
    if (phase.kind !== "deciding") {
      return;
    }
    const decidedCode = phase.code;
    respond.mutate(
      { code: decidedCode, approve },
      {
        onSuccess: (outcome) => {
          if (approve && (outcome === "ok" || outcome === "already-decided")) {
            setPhase({ kind: "approved" });
            return;
          }
          setPhase({ kind: "showing" });
          void code.refetch();
        },
        onError: () => {
          setPhase({ kind: "showing" });
          void code.refetch();
        },
      },
    );
  };

  const claimant =
    phase.kind === "deciding" &&
    statusData !== null &&
    statusData !== undefined &&
    statusData !== "gone" &&
    statusData.claimant !== null
      ? statusData.claimant
      : null;

  return (
    <SettingsPanelShell
      title="Link a phone"
      description="Sign the Traycer mobile app in by scanning a code from this device. Scanning alone signs nothing in — you approve each phone here before it gets access."
    >
      <div className="flex flex-col items-center gap-6 p-6">
        {!signedIn ? (
          <p className="text-ui-sm text-muted-foreground">
            Sign in on this device first — the phone takes over this account.
          </p>
        ) : phase.kind === "approved" ? (
          <div
            className="flex flex-col items-center gap-3"
            data-testid="link-phone-approved"
          >
            <Smartphone
              aria-hidden="true"
              className="text-muted-foreground"
            />
            <p className="text-ui-sm text-foreground">
              Approved — the phone is signing in now.
            </p>
            <Button
              variant="outline"
              data-testid="link-phone-restart"
              onClick={() => {
                setPhase({ kind: "showing" });
                void code.refetch();
              }}
            >
              Link another phone
            </Button>
          </div>
        ) : phase.kind === "deciding" ? (
          <div
            className="flex w-full max-w-md flex-col items-center gap-4"
            data-testid="link-phone-confirm"
          >
            <QrCode aria-hidden="true" className="text-muted-foreground" />
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-ui-sm font-medium text-foreground">
                Approve sign-in from{" "}
                {claimant === null ? "a device" : claimantDeviceLabel(claimant)}
                ?
              </p>
              <p
                className="text-ui-xs text-muted-foreground"
                data-testid="link-phone-claimant"
              >
                {claimant === null
                  ? "Someone scanned this code just now."
                  : [
                      claimant.address ?? "address unknown",
                      claimant.location ?? "location unknown",
                      "just now",
                    ].join(" · ")}
              </p>
              <p className="text-ui-xs text-muted-foreground">
                Details are approximate. Only approve if you scanned this code
                yourself.
              </p>
            </div>
            <div className="flex w-full items-center justify-center gap-3">
              <Button
                variant="default"
                disabled={respond.isPending}
                data-testid="link-phone-approve"
                onClick={() => {
                  decide(true);
                }}
              >
                Approve
                {respond.isPending ? (
                  <AgentSpinningDots
                    variant="dots"
                    className="ml-1.5"
                    testId={undefined}
                  />
                ) : null}
              </Button>
              <Button
                variant="outline"
                disabled={respond.isPending}
                data-testid="link-phone-reject"
                onClick={() => {
                  decide(false);
                }}
              >
                Reject
              </Button>
            </div>
          </div>
        ) : code.isPending ? (
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="aspect-square w-full max-w-64 rounded-lg" />
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          </div>
        ) : code.isError || code.data === null || code.data === undefined ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-ui-sm text-destructive">
              {code.error instanceof Error
                ? code.error.message
                : "Could not mint a link code."}
            </p>
            <Button
              variant="outline"
              disabled={code.isRefetching}
              onClick={() => {
                void code.refetch();
              }}
            >
              Try again
              {code.isRefetching ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
            </Button>
          </div>
        ) : (
          <>
            <LinkLoginQr code={code.data.code} />
            <div className="flex w-full max-w-md flex-col items-center gap-2">
              <p className="text-ui-sm text-muted-foreground">
                In the mobile app, choose{" "}
                <span className="font-medium text-foreground">
                  Scan QR code
                </span>{" "}
                — or type this code:
              </p>
              <code className="w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center font-mono text-ui-xs break-all select-all">
                {code.data.code}
              </code>
              <div className="flex flex-col items-center gap-0.5">
                <LinkCodeRotation
                  expiresAtEpochSeconds={code.data.expires_at}
                  expiresInSeconds={code.data.expires_in}
                />
                <p
                  className="text-ui-xs text-muted-foreground"
                  data-testid="link-phone-single-use-hint"
                >
                  Each code links one phone, expires in a minute, and needs
                  your approval here.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </SettingsPanelShell>
  );
}
