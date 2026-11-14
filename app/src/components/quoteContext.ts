// Shared between the reader and the notes editor, kept apart from the
// editor so the reader does not have to load it to know about it.
import { createContext } from "react";
import type { CommentWriter } from "../lib/highlightComments";
import type { HighlightRow } from "../lib/types";

export interface QuoteContextValue {
  readingId?: string;
  open?: (highlightId: string, page: number) => void;
  // The reading's live highlights, so a quotation's card shows its comment
  // without a query of its own.
  highlights?: ReadonlyMap<string, HighlightRow>;
  // The reader's one writer for comments, shared with anything else that edits them.
  comments?: CommentWriter;
}

export const QuoteContext = createContext<QuoteContextValue>({});
