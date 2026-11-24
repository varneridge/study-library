// Shared between the reader and the notes editor, kept apart from the
// editor so the reader does not have to load it to know about it.
import { createContext } from "react";
import type { CommentWriter } from "../lib/highlightComments";
import type { HighlightReference } from "../lib/highlightReferences";
import type { HighlightRow } from "../lib/types";

export interface QuoteContextValue {
  readingId?: string;
  open?: (highlightId: string, page: number) => void;
  // The reading's live highlights, so a quotation's card shows its comment
  // without a query of its own.
  highlights?: ReadonlyMap<string, HighlightRow>;
  // The reader's one writer for comments, shared with anything else that edits them.
  comments?: CommentWriter;
  // The essays that cite each highlight, by the highlight's id, so a card can say it is in use.
  references?: ReadonlyMap<string, HighlightReference[]>;
}

export const QuoteContext = createContext<QuoteContextValue>({});
