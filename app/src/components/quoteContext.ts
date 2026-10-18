// Shared between the reader and the notes editor, kept apart from the
// editor so the reader does not have to load it to know about it.
import { createContext } from "react";

export const QuoteContext = createContext<{ readingId?: string; open?: (highlightId: string, page: number) => void }>({});
