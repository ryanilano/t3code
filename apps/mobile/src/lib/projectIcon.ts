import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ProjectIconColor, type ProjectIconOverride } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import type { AppSymbolName } from "../components/ui/AppSymbol";

export type ProjectIconGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor };

/** Hermes lacks Intl.Segmenter; fold combining marks into base characters instead. */
export function countGlyphs(text: string): number {
  return Array.from(text.replace(/\p{M}/gu, "")).length;
}

function projectMonogram(projectName: string): string {
  const words =
    projectName
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectMonogramColor(projectName: string): ProjectIconColor {
  const seed = projectName.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % ProjectIconColor.literals.length;
  }
  return ProjectIconColor.literals[index] ?? "blue";
}

export function projectAutoMonogram(projectTitle: string): ProjectIconGlyph | null {
  if (!projectTitle.trim()) return null;
  return {
    kind: "monogram",
    text: projectMonogram(projectTitle),
    color: projectMonogramColor(projectTitle),
  };
}

export function resolveProjectIconGlyph(
  projectIcon: ProjectIconOverride | null | undefined,
  projectTitle: string,
): ProjectIconGlyph | null {
  switch (projectIcon?.kind) {
    case "emoji":
      return { kind: "emoji", emoji: projectIcon.emoji };
    case "monogram":
      return { kind: "monogram", text: projectIcon.text, color: projectIcon.color };
    case "lucide":
      return { kind: "monogram", text: projectMonogram(projectTitle), color: projectIcon.color };
    case undefined:
      return null;
  }
}

const SYMBOL_BY_LUCIDE_NAME: Partial<Record<string, AppSymbolName>> = {
  "message-square-dashed": "text.bubble",
};

export function resolveProjectIconSymbol(
  projectIcon: ProjectIconOverride | null | undefined,
): { readonly name: AppSymbolName; readonly color: ProjectIconColor } | null {
  if (projectIcon?.kind !== "lucide") return null;
  const name = SYMBOL_BY_LUCIDE_NAME[projectIcon.name];
  return name ? { name, color: projectIcon.color } : null;
}

export type ProjectChipIcon = { readonly kind: "favicon"; readonly uri: string } | ProjectIconGlyph;

export function resolveProjectChipIcon(
  project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly projectIcon?: ProjectIconOverride | null;
  } | null,
  scratchWorkspaceRoot: string | null | undefined,
  faviconUrl: () => string | null,
): ProjectChipIcon | null {
  if (!project || isScratchProject(project, scratchWorkspaceRoot)) return null;
  const glyph = resolveProjectIconGlyph(project.projectIcon, project.title);
  if (glyph) return glyph;
  const url = faviconUrl();
  if (url && !isProjectFaviconFallbackUrl(url)) return { kind: "favicon", uri: url };
  return projectAutoMonogram(project.title);
}

export type ProjectIconAppearance = "light" | "dark";

type ProjectIconInk = { readonly text: string; readonly tint: string };

// The letter needs 4.5:1 on its tile over tinted rows and bubbles in every theme, so it is darkest
// on light surfaces and lightest on dark ones. Uniwind's `dark:` only matches the theme named
// "dark", hence the appearance argument. Class names stay literal so Tailwind generates them.
const PROJECT_ICON_COLOR_CLASSES: Record<
  ProjectIconColor,
  {
    readonly light: ProjectIconInk;
    readonly dark: ProjectIconInk;
    readonly background: string;
  }
> = {
  gray: {
    light: { text: "text-gray-900", tint: "accent-gray-900" },
    dark: { text: "text-gray-100", tint: "accent-gray-100" },
    background: "bg-gray-500/15",
  },
  red: {
    light: { text: "text-red-900", tint: "accent-red-900" },
    dark: { text: "text-red-100", tint: "accent-red-100" },
    background: "bg-red-500/15",
  },
  orange: {
    light: { text: "text-orange-900", tint: "accent-orange-900" },
    dark: { text: "text-orange-100", tint: "accent-orange-100" },
    background: "bg-orange-500/15",
  },
  amber: {
    light: { text: "text-amber-900", tint: "accent-amber-900" },
    dark: { text: "text-amber-100", tint: "accent-amber-100" },
    background: "bg-amber-500/15",
  },
  yellow: {
    light: { text: "text-yellow-900", tint: "accent-yellow-900" },
    dark: { text: "text-yellow-100", tint: "accent-yellow-100" },
    background: "bg-yellow-500/15",
  },
  lime: {
    light: { text: "text-lime-900", tint: "accent-lime-900" },
    dark: { text: "text-lime-100", tint: "accent-lime-100" },
    background: "bg-lime-500/15",
  },
  green: {
    light: { text: "text-green-900", tint: "accent-green-900" },
    dark: { text: "text-green-100", tint: "accent-green-100" },
    background: "bg-green-500/15",
  },
  emerald: {
    light: { text: "text-emerald-900", tint: "accent-emerald-900" },
    dark: { text: "text-emerald-100", tint: "accent-emerald-100" },
    background: "bg-emerald-500/15",
  },
  teal: {
    light: { text: "text-teal-900", tint: "accent-teal-900" },
    dark: { text: "text-teal-100", tint: "accent-teal-100" },
    background: "bg-teal-500/15",
  },
  cyan: {
    light: { text: "text-cyan-900", tint: "accent-cyan-900" },
    dark: { text: "text-cyan-100", tint: "accent-cyan-100" },
    background: "bg-cyan-500/15",
  },
  sky: {
    light: { text: "text-sky-900", tint: "accent-sky-900" },
    dark: { text: "text-sky-100", tint: "accent-sky-100" },
    background: "bg-sky-500/15",
  },
  blue: {
    light: { text: "text-blue-900", tint: "accent-blue-900" },
    dark: { text: "text-blue-100", tint: "accent-blue-100" },
    background: "bg-blue-500/15",
  },
  indigo: {
    light: { text: "text-indigo-900", tint: "accent-indigo-900" },
    dark: { text: "text-indigo-100", tint: "accent-indigo-100" },
    background: "bg-indigo-500/15",
  },
  violet: {
    light: { text: "text-violet-900", tint: "accent-violet-900" },
    dark: { text: "text-violet-100", tint: "accent-violet-100" },
    background: "bg-violet-500/15",
  },
  purple: {
    light: { text: "text-purple-900", tint: "accent-purple-900" },
    dark: { text: "text-purple-100", tint: "accent-purple-100" },
    background: "bg-purple-500/15",
  },
  fuchsia: {
    light: { text: "text-fuchsia-900", tint: "accent-fuchsia-900" },
    dark: { text: "text-fuchsia-100", tint: "accent-fuchsia-100" },
    background: "bg-fuchsia-500/15",
  },
  pink: {
    light: { text: "text-pink-900", tint: "accent-pink-900" },
    dark: { text: "text-pink-100", tint: "accent-pink-100" },
    background: "bg-pink-500/15",
  },
  rose: {
    light: { text: "text-rose-900", tint: "accent-rose-900" },
    dark: { text: "text-rose-100", tint: "accent-rose-100" },
    background: "bg-rose-500/15",
  },
};

export function projectIconColorClassNames(
  color: ProjectIconColor,
  appearance: ProjectIconAppearance,
) {
  const classes = PROJECT_ICON_COLOR_CLASSES[color];
  return { ...classes[appearance], background: classes.background };
}
