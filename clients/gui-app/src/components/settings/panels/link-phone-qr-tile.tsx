import { useMemo, type ReactElement } from "react";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The branded QR tile for the link-a-phone code, drawn here rather than by a
 * QR-styling library. `qrcode` hands back the raw module matrix synchronously,
 * so the whole symbol is plain SVG: it renders identically under jsdom (a test
 * can compare every drawn module against the encoder's matrix), it takes the
 * brand mark as the inline SVG the app already has instead of loading an image
 * the test environment can never resolve, and it costs no dependency.
 */

/** The spec's minimum silent margin; scanners rely on it to find the symbol. */
const QUIET_ZONE_MODULES = 4;
/** Finder patterns are 7x7 modules at three corners, drawn as styled eyes. */
const FINDER_SIZE_MODULES = 7;
/** Gap between adjacent modules, in module units, that gives the dot look. */
const MODULE_INSET = 0.04;
const MODULE_RADIUS = 0.32;

/**
 * A QR scans by luminance contrast, not by palette, so the symbol keeps a
 * fixed near-black on white in both app themes and the tile stays light in
 * dark mode. These are deliberately not theme tokens.
 */
const QR_INK = "#0B0B0F";
const QR_PAPER = "#FFFFFF";

interface QrSymbol {
  readonly size: number;
  /** Row-major module bits, `size * size` of them. */
  readonly bits: readonly boolean[];
  readonly version: number;
}

/**
 * Encodes the panel's public code as the v1 deep-link payload. Returns null
 * when the encoder refuses the input — the caller shows the loading tile
 * rather than a broken symbol.
 */
function encodeQrSymbol(code: string): QrSymbol | null {
  try {
    const qr = QRCode.create(buildLinkLoginQrPayload(code), {
      // Level H because the centred brand mark covers live modules.
      errorCorrectionLevel: "H",
    });
    const size = qr.modules.size;
    const bits: boolean[] = [];
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        bits.push(qr.modules.get(row, col) === 1);
      }
    }
    return { size, bits, version: qr.version };
  } catch {
    return null;
  }
}

/** The three finder corners own their modules; the dot pass skips them. */
function isFinderModule(row: number, col: number, size: number): boolean {
  const nearTop = row < FINDER_SIZE_MODULES;
  const nearBottom = row >= size - FINDER_SIZE_MODULES;
  const nearLeft = col < FINDER_SIZE_MODULES;
  const nearRight = col >= size - FINDER_SIZE_MODULES;
  return (
    (nearTop && nearLeft) || (nearTop && nearRight) || (nearBottom && nearLeft)
  );
}

function FinderEye(props: { readonly row: number; readonly col: number }) {
  const x = props.col + QUIET_ZONE_MODULES;
  const y = props.row + QUIET_ZONE_MODULES;
  return (
    <g>
      <rect x={x} y={y} width={7} height={7} rx={2.2} fill={QR_INK} />
      <rect x={x + 1} y={y + 1} width={5} height={5} rx={1.5} fill={QR_PAPER} />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={1} fill={QR_INK} />
    </g>
  );
}

function QrSymbolSvg(props: { readonly symbol: QrSymbol }) {
  const { size, bits } = props.symbol;
  const extent = size + QUIET_ZONE_MODULES * 2;
  const modules: ReactElement[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!bits[row * size + col] || isFinderModule(row, col, size)) {
        continue;
      }
      modules.push(
        <rect
          key={`${row}-${col}`}
          x={col + QUIET_ZONE_MODULES + MODULE_INSET}
          y={row + QUIET_ZONE_MODULES + MODULE_INSET}
          width={1 - MODULE_INSET * 2}
          height={1 - MODULE_INSET * 2}
          rx={MODULE_RADIUS}
          fill={QR_INK}
        />,
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="Link-a-phone QR code"
      data-testid="link-phone-qr"
      data-qr-version={props.symbol.version}
      data-qr-error-correction="H"
      data-qr-quiet-zone={QUIET_ZONE_MODULES}
    >
      <rect width={extent} height={extent} fill={QR_PAPER} />
      <g data-testid="link-phone-qr-modules">{modules}</g>
      <FinderEye row={0} col={0} />
      <FinderEye row={0} col={size - FINDER_SIZE_MODULES} />
      <FinderEye row={size - FINDER_SIZE_MODULES} col={0} />
    </svg>
  );
}

/**
 * The code's life drawn on the tile's own frame: the stroke drains clockwise
 * as the seconds run out, so the thing that is expiring is the thing that
 * shows it. `pathLength` normalises the perimeter to 1, which makes the
 * remaining share the dash offset directly.
 */
function ExpiryFrame(props: { readonly remainingFraction: number }) {
  const remaining = Math.min(1, Math.max(0, props.remainingFraction));
  return (
    <svg
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <rect
        x={1.4}
        y={1.4}
        width={97.2}
        height={97.2}
        rx={4}
        pathLength={1}
        strokeWidth={2.8}
        className="fill-none stroke-border"
      />
      <rect
        x={1.4}
        y={1.4}
        width={97.2}
        height={97.2}
        rx={4}
        pathLength={1}
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeDasharray={1}
        strokeDashoffset={1 - remaining}
        data-testid="link-phone-expiry-frame"
        data-remaining-fraction={remaining.toFixed(2)}
        // Linear over one tick so the drain reads as continuous between the
        // clock's whole seconds.
        className="fill-none stroke-primary transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
      />
    </svg>
  );
}

export function LinkPhoneQrTile(props: {
  readonly code: string;
  /** Share of the displayed code's life still left, 0..1. */
  readonly remainingFraction: number;
}) {
  const symbol = useMemo(() => encodeQrSymbol(props.code), [props.code]);
  if (symbol === null) {
    return <Skeleton className="aspect-square w-full max-w-64 rounded-xl" />;
  }
  return (
    <div
      className="relative aspect-square w-full max-w-64"
      data-testid="link-phone-qr-tile"
    >
      <div
        // Keyed on the code so a rotation mounts a fresh tile and fades it in
        // instead of swapping the matrix under the user.
        key={props.code}
        className={cn(
          "absolute inset-0 overflow-hidden rounded-xl bg-white",
          "animate-in fade-in-0 duration-500 motion-reduce:animate-none",
        )}
        data-testid="link-phone-qr-surface"
      >
        <QrSymbolSvg symbol={symbol} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            aria-hidden="true"
            // 22% of the tile's width: the covered area sits well inside level
            // H's recovery budget, and the ink matches the symbol's own.
            className="flex aspect-square w-[22%] items-center justify-center rounded-[28%] bg-[#0B0B0F]"
          >
            <BrandMark className="h-auto w-[56%]" />
          </div>
        </div>
      </div>
      <ExpiryFrame remainingFraction={props.remainingFraction} />
    </div>
  );
}
