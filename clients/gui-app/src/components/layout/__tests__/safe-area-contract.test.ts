import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every `.ts`/`.tsx` file under `src/`, eagerly loaded as raw text so the
 * contracts below can grep production source without rendering it.
 */
const allSources = import.meta.glob<string>("../../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

function productionSourceEntries(): readonly (readonly [string, string])[] {
  return Object.entries(allSources).filter(
    ([filePath]) =>
      !filePath.includes("/__tests__/") &&
      !/\.test\.(ts|tsx)$/.test(filePath) &&
      !filePath.endsWith("routeTree.gen.ts"),
  );
}

function findSource(suffix: string): string {
  const entry = productionSourceEntries().find(([filePath]) =>
    filePath.endsWith(suffix),
  );
  if (entry === undefined) {
    throw new Error(`missing production source ending in "${suffix}"`);
  }
  return entry[1];
}

/**
 * Strips `//` and `/* *\/` comments so a prose mention of a class token (e.g.
 * "not `h-svh`, because...") cannot be mistaken for the token actually being
 * used. Good enough for this narrow scan: none of the files these contracts
 * touch embed a `//` inside a string on the same line as a class list.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * `sidebar.tsx` is a desktop-only shadcn primitive that predates the
 * safe-area token layer and is never rendered on the mobile shell that needs
 * it.
 */
const RAW_VIEWPORT_HEIGHT_ALLOWLIST = ["components/ui/sidebar.tsx"];

const RAW_VIEWPORT_HEIGHT_TOKENS = ["min-h-dvh", "h-dvh", "min-h-svh", "h-svh"];

/**
 * `w-screen` is `100vw`, which ignores the landscape sensor housing. A `fixed`
 * surface spanning the screen wants `w-safe-dvw`; an in-flow one wants
 * `w-full`, since `#root` has already narrowed the box it lives in.
 */
const RAW_VIEWPORT_WIDTH_TOKENS = ["w-screen"];

/**
 * The halfway marks a `fixed` surface must not centre on. It resolves against
 * the viewport, so `top-1/2` runs through the status-bar strip and `left-1/2`
 * ignores the landscape sensor housing - and the housing is on ONE side, so
 * the safe centre is displaced by half the difference between the two side
 * insets rather than sitting at the middle of a narrower box.
 */
const VIEWPORT_CENTRE_TOKENS = ["top-1/2", "left-1/2"];

/**
 * True when a single class string positions something `fixed` and centres it
 * on a viewport halfway mark.
 *
 * Matched per string literal rather than per file, so a class list that merely
 * mentions `fixed` somewhere else in the same component cannot pair with an
 * unrelated centring utility.
 */
function centresFixedOnTheViewport(source: string): boolean {
  const literals = stripComments(source).match(/"[^"\n]*"/g) ?? [];
  return literals.some(
    (literal) =>
      /(?<![\w-])fixed(?![\w-])/.test(literal) &&
      VIEWPORT_CENTRE_TOKENS.some((token) =>
        new RegExp(`(?<![\\w-])${token.replace("/", "\\/")}(?![\\w-])`).test(
          literal,
        ),
      ),
  );
}

/**
 * The portalled frames that centre themselves over the viewport. Each has to
 * carry its own width cap, because `#root`'s padding never reaches a `fixed`
 * element and CSS allows exactly one width clamp per element - so the cap is a
 * default a call site can displace, not a floor it cannot. That is what makes
 * it worth asserting: the guarantee is only ever one unmodified `max-w-*`
 * away from being gone, and nothing else would notice.
 */
const WIDTH_CAPPED_FIXED_FRAMES = [
  "components/ui/dialog.tsx",
  "components/ui/sheet.tsx",
  "components/ui/drawer.tsx",
  "components/layout/dialogs/promotable-modal-frame.tsx",
];

describe("safe-area token contract", () => {
  // No allowlist, deliberately: `index.css` is the one place the insets are
  // read from the platform, and it is not a TypeScript source. Comments are
  // stripped first so prose naming the thing a surface must not write - this
  // file's own failure message included - stays writable.
  it("keeps env(safe-area-inset-*) out of every source file", () => {
    const offenders = productionSourceEntries()
      .filter(([, source]) =>
        stripComments(source).includes("env(safe-area-inset"),
      )
      .map(([filePath]) => filePath);

    expect(
      offenders,
      "a surface should read #root's top-inset padding (in-flow) or one of the " +
        "index.css safe-area tokens instead of writing its own env(): " +
        "pb-safe-bottom / pb-safe-bottom-gutter for a bottom edge, " +
        "h-safe-dvh / min-h-safe-svh for a window-filling height, or " +
        "top-safe-center-y for a fixed, centred overlay",
    ).toEqual([]);
  });

  it("keeps h-dvh/min-h-dvh/h-svh/min-h-svh out of every .tsx file except the allowlisted desktop sidebar", () => {
    // Precise per the token, not a substring match: `(?<![\w-])` / `(?![\w-])`
    // exclude both "max-h-[85dvh]" (bracketed, arbitrary value) and
    // "h-safe-dvh" (a longer hyphenated token that happens to end the same
    // way) from tripping the bare-utility check.
    const offenders = productionSourceEntries()
      .filter(([filePath]) => filePath.endsWith(".tsx"))
      .filter(
        ([filePath]) =>
          !RAW_VIEWPORT_HEIGHT_ALLOWLIST.some((allowed) =>
            filePath.endsWith(allowed),
          ),
      )
      .filter(([, source]) => {
        const code = stripComments(source);
        return RAW_VIEWPORT_HEIGHT_TOKENS.some((token) =>
          new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(code),
        );
      })
      .map(([filePath]) => filePath);

    expect(
      offenders,
      "a window-filling surface must read from below the reserved status-bar " +
        "strip: use h-safe-dvh / min-h-safe-svh instead of the raw viewport unit",
    ).toEqual([]);
  });

  it("keeps w-screen out of every .tsx file, so nothing spans under the landscape sensor housing", () => {
    const offenders = productionSourceEntries()
      .filter(([filePath]) => filePath.endsWith(".tsx"))
      .filter(([, source]) => {
        const code = stripComments(source);
        return RAW_VIEWPORT_WIDTH_TOKENS.some((token) =>
          new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(code),
        );
      })
      .map(([filePath]) => filePath);

    expect(
      offenders,
      "w-screen is 100vw and ignores the horizontal insets: use w-safe-dvw for " +
        "a fixed surface that spans the screen, or w-full for an in-flow one",
    ).toEqual([]);
  });

  it("keeps fixed surfaces off the viewport centre lines, which run through the reserved strips", () => {
    const offenders = productionSourceEntries()
      .filter(([, source]) => centresFixedOnTheViewport(source))
      .map(([filePath]) => filePath);

    expect(
      offenders,
      "a fixed, centred surface should use top-safe-center-y / left-safe-center-x " +
        "instead of top-1/2 / left-1/2",
    ).toEqual([]);
  });

  it("keeps a width cap on every portalled frame that centres over the viewport", () => {
    const uncapped = WIDTH_CAPPED_FIXED_FRAMES.filter((suffix) => {
      const source = stripComments(findSource(suffix));
      return (
        !source.includes("max-w-safe-dvw") &&
        !source.includes("var(--safe-area-width)")
      );
    });

    expect(
      uncapped,
      "a fixed frame is sized against the viewport, so it needs max-w-safe-dvw " +
        "(or a min() against var(--safe-area-width)) to stay inside the safe region",
    ).toEqual([]);
  });
});

describe("safe-area token layer (index.css)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cssSource = readFileSync(join(here, "../../../index.css"), "utf8");

  it("declares the four inset custom properties from env(), each with a 0px fallback", () => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(cssSource).toMatch(
        new RegExp(
          `--safe-area-inset-${edge}:\\s*env\\(safe-area-inset-${edge},\\s*0px\\)`,
        ),
      );
    }
  });

  it("declares the safe region's width under its own name, not only as a theme token", () => {
    // The width is composed by hand-written CSS - a frame's cap is the smaller
    // of its own width and this - and `--safe-area-width` is the name that
    // composition should depend on. `--spacing-safe-dvw` is named for the
    // utility namespace it serves, so it is Tailwind's to rename.
    expect(cssSource).toMatch(
      /--safe-area-width:\s*calc\(\s*100dvw\s*-\s*var\(--safe-area-inset-left\)\s*-\s*var\(--safe-area-inset-right\)\s*\)/,
    );
  });

  it("declares every --spacing-safe-* theme token the app's utilities read", () => {
    const requiredTokens = [
      "--spacing-safe-top",
      "--spacing-safe-right",
      "--spacing-safe-bottom",
      "--spacing-safe-left",
      "--spacing-safe-top-gutter",
      "--spacing-safe-right-gutter",
      "--spacing-safe-bottom-gutter",
      "--spacing-safe-left-gutter",
      "--spacing-safe-dvh",
      "--spacing-safe-svh",
      "--spacing-safe-dvw",
      "--spacing-safe-center-x",
      "--spacing-safe-center-y",
    ];
    for (const token of requiredTokens) {
      expect(cssSource).toMatch(new RegExp(`${token}:`));
    }
  });

  it("gives #root the app-wide padding every in-flow surface inherits", () => {
    const rootRuleMatch = cssSource.match(/#root\s*\{([^}]*)\}/);
    expect(rootRuleMatch, "#root rule in index.css").not.toBeNull();
    const rootRule = rootRuleMatch?.[1] ?? "";
    // Both horizontal edges, not just one: the app supports either landscape
    // orientation, so the sensor housing can be on the left or the right.
    for (const edge of ["top", "right", "left"]) {
      expect(rootRule).toMatch(
        new RegExp(`padding-${edge}:\\s*var\\(--safe-area-inset-${edge}\\)`),
      );
    }
    // The bottom edge stays a per-surface decision, so reserving it here would
    // silently double every surface that already pads for the home indicator.
    expect(rootRule).not.toMatch(/padding-bottom/);
  });
});

