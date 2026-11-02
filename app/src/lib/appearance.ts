// The app's theme: light, sepia, dark, or whatever the device uses. One
// choice colours everything, from the home page to the reader's panels and
// the pages themselves. It syncs across devices, and a copy on the device
// applies it before the first paint.

import { useEffect, useState } from "react";
import { setSetting, useSetting } from "./settings";

export type Appearance = "light" | "sepia" | "dark" | "system";
export type Theme = "light" | "sepia" | "dark";
export type Accent = "oxford" | "sage" | "amber" | "burgundy" | "slate";

export const ACCENTS: { value: Accent; label: string; lightHex: string; darkHex: string }[] = [
  { value: "oxford", label: "Oxford Navy", lightHex: "#185FA5", darkHex: "#6FA8DC" },
  { value: "sage", label: "Sage Green", lightHex: "#2D6A4F", darkHex: "#52B788" },
  { value: "amber", label: "Warm Amber", lightHex: "#9A5B13", darkHex: "#F59E0B" },
  { value: "burgundy", label: "Burgundy", lightHex: "#8E2035", darkHex: "#F47291" },
  { value: "slate", label: "Slate", lightHex: "#334155", darkHex: "#94A3B8" },
];

const KEY = "appearance";
const KEY_ACCENT = "accent";
const listeners = new Set<() => void>();
const accentListeners = new Set<() => void>();
const BAR: Record<Theme, string> = { light: "#FCFCFB", sepia: "#FFF1E5", dark: "#16191D" };

// Light is the default. Sepia, dark or following the device are choices.
export function storedAppearance(): Appearance {
  const value = localStorage.getItem(KEY);
  return value === "dark" || value === "sepia" || value === "system" ? value : "light";
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

export function resolved(value: Appearance = storedAppearance()): Theme {
  return value === "system" ? (systemDark() ? "dark" : "light") : value;
}

export function applyAppearance(value: Appearance): void {
  const theme = resolved(value);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  localStorage.setItem(KEY, value);
  // The phone's own browser bar takes the same colour.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
  listeners.forEach((l) => l());
}

// Following the device means changing when the device does.
if (typeof window !== "undefined") {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedAppearance() === "system") applyAppearance("system");
  });
}

export async function chooseAppearance(value: Appearance): Promise<void> {
  applyAppearance(value);
  await setSetting(KEY, value);
}

export function storedAccent(): Accent {
  if (typeof window === "undefined") return "oxford";
  const value = localStorage.getItem(KEY_ACCENT);
  return value === "sage" || value === "amber" || value === "burgundy" || value === "slate" ? value : "oxford";
}

export function applyAccent(value: Accent): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.accent = value;
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY_ACCENT, value);
  accentListeners.forEach((l) => l());
}

export async function chooseAccent(value: Accent): Promise<void> {
  applyAccent(value);
  await setSetting(KEY_ACCENT, value);
}

export function useAccentSync(): void {
  const synced = useSetting<Accent | null>(KEY_ACCENT, null);
  useEffect(() => {
    if (synced && synced !== storedAccent()) applyAccent(synced);
  }, [synced]);
}

export function useAccent(): Accent {
  const [value, setValue] = useState(storedAccent);
  useEffect(() => {
    const update = () => setValue(storedAccent());
    accentListeners.add(update);
    return () => { accentListeners.delete(update); };
  }, []);
  return value;
}

// Keeps this device in step with the choice made on another one.
export function useAppearanceSync(): void {
  const synced = useSetting<Appearance | null>(KEY, null);
  useEffect(() => {
    if (synced && synced !== storedAppearance()) applyAppearance(synced);
  }, [synced]);
}

export function useAppearance(): Appearance {
  const [value, setValue] = useState(storedAppearance);
  useEffect(() => {
    const update = () => setValue(storedAppearance());
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);
  return value;
}

// The theme showing right now.
export function useTheme(): Theme {
  const appearance = useAppearance();
  const [, tick] = useState(0);
  useEffect(() => {
    const list = window.matchMedia?.("(prefers-color-scheme: dark)");
    const change = () => tick((n) => n + 1);
    list?.addEventListener("change", change);
    return () => list?.removeEventListener("change", change);
  }, []);
  return resolved(appearance);
}

export function useDark(): boolean {
  return useTheme() === "dark";
}
