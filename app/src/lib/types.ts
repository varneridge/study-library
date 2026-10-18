// Row types. These mirror migrations/0001_init.sql.

// "S" is a dissertation section: its number is its place in the order.
export type Term = "AT" | "WT" | "S";
export type SessionKind = "lecture" | "seminar" | "combined" | "supervision";
export type ItemKind = "secondary" | "primary" | "slides";
export type TextStatus = "pending" | "ocr" | "ready" | "failed" | "converted";

export interface SyncedRow {
  id: string;
  modified_at: string;
  seq?: number;
  deleted: boolean;
}

export interface ModuleRow extends SyncedRow {
  code: string;
  title: string | null;
  session_pattern: SessionKind[];
  description: Block[] | null;
  last_opened_week_id: string | null;
  position: string;
  // A taught module has weeks of term; a dissertation has sections you name.
  kind?: ModuleKind;
  // Dates that matter, such as a proposal or a submission, for a countdown.
  key_dates?: KeyDate[] | null;
}

export type ModuleKind = "taught" | "dissertation";
export interface KeyDate { id: string; label: string; date: string }

export interface WeekRow extends SyncedRow {
  module_id: string;
  term: Term;
  number: number;
  title: string | null;
  is_reading_week: boolean;
}

export interface SessionRow extends SyncedRow {
  week_id: string;
  kind: SessionKind;
  title: string | null;
  position: string;
}

export interface FileRow extends SyncedRow {
  sha256: string;
  r2_key: string;
  mime: string;
  bytes: number;
  original_name: string | null;
  page_count: number | null;
  text_status: TextStatus;
}

export interface ItemRow extends SyncedRow {
  kind: ItemKind;
  author: string | null;
  title: string;
  source: string | null;
  pages: string | null;
  year: number | null;
  doc_date: string | null;
  file_id: string | null;
  original_file_id: string | null;
  tray_module_id: string | null;
  zotero_key: string | null;
  last_page: number | null;
  read_status: "unread" | "read";
  last_opened_at?: string | null;
  // A citation the processor found in the PDF. Applied straight away to a
  // reading that had no author or year; offered otherwise.
  suggested?: Suggestion | null;
  // Exactly where you stopped: the page, how far down it, and in text
  // layout the character the screen began at.
  last_spot?: Spot | null;
}

export interface Spot { page: number; frac: number; at?: number | null; quote?: string | null }

export interface Suggestion {
  author: string | null;
  year: number | null;
  title: string;
  source: string | null;
  pages: string | null;
  via: "crossref" | "crossref-title" | "jstor" | "layout" | "metadata" | string;
  applied?: boolean;
  dismissed?: boolean;
  previous?: { author: string | null; year: number | null; title: string; source: string | null; pages: string | null };
}

export interface WeekItemRow extends SyncedRow {
  week_id: string;
  item_id: string;
  session_id: string | null;
  position: string;
}

export interface QuestionRow extends SyncedRow {
  session_id: string;
  body: string;
  position: string;
}

// page is zero-based. Each rect is [x1, y1, x2, y2] in PDF points.
export interface HighlightRow extends SyncedRow {
  item_id: string;
  page: number;
  rects: number[][];
  body: string | null;
  colour: string;
  comment: string | null;
  question_id: string | null;
  zotero_key: string | null;
}

export interface RecordingRow extends SyncedRow {
  session_id: string;
  source: "live" | "upload";
  file_id: string | null;
  duration_seconds: number | null;
  status: string;
  // A transcript imported from Moodle: who spoke, and what they said.
  turns?: Turn[] | null;
}

export interface Turn {
  speaker: string;
  text: string;
  // Seconds from the start, when the file carried times.
  start?: number | null;
}

export interface NoteRow extends SyncedRow {
  session_id: string | null;
  item_id: string | null;
  question_id: string | null;
  // A dissertation section's own notes.
  week_id?: string | null;
  zotero_key: string | null;
}

export interface NoteBlockRow extends SyncedRow {
  note_id: string;
  position: string;
  type: string;
  content: Block;
  highlight_id: string | null;
}

// A synced setting. value is any JSON.
export interface SettingRow extends SyncedRow {
  value: unknown;
}

// The job search. Each of the four file slots is empty, not required, or
// sent, optionally with the stored file or a link to it.
export type SlotName = "cv" | "cl" | "rd" | "qs";

export type FileSlot =
  | { state: "na" }
  | { state: "saved"; key?: string; name?: string; mime?: string; bytes?: number; url?: string };

export interface ApplicationRow extends SyncedRow {
  employer: string;
  role: string;
  applied: string | null;
  stage: string;
  next_deadline: string | null;
  notes: string | null;
  file_cv: FileSlot | null;
  file_cl: FileSlot | null;
  file_rd: FileSlot | null;
  file_qs: FileSlot | null;
}

// BlockNote's block format, kept loose so later editor versions still load.
export interface InlineText {
  type: "text";
  text: string;
  styles: Record<string, boolean | string>;
}
export interface InlineLink {
  type: "link";
  href: string;
  content: InlineText[];
}
export interface Block {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: (InlineText | InlineLink)[];
  children?: Block[];
}

export interface Tables {
  modules: ModuleRow;
  weeks: WeekRow;
  sessions: SessionRow;
  files: FileRow;
  items: ItemRow;
  week_items: WeekItemRow;
  questions: QuestionRow;
  highlights: HighlightRow;
  recordings: RecordingRow;
  notes: NoteRow;
  note_blocks: NoteBlockRow;
  settings: SettingRow;
  applications: ApplicationRow;
}

export type TableName = keyof Tables;

export const SYNCED_TABLES: TableName[] = [
  "modules",
  "weeks",
  "sessions",
  "files",
  "items",
  "week_items",
  "questions",
  "highlights",
  "recordings",
  "notes",
  "note_blocks",
  "settings",
  "applications",
];