describe("onboarding Skip-under-the-status-bar regression", () => {
  it("keeps StandaloneShell on h-safe-svh, not the raw h-svh that let it overhang the status bar", () => {
    const source = findSource("routes/root-route-components.tsx");
    const shellStart = source.indexOf("function StandaloneShell");
    expect(shellStart).toBeGreaterThanOrEqual(0);
    const shellBody = source.slice(shellStart);
    expect(shellBody).toMatch(/className="flex h-safe-svh flex-col"/);
    expect(stripComments(shellBody)).not.toMatch(/(?<![\w-])h-svh(?![\w-])/);
  });

  it("keeps onboarding-page.tsx free of its own safe-area code - it is safe by inheriting the shell, not by patching itself", () => {
    const source = stripComments(findSource("onboarding/onboarding-page.tsx"));
    expect(source).not.toMatch(/env\(safe-area-inset/);
    // Plain `\b`, not the `[\w-]` lookaround used for the bare-viewport-unit
    // check above: every real safe-area utility is a compound token
    // (`pb-safe-bottom`, `mt-safe-top`, `min-h-safe-svh`), so the boundary we
    // want sits on the hyphen that already precedes "safe", not around it.
    expect(source).not.toMatch(
      /\bsafe-(top|right|bottom|left|dvh|svh|center-y)\b/,
    );
  });
});

describe("mobile header no longer reaches under the status bar", () => {
  it("keeps mobile-app-header.tsx from adding its own top inset or bar-clearing height", () => {
    const source = findSource("layout/header/mobile-app-header.tsx");
    expect(source).not.toMatch(/pt-\[env\(/);
    expect(source).not.toMatch(/calc\(2\.5rem/);
  });
});
