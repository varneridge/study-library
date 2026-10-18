// The app's theme: light, sepia, dark, or whatever the device uses. One
// choice colours everything, from the home page to the reader's panels and
// the pages themselves. It syncs across devices, and a copy on the device
// applies it before the first paint.

import { useEffect, useState } from "react";
import { setSetting, useSetting } from "./settings";

export type Appearance = "light" | "sepia" | "dark" | "system";
export type Theme = "light" | "sepia" | "dark";
const KEY = "appearance";
const listeners = new Set<() => void>();
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
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (storedAppearance() === "system") applyAppearance("system");
});

export async function chooseAppearance(value: Appearance): Promise<void> {
  applyAppearance(value);
  await setSetting(KEY, value);
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
