import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthLinkLoginCode } from "@/hooks/auth/use-link-login-code-query";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Renders the current one-time code as a QR. The data URL is derived state
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
 * Settings → Link a phone. Mints a one-time link-login code, renders it as a
 * QR (plus the raw code for manual entry), and re-mints on an interval while
 * the panel stays open — the code TTL is 60s, so an abandoned screenshot of
 * this panel goes dead within a minute.
 */
export function LinkPhonePanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const code = useAuthLinkLoginCode();

  return (
    <SettingsPanelShell
      title="Link a phone"
      description="Sign the Traycer mobile app in by scanning a code from this device. Codes are single-use and expire after a minute; a fresh one is minted automatically while this panel is open."
    >
      <div className="flex flex-col items-center gap-6 p-6">
        {!signedIn ? (
          <p className="text-ui-sm text-muted-foreground">
            Sign in on this device first — the phone takes over this account.
          </p>
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
              {code.isRefetching ? <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              /> : null}
            </Button>
          </div>
        ) : (
          <>
            <LinkLoginQr code={code.data.code} />
            <div className="flex w-full max-w-md flex-col items-center gap-2">
              <p className="text-ui-sm text-muted-foreground">
                In the mobile app, choose{" "}
                <span className="font-medium text-foreground">
                  Scan from desktop
                </span>{" "}
                — or type this code:
              </p>
              <code className="w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center font-mono text-ui-xs break-all select-all">
                {code.data.code}
              </code>
            </div>
          </>
        )}
      </div>
    </SettingsPanelShell>
  );
}
