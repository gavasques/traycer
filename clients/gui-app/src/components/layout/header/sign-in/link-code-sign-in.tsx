import { useState } from "react";
import { QrCode } from "lucide-react";
import { parseLinkLoginInput } from "@traycer-clients/shared/auth/link-login";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLinkCodeSignInMutation } from "@/hooks/auth/use-link-code-sign-in-mutation";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

type EntryNotice =
  | "not-a-code"
  | "invalid-code"
  | "rate-limited"
  | "network-error"
  | "failed"
  | "camera-denied"
  | "scan-error"
  | null;

function noticeCopy(notice: Exclude<EntryNotice, null>): string {
  switch (notice) {
    case "not-a-code":
      return "That doesn't look like a link code. Scan the QR, or copy the code shown under it.";
    case "invalid-code":
      return "That code is invalid, expired, or already used. Mint a fresh one on the desktop and try again.";
    case "rate-limited":
      return "Too many attempts from this network. Wait a minute and try again.";
    case "network-error":
      return "Couldn't reach the sign-in service. Check that this phone can reach the desktop's network.";
    case "failed":
      return "Sign-in didn't complete. Try again with a fresh code.";
    case "camera-denied":
      return "Camera access is off — enter the code manually, or allow camera access in Settings.";
    case "scan-error":
      return "The camera couldn't be started — enter the code manually.";
  }
}

/**
 * "Scan from desktop" sign-in: redeems a one-time link code minted by the
 * desktop's Settings → Link a phone panel. The camera is a capability
 * (`runnerHost.linkCodeScanner`), not an assumption — where it is absent
 * (browser dev shell, simulator) or denied, the typed-code field IS the flow,
 * so every failure lands as an inline notice above a still-usable field.
 */
export function LinkCodeSignIn(props: { readonly isHero: boolean }) {
  const runnerHost = useRunnerHostOrNull();
  const redeem = useLinkCodeSignInMutation();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState("");
  const [notice, setNotice] = useState<EntryNotice>(null);
  const scanner = runnerHost === null ? null : runnerHost.linkCodeScanner;

  const submit = (raw: string) => {
    const code = parseLinkLoginInput(raw);
    if (code === null) {
      setNotice("not-a-code");
      return;
    }
    setNotice(null);
    redeem.mutate(code, {
      onSuccess: (result) => {
        if (result.kind !== "signed-in") {
          setNotice(result.kind);
        }
      },
      onError: () => {
        setNotice("failed");
      },
    });
  };

  if (!open) {
    return (
      <Button
        type="button"
        size={props.isHero ? "default" : "sm"}
        variant="link"
        data-testid="link-code-signin-open"
        onClick={() => {
          setOpen(true);
        }}
        className={cn(
          props.isHero ? "h-auto justify-center px-0 py-0 text-ui-sm" : null,
        )}
      >
        <QrCode aria-hidden="true" />
        Scan from desktop
      </Button>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="link-code-signin-panel"
    >
      <p className="text-center text-ui-sm opacity-80">
        On your desktop, open Settings → Link a phone, then scan the QR — or
        type the code shown under it.
      </p>
      {scanner !== null ? (
        <Button
          type="button"
          size={props.isHero ? "lg" : "sm"}
          variant={props.isHero ? "default" : "outline"}
          disabled={redeem.isPending}
          data-testid="link-code-signin-scan"
          onClick={() => {
            void scanner.scan().then((result) => {
              switch (result.kind) {
                case "scanned":
                  submit(result.text);
                  return;
                case "permission-denied":
                  setNotice("camera-denied");
                  return;
                case "canceled":
                  return;
                case "error":
                  setNotice("scan-error");
              }
            });
          }}
        >
          Open camera
        </Button>
      ) : null}
      <form
        className="flex w-full items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(entry);
        }}
      >
        <Input
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value);
            setNotice(null);
          }}
          placeholder="Paste or type the code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid="link-code-signin-input"
          className="flex-1 font-mono text-ui-sm"
        />
        <Button
          type="submit"
          size={props.isHero ? "default" : "sm"}
          variant="outline"
          disabled={redeem.isPending || entry.trim().length === 0}
          data-testid="link-code-signin-submit"
        >
          Sign in
          {redeem.isPending ? (
            <AgentSpinningDots
              variant="dots"
              className="ml-1.5"
              testId={undefined}
            />
          ) : null}
        </Button>
      </form>
      {notice !== null ? (
        <p
          className="text-center text-ui-sm text-destructive"
          data-testid="link-code-signin-notice"
        >
          {noticeCopy(notice)}
        </p>
      ) : null}
    </div>
  );
}
