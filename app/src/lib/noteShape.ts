// The signature that decides when a reading's notes are reconciled with its
// highlights. A highlight's comment is deliberately absent: the comment is
// shown live inside its card, so editing it must never cause the notes
// document to be rewritten while the cursor is inside that card.

export interface ShapeHighlight {
  id: string;
  colour: string;
  page: number;
  body: string | null;
}

export function reconcileShape(highlights: readonly ShapeHighlight[] | null | undefined): string {
  return (highlights ?? []).map((h) => `${h.id}:${h.colour}:${h.page}:${h.body ?? ""}`).join("|");
}
