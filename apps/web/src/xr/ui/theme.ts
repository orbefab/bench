import type { Appearance } from "@/lib/appearance";
import { useXrUi } from "@/state/xr";

export type XrPalette = {
  card: string;
  border: string;
  text: string;
  subtle: string;
  muted: string;
  hover: string;
  divider: string;
  active: string;
  pressed: string;
  selected: string;
  selectedHover: string;
  selectedActive: string;
  tooltipBg: string;
  tooltipFg: string;
  studio: string;
  gridMajor: number;
  gridMinor: number;
  handleIdle: string;
  bubble: string;
  code: string;
  danger: string;
  link: string;
};

export const XR_PALETTE: Record<Appearance, XrPalette> = {
  light: {
    card: "#fafafa",
    border: "#e4e4e7",
    text: "#18181b",
    subtle: "#71717a",
    muted: "#f4f4f5",
    hover: "#e4e4e7",
    divider: "#d4d4d8",
    active: "#dbeafe",
    pressed: "#bfdbfe",
    selected: "#93c5fd",
    selectedHover: "#60a5fa",
    selectedActive: "#3b82f6",
    tooltipBg: "#18181b",
    tooltipFg: "#fafafa",
    studio: "#eeeff1",
    gridMajor: 0xc9cdd3,
    gridMinor: 0xe2e4e8,
    handleIdle: "#d4d4d8",
    bubble: "#e4e4e7",
    code: "#e4e4e7",
    danger: "#dc2626",
    link: "#2563eb",
  },
  dark: {
    card: "#27272a",
    border: "#3f3f46",
    text: "#fafafa",
    subtle: "#a1a1aa",
    muted: "#3f3f46",
    hover: "#52525b",
    divider: "#3f3f46",
    active: "#1e3a5f",
    pressed: "#1e40af",
    selected: "#1d4ed8",
    selectedHover: "#2563eb",
    selectedActive: "#3b82f6",
    tooltipBg: "#fafafa",
    tooltipFg: "#18181b",
    studio: "#1a1d21",
    gridMajor: 0x4b5158,
    gridMinor: 0x2c3036,
    handleIdle: "#3f3f46",
    bubble: "#3f3f46",
    code: "#3f3f46",
    danger: "#f87171",
    link: "#60a5fa",
  },
};

/** uikit and the studio floor live inside the R3F tree, so they read the zustand mirror. */
export function useXrTheme(): XrPalette {
  const appearance = useXrUi((s) => s.appearance);
  return XR_PALETTE[appearance];
}
