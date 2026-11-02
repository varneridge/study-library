import type { ItemKind } from "./types";

export const KIND_ORDER: readonly ItemKind[] = ["primary", "secondary", "summary", "slides"] as const;

export const KIND_GROUP_ORDER: readonly ("primary" | "secondary" | "summary")[] = [
  "primary",
  "secondary",
  "summary",
] as const;

export const KIND_LABEL: Record<ItemKind, string> = {
  primary: "primary reading",
  secondary: "secondary reading",
  summary: "summary",
  slides: "slides",
};

export const KIND_TITLE_LABEL: Record<ItemKind, string> = {
  primary: "Primary reading",
  secondary: "Secondary reading",
  summary: "Summary",
  slides: "Slides",
};

export const KIND_DELETE_LABEL: Record<ItemKind, string> = {
  primary: "Delete reading",
  secondary: "Delete reading",
  summary: "Delete summary",
  slides: "Delete slides",
};

export const KIND_GROUP: Record<"primary" | "secondary" | "summary", string> = {
  primary: "Primary readings",
  secondary: "Secondary readings",
  summary: "Course materials",
};

export const KIND_NOUN: Record<ItemKind, string> = {
  primary: "reading",
  secondary: "reading",
  summary: "summary",
  slides: "slides",
};

export const KIND_TOAST_DELETED: Record<ItemKind, string> = {
  primary: "Reading deleted.",
  secondary: "Reading deleted.",
  summary: "Summary deleted.",
  slides: "Slides deleted.",
};

export function deleteLabel(kind: ItemKind): string {
  return KIND_DELETE_LABEL[kind];
}
