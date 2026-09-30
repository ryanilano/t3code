// TypeScript (run with Node's built-in type stripping):
//   node scripts/theme-input-contrast.ts          print the contrast table
//   node scripts/theme-input-contrast.ts --solve  also print the smallest
//                                                 lightness change that
//                                                 reaches 3:1
//
// Checks WCAG 2.2 success criterion 1.4.11 (non-text contrast) for the
// text-field border token `input`: the border is what shows where a field is,
// so it needs 3:1 against the surfaces fields sit on. Those are the page
// (`canvas`, painted as --background) and the sidebar (`sidebar`).
//
// Every built-in palette is checked in both appearances, plus the standard
// T3 Code light and dark palettes that the mobile app and theme drafts use.

import {
  BUILT_IN_THEMES,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  getThemeColorsForAppearance,
  type ThemeAppearance,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";

const TARGET_RATIO = 3;

type Rgb = { r: number; g: number; b: number }; // 0..255 per channel
type Oklch = { L: number; C: number; h: number };

// --- Color conversion -------------------------------------------------------
// Same OKLab matrices as packages/shared/src/themePreview.ts and
// apps/web/src/themePalette.ts, so the numbers agree with the app's own math.

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  // Browsers paint 8-bit channels, so round and clamp like the screen does.
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function oklchToRgb({ L, C, h }: Oklch): Rgb {
  const hue = (h * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function rgbToOklch(color: Rgb): Oklch {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    C: Math.hypot(labA, labB),
    h: ((Math.atan2(labB, labA) * 180) / Math.PI + 360) % 360,
  };
}

/** Palettes store either `oklch(L C H)` or `#rrggbb`. */
function parseColor(value: string): { kind: "oklch" | "hex"; oklch: Oklch } {
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(value);
  if (oklch) {
    return {
      kind: "oklch",
      oklch: { L: Number(oklch[1]), C: Number(oklch[2]), h: Number(oklch[3]) },
    };
  }
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (hex) {
    const rgb = {
      r: Number.parseInt(hex[1]!, 16),
      g: Number.parseInt(hex[2]!, 16),
      b: Number.parseInt(hex[3]!, 16),
    };
    return { kind: "hex", oklch: rgbToOklch(rgb) };
  }
  throw new Error(`Unsupported color literal: ${value}`);
}

function toRgb(value: string): Rgb {
  const parsed = parseColor(value);
  // Hex values are already sRGB; skip the round trip so they stay exact.
  if (parsed.kind === "hex") {
    const hex = /^#(..)(..)(..)$/.exec(value)!;
    return {
      r: Number.parseInt(hex[1]!, 16),
      g: Number.parseInt(hex[2]!, 16),
      b: Number.parseInt(hex[3]!, 16),
    };
  }
  return oklchToRgb(parsed.oklch);
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// --- WCAG contrast ----------------------------------------------------------

/** WCAG 2.2 relative luminance. */
function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b)
  );
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// --- Solving ----------------------------------------------------------------

type Row = {
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
};

function rowsToCheck(): Row[] {
  const rows: Row[] = [
    { name: "T3 Code (default)", appearance: "light", colors: T3_CODE_LIGHT_THEME_COLORS },
    { name: "T3 Code (default)", appearance: "dark", colors: T3_CODE_DARK_THEME_COLORS },
  ];
  for (const theme of BUILT_IN_THEMES) {
    for (const appearance of ["light", "dark"] as const) {
      const colors = getThemeColorsForAppearance(theme, appearance);
      if (colors) rows.push({ name: theme.label, appearance, colors });
    }
  }
  return rows;
}

function ratios(input: string, colors: ThemeColors) {
  const inputRgb = toRgb(input);
  return {
    background: contrastRatio(inputRgb, toRgb(colors.canvas)),
    sidebar: contrastRatio(inputRgb, toRgb(colors.sidebar)),
  };
}

/**
 * Move `input` in OKLCH lightness only (hue and chroma stay) until it clears
 * the target against both surfaces. Light palettes darken, dark palettes
 * lighten, matching the direction each palette already uses. Steps of 0.001
 * in L are the "sensible rounding": three decimals is enough precision to be
 * reviewable and small enough to land close to the threshold.
 */
function solveInput(row: Row): { value: string; deltaL: number } | null {
  const current = ratios(row.colors.input, row.colors);
  if (current.background >= TARGET_RATIO && current.sidebar >= TARGET_RATIO) return null;

  const parsed = parseColor(row.colors.input);
  const direction = row.appearance === "dark" ? 1 : -1;
  // Start from the stored lightness rounded to the 0.001 grid.
  const startL = Math.round(parsed.oklch.L * 1000) / 1000;
  for (let step = 1; step <= 1000; step += 1) {
    const L = Math.round((startL + direction * step * 0.001) * 1000) / 1000;
    const candidateOklch = { ...parsed.oklch, L };
    // Hex palettes stay hex so the file keeps its own notation.
    const candidate =
      parsed.kind === "hex"
        ? rgbToHex(oklchToRgb(candidateOklch))
        : `oklch(${L.toFixed(3)} ${row.colors.input.split(/\s+/)[1]} ${row.colors.input
            .split(/\s+/)[2]!
            .replace(")", "")})`;
    const next = ratios(candidate, row.colors);
    if (next.background >= TARGET_RATIO && next.sidebar >= TARGET_RATIO) {
      return { value: candidate, deltaL: L - parsed.oklch.L };
    }
  }
  throw new Error(`No lightness reaches ${TARGET_RATIO}:1 for ${row.name} ${row.appearance}`);
}

// --- Output -----------------------------------------------------------------

const solve = process.argv.includes("--solve");
const lines = [
  solve
    ? "| Theme | Appearance | input | vs background | vs sidebar | proposed input | vs background | vs sidebar | delta L |"
    : "| Theme | Appearance | input | vs background | vs sidebar |",
  solve ? "|---|---|---|---|---|---|---|---|---|" : "|---|---|---|---|---|",
];
for (const row of rowsToCheck()) {
  const now = ratios(row.colors.input, row.colors);
  const cells = [
    row.name,
    row.appearance,
    `\`${row.colors.input}\``,
    now.background.toFixed(2),
    now.sidebar.toFixed(2),
  ];
  if (solve) {
    const fix = solveInput(row);
    if (fix) {
      const next = ratios(fix.value, row.colors);
      cells.push(
        `\`${fix.value}\``,
        next.background.toFixed(2),
        next.sidebar.toFixed(2),
        (fix.deltaL >= 0 ? "+" : "") + fix.deltaL.toFixed(3),
      );
    } else {
      cells.push("unchanged", "", "", "");
    }
  }
  lines.push(`| ${cells.join(" | ")} |`);
}
// Plain stdout: this is a one-shot report, not an Effect program.
process.stdout.write(`${lines.join("\n")}\n`);
