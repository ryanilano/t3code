import type { ProjectIconColor } from "@t3tools/contracts";
import { msg } from "gt-react";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
}> = [
  {
    value: "gray",
    label: msg("Gray", { $context: "colour name, project icon colour" }),
    className: "text-gray-800 dark:text-gray-300",
    swatchClassName: "bg-gray-500",
  },
  {
    value: "red",
    label: msg("Red", { $context: "colour name, project icon colour" }),
    className: "text-red-800 dark:text-red-300",
    swatchClassName: "bg-red-500",
  },
  {
    value: "orange",
    label: msg("Orange", { $context: "colour name, project icon colour" }),
    className: "text-orange-800 dark:text-orange-300",
    swatchClassName: "bg-orange-500",
  },
  {
    value: "amber",
    label: msg("Amber", { $context: "colour name, project icon colour" }),
    className: "text-amber-800 dark:text-amber-300",
    swatchClassName: "bg-amber-500",
  },
  {
    value: "yellow",
    label: msg("Yellow", { $context: "colour name, project icon colour" }),
    className: "text-yellow-800 dark:text-yellow-300",
    swatchClassName: "bg-yellow-500",
  },
  {
    value: "lime",
    label: msg("Lime", { $context: "colour name, project icon colour" }),
    className: "text-lime-800 dark:text-lime-300",
    swatchClassName: "bg-lime-500",
  },
  {
    value: "green",
    label: msg("Green", { $context: "colour name, project icon colour" }),
    className: "text-green-800 dark:text-green-300",
    swatchClassName: "bg-green-500",
  },
  {
    value: "emerald",
    label: msg("Emerald", { $context: "colour name, project icon colour" }),
    className: "text-emerald-800 dark:text-emerald-300",
    swatchClassName: "bg-emerald-500",
  },
  {
    value: "teal",
    label: msg("Teal", { $context: "colour name, project icon colour" }),
    className: "text-teal-800 dark:text-teal-300",
    swatchClassName: "bg-teal-500",
  },
  {
    value: "cyan",
    label: msg("Cyan", { $context: "colour name, project icon colour" }),
    className: "text-cyan-800 dark:text-cyan-300",
    swatchClassName: "bg-cyan-500",
  },
  {
    value: "sky",
    label: msg("Sky", { $context: "colour name, project icon colour" }),
    className: "text-sky-800 dark:text-sky-300",
    swatchClassName: "bg-sky-500",
  },
  {
    value: "blue",
    label: msg("Blue", { $context: "colour name, project icon colour" }),
    className: "text-blue-800 dark:text-blue-300",
    swatchClassName: "bg-blue-500",
  },
  {
    value: "indigo",
    label: msg("Indigo", { $context: "colour name, project icon colour" }),
    className: "text-indigo-800 dark:text-indigo-300",
    swatchClassName: "bg-indigo-500",
  },
  {
    value: "violet",
    label: msg("Violet", { $context: "colour name, project icon colour" }),
    className: "text-violet-800 dark:text-violet-300",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "purple",
    label: msg("Purple", { $context: "colour name, project icon colour" }),
    className: "text-purple-800 dark:text-purple-300",
    swatchClassName: "bg-purple-500",
  },
  {
    value: "fuchsia",
    label: msg("Fuchsia", { $context: "colour name, project icon colour" }),
    className: "text-fuchsia-800 dark:text-fuchsia-300",
    swatchClassName: "bg-fuchsia-500",
  },
  {
    value: "pink",
    label: msg("Pink", { $context: "colour name, project icon colour" }),
    className: "text-pink-800 dark:text-pink-300",
    swatchClassName: "bg-pink-500",
  },
  {
    value: "rose",
    label: msg("Rose", { $context: "colour name, project icon colour" }),
    className: "text-rose-800 dark:text-rose-300",
    swatchClassName: "bg-rose-500",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
