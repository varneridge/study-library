// The Readings and sources card of the essay workspace. It is one quiet list of everything
// the essay can cite, grouped as Primary, Secondary (course) and Secondary (outside), each
// group in alphabetical order, so that the course readings chosen for the essay sit beside
// the files uploaded onto it and the sources added by hand, and there is one place to add,
// cite and check any of them. Add opens a small card in front of the page that searches
// every reading, its text as well as its title, and also offers an upload and a source
// typed by hand; files can be dropped on the card too, onto the group they belong to. A
// row's title opens the source, and the row keeps its other actions in its ••• menu so
// that a long list stays calm. Uploaded and hand-added sources hold the passage-linked
// references that cite them, so that a reference can be renamed or reworded without
// losing the page or passage it points at.

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import {
  ensureSourceReading,
  essaySourcesOf,
  formatChicagoFootnote,
  moveSourceTo,
  readingCategoryOf,
  saveModuleAssessment,
  useModuleAssessment,
  type AssessmentData,
  type CustomSource,
  type EssaySource,
  type SourceDestination,
  type SourceRef,
} from "../lib/assessment";
import { db } from "../lib/db";
import type { DocxFootnote } from "../lib/docx";
import {
  ESSAY_SOURCE_CATEGORIES,
  ESSAY_SOURCE_CATEGORY_LABEL,
  compareSourceTitles,
  createSourceLink,
  formatCustomFootnote,
  linksForSource,
  normaliseSourceCategory,
  referenceCount,
  removeLinksForSource,
  removeSourceLink,
  renameSourceLink,
  resolveSourceLink,
  safeExternalUrl,
  sourceLinkLocator,
  updateSourceLink,
  type EssaySourceCategory,
  type SourceLink,
} from "../lib/essaySources";
import { moduleReadings } from "../lib/library";
import { READING_ACCEPT } from "../lib/photos";
import { MARK_END, MARK_START, searchReadings, type ReadingHit } from "../lib/search";
import type { SourceRole } from "../lib/sourceIntake";
import { newId } from "../lib/sync";
import { fullTitle } from "../lib/titles";
import type { ItemRow } from "../lib/types";
import { confirmAction, showToast } from "../lib/ui";
import { ChoiceCard } from "./ChoiceCard";
import { Icon } from "./icons";
import { Menu, type MenuItem } from "./Menu";
import { SearchField } from "./SearchField";
import { Sheet } from "./Sheet";
import "./AssessmentPage.css";

export interface EssaySourcesPanelProps {
  moduleId: string;
  moduleCode?: string;
  essayId?: string;
  // The module's readings, which the essay page already holds. Left out, the panel finds them itself.
  readings?: ItemRow[];
  // Files chosen with Upload files or dropped on the card, with the role of where they
  // landed, for the page to check on the source card before they are kept.
  onFiles: (files: File[], role: SourceRole) => void;
  // Opens the source card for a source already on the essay, to edit its details.
  onEdit: (ref: SourceRef) => void;
  // Opens the source at the page or passage a reference cites, so that it can be checked.
  onOpenPassage: (link: SourceLink, source: EssaySource) => void;
  // Whether files are being dragged over the page, and the role of the part they are over,
  // so that the groups that take them show, and the one they would go to is marked.
  dragging: boolean;
  overRole?: SourceRole | null;
}

const EMPTY_LINKS: SourceLink[] = [];
// A source added by hand starts in Secondary (outside), since most sources typed in are
// outside reading, and its group can be changed before it is added.
const UPLOAD_CATEGORY: EssaySourceCategory = "secondary_outside";

// Files dropped on a group become sources of that kind. Course readings are the ones the
// module sets in its weeks, so nothing dropped lands there, and a drop anywhere else on
// the card counts as outside reading.
const DROP_ROLE: Partial<Record<EssaySourceCategory, SourceRole>> = {
  primary: "primary",
  secondary_outside: "secondary",
};

// A page number or range, with or without its own "p." or "pp.", such as "12", "12-14"
// or "pp. 3, 7", which is told apart from a passage such as "chapter 3".
const PAGE_LOCATOR = /^(pp?\.?\s*)?\d+[a-z]?(\s*[-\u2013,]\s*\d+[a-z]?)*$/i;

// Reads what was typed as a page when it is a page number or range, so that the footnote
// gains its "p." or "pp." exactly once, and as a passage otherwise.
function locatorFields(raw: string): Pick<SourceLink, "page" | "passage"> {
  const value = raw.trim();
  if (!value) return {};
  if (PAGE_LOCATOR.test(value)) return { page: value.replace(/^pp?\.?\s*/i, "") };
  return { passage: value };
}

function sourceSub(source: EssaySource): string {
  return [source.author?.trim(), source.year?.trim()].filter(Boolean).join(", ");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// Removes one source together with the references that cite it, because a reference
// to a deleted source could only ever be shown as missing.
function withoutSource(current: AssessmentData, id: string): AssessmentData {
  return {
    ...current,
    customSources: (current.customSources ?? []).filter((source) => source.id !== id),
    attachedPapers: current.attachedPapers?.filter((paper) => paper.id !== id),
    sourceLinks: removeLinksForSource(current.sourceLinks ?? EMPTY_LINKS, id),
  };
}

function withLinks(current: AssessmentData, change: (links: SourceLink[]) => SourceLink[]): AssessmentData {
  return { ...current, sourceLinks: change(current.sourceLinks ?? EMPTY_LINKS) };
}

// Cites a source with a footnote at the end of the draft, as dropping it on References
// Appends a footnote for a source at the end of the draft.
function withFootnote(current: AssessmentData, sourceId: string, text: string): AssessmentData {
  const footnoteId = `fn-${newId()}`;
  const blocks = [...current.draft.blocks];
  const last = blocks.length - 1;
  if (last >= 0) {
    blocks[last] = { ...blocks[last], runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }] };
  }
  const note: DocxFootnote = { id: footnoteId, text, citationItemId: sourceId };
  return { ...current, draft: { ...current.draft, blocks, footnotes: [...current.draft.footnotes, note] } };
}

interface HandForm {
  title: string;
  author: string;
  year: string;
  publisher: string;
  url: string;
  category: EssaySourceCategory;
}

const EMPTY_HAND_FORM: HandForm = { title: "", author: "", year: "", publisher: "", url: "", category: UPLOAD_CATEGORY };

// One line of the card, which is either a course reading or a source held on the essay.
// It is sorted by the words it starts with, so that the list reads in alphabetical order.
interface PanelRow {
  key: string;
  id: string;
  title: string;
  sub: string;
  reading?: ItemRow;
  source?: EssaySource;
  paper: boolean;
}

const readingRow = (item: ItemRow): PanelRow => ({ key: `reading:${item.id}`, id: item.id, title: fullTitle(item), sub: "", reading: item, paper: false });

const sourceRow = (source: EssaySource, paper: boolean): PanelRow => ({
  key: `source:${source.id}`,
  id: source.id,
  title: source.title,
  sub: sourceSub(source),
  source,
  paper,
});

// A row that a mouse can carry into References, by the rules in drag.ts, which keep a
// finger from dragging it since there is no handle; Cite in the draft does the same job
// on a phone. The id is the panel's own, so it never clashes with another draggable list,
// while the data carries the source's id that the drop looks up.
function SourceItem({ id, draggable, cited, row, editor }: { id: string; draggable: boolean; cited?: boolean; row: ReactNode; editor?: ReactNode }) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `panel-source:${id}`,
    data: { sourceId: id },
    disabled: !draggable,
  });
  return (
    <li
      ref={setNodeRef}
      className={`essay-ws-source-item${draggable ? " is-draggable" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <div className={`essay-ws-source${cited ? " is-cited" : ""}`} {...(draggable ? listeners : {})}>
        {row}
      </div>
      {editor}
    </li>
  );
}

// Where in a reading's text the words were found, with each of them marked as the search
// marked it.
function Marked({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text.split(MARK_START).forEach((chunk, index) => {
    if (index === 0) {
      if (chunk) parts.push(<Fragment key="start">{chunk}</Fragment>);
      return;
    }
    const [hit, ...rest] = chunk.split(MARK_END);
    parts.push(<mark key={`hit${index}`}>{hit}</mark>);
    const after = rest.join(MARK_END);
    if (after) parts.push(<Fragment key={`after${index}`}>{after}</Fragment>);
  });
  return <>{parts}</>;
}

// How long the search waits for typing to pause, so that every key does not search.
const SEARCH_DELAY = 250;

// What the Add card holds. With nothing typed it lists the module's readings not yet in the
// essay; with a search it finds readings anywhere in the library by title, highlight and,
// when online, the text of their pages. A tap chooses a reading and another tap lets it go,
// and the chosen ones are added together.
function AddBody({ readings, chosen, onAdd, onUpload, onByHand }: {
  readings: ItemRow[];
  chosen: ReadonlySet<string>;
  onAdd: (items: ItemRow[]) => Promise<boolean>;
  onUpload: () => void;
  onByHand: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ReadingHit[] | null>(null);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [picked, setPicked] = useState<Map<string, ItemRow>>(() => new Map());
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const q = query.trim();

  // The titles and highlights on this device show first, and the text of the pages joins
  // them from the server, so that a slow connection never holds back what is already known.
  useEffect(() => {
    setHits(null);
    setRemoteFailed(false);
    if (!q) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const local = await searchReadings(q, { remote: false });
        if (!live) return;
        setHits(local);
        if (!navigator.onLine) return;
        const all = await searchReadings(q, { remote: true });
        if (live) setHits(all);
      } catch {
        if (live) setRemoteFailed(true);
      }
    }, SEARCH_DELAY);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q]);

  const rows: ReadingHit[] = useMemo(() => {
    if (q) return (hits ?? []).filter((hit) => !chosen.has(hit.item.id));
    return readings
      .filter((item) => !chosen.has(item.id))
      .map((item) => ({ item }))
      .sort((a, b) => compareSourceTitles(fullTitle(a.item), fullTitle(b.item)));
  }, [q, hits, readings, chosen]);

  const toggle = (item: ItemRow) =>
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });

  // The button is disabled from the first tap until the save finishes, so a double tap
  // can only ever add the readings once.
  async function add() {
    if (addingRef.current || !picked.size) return;
    addingRef.current = true;
    setAdding(true);
    const saved = await onAdd([...picked.values()]);
    addingRef.current = false;
    if (!saved) setAdding(false);
  }

  let note: string | null = null;
  if (!q && !rows.length) {
    note = readings.length
      ? "Every reading set in this module is already in the essay, so search to find others."
      : "This module has no readings yet, so search to find one elsewhere, or upload a file.";
  } else if (q && hits === null && !remoteFailed) note = "Searching";
  else if (q && !rows.length) note = `No readings match \u201c${q}\u201d.`;

  return (
    <>
      <SearchField
        value={query}
        onChange={setQuery}
        label="Search readings"
        placeholder="Search titles, highlights and the text of readings"
        className="essay-ws-pick-search"
      />
      {note ? (
        <p className="small muted essay-ws-pick-empty" role="status">{note}</p>
      ) : (
        <ul className="essay-ws-pick-list">
          {rows.map(({ item, snippet }) => (
            <li key={item.id}>
              <button type="button" className="essay-ws-pick-row" aria-pressed={picked.has(item.id)} onClick={() => toggle(item)}>
                <span className="essay-ws-pick-main">
                  <span className="essay-ws-pick-title">{fullTitle(item)}</span>
                  {snippet && (
                    <span className="essay-ws-pick-snippet">
                      <Marked text={snippet} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && remoteFailed && (
        <p className="small muted essay-ws-pick-empty">The text inside readings could not be searched, so check the connection.</p>
      )}
      {q && !remoteFailed && !navigator.onLine && (
        <p className="small muted essay-ws-pick-empty">Offline, so only titles and highlights are searched.</p>
      )}
      <div className="essay-ws-pick-foot">
        <button type="button" className="button quiet small" onClick={onUpload}>
          Upload files
        </button>
        <button type="button" className="button quiet small" onClick={onByHand}>
          Add by hand
        </button>
        <button
          type="button"
          className="button primary small"
          style={{ marginLeft: "auto" }}
          disabled={!picked.size || adding}
          onClick={() => void add()}
        >
          {picked.size > 1 ? `Add ${picked.size} readings` : "Add reading"}
        </button>
      </div>
    </>
  );
}

// The Add control's card: a small panel in front of the page beside the button on a
// laptop, and a sheet from the foot of the screen on a phone, with a visible Cancel.
function AddSourcesCard({ open, onClose, anchor, ...body }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
} & Parameters<typeof AddBody>[0]) {
  return (
    <ChoiceCard
      open={open}
      onClose={onClose}
      anchor={anchor}
      label="Add readings and sources"
      title={<h3 className="choice-title">Add readings and sources</h3>}
      className="essay-ws-pick essay-ws-add-pick"
      initialFocus="input[type='search']"
    >
      <AddBody {...body} />
    </ChoiceCard>
  );
}

export function EssaySourcesPanel({
  moduleId,
  moduleCode,
  essayId,
  readings: given,
  onFiles,
  onEdit,
  onOpenPassage,
  dragging,
  overRole = null,
}: EssaySourcesPanelProps) {
  const data = useModuleAssessment(moduleId, moduleCode, essayId);
  const sources = useMemo(() => essaySourcesOf(data), [data]);
  const links = data.sourceLinks ?? EMPTY_LINKS;
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [byHandOpen, setByHandOpen] = useState(false);
  const [handForm, setHandForm] = useState<HandForm>(EMPTY_HAND_FORM);
  const [addingSource, setAddingSource] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  // The sources being cited right now, so that a second tap on the button or the menu item
  // while the first is still saving makes no second note and no second notice. The ref is
  // read by the handler and the state redraws the button as disabled.
  const citingRef = useRef(new Set<string>());
  const [citing, setCiting] = useState<ReadonlySet<string>>(() => new Set());
  const [locator, setLocator] = useState("");
  const [wholeDocument, setWholeDocument] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  // Every reading set in the module's weeks or its tray, together with any already chosen
  // for the essay, so that the Add card can offer them and the card can show the chosen.
  const refIds = data.referenceItemIds.join(",");
  const found = useLiveQuery(
    () => (given ? [] : moduleReadings(moduleId, data.referenceItemIds)),
    [moduleId, refIds, Boolean(given)],
    [] as ItemRow[],
  );
  const readings = given ?? found;

  const chosenIds = useMemo(() => new Set(data.referenceItemIds), [data.referenceItemIds]);
  const chosenReadings = useMemo(() => readings.filter((item) => chosenIds.has(item.id)), [readings, chosenIds]);
  const paperIds = useMemo(() => new Set((data.attachedPapers ?? []).map((paper) => paper.id)), [data.attachedPapers]);

  // A paper uploaded before sources had readings of their own is given one, under its own
  // id, so that its title opens it in the reader in a new tab with one click. Doing so on
  // two devices makes the same rows, and a paper that already has its reading is left alone.
  const paperKey = (data.attachedPapers ?? []).map((paper) => `${paper.id}:${paper.r2Key ?? ""}`).join(",");
  useEffect(() => {
    for (const paper of data.attachedPapers ?? []) {
      if (!paper.r2Key) continue;
      void ensureSourceReading({ id: paper.id, name: paper.name ?? paper.title, size: paper.size, mime: paper.mime, r2Key: paper.r2Key }).catch(
        () => undefined,
      );
    }
    // The papers are read again only when one is added, removed or given a file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperKey]);

  const groups = useMemo(
    () =>
      ESSAY_SOURCE_CATEGORIES.map((category) => ({
        category,
        label: ESSAY_SOURCE_CATEGORY_LABEL[category],
        rows: [
          ...chosenReadings.filter((item) => readingCategoryOf(data, item) === category).map(readingRow),
          ...sources
            .filter((source) => normaliseSourceCategory(source.kind) === category)
            .map((source) => sourceRow(source, paperIds.has(source.id))),
        ].sort((a, b) => compareSourceTitles(a.title, b.title) || a.id.localeCompare(b.id)),
      })),
    [chosenReadings, sources, data, paperIds],
  );
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  const citedIds = useMemo(() => {
    const set = new Set<string>();
    for (const note of data.draft.footnotes) if (note.citationItemId) set.add(note.citationItemId);
    return set;
  }, [data.draft.footnotes]);

  // Only readings and sources added by hand are known to the References drop, so only
  // those rows can be carried there; an uploaded paper is cited from its Cite button instead.
  const draggableIds = useMemo(
    () => new Set([...chosenReadings.map((item) => item.id), ...(data.customSources ?? []).map((source) => source.id)]),
    [chosenReadings, data.customSources],
  );

  // Every change is applied to the freshest stored data inside the essay's save lock, so
  // that two quick edits, or an edit made on another device, never overwrite each other.
  function save(update: (current: AssessmentData) => AssessmentData): Promise<boolean> {
    setError(null);
    return saveModuleAssessment(moduleId, update, { moduleCode, essayId }).then(
      () => true,
      (err: unknown) => {
        setError(errorText(err, "The change could not be saved, so try again in a moment."));
        return false;
      },
    );
  }

  // Readings found outside the module are outside reading, so they join that group; a
  // primary source stays with the primary sources wherever it was found.
  async function addReadings(items: ItemRow[]): Promise<boolean> {
    const inModule = new Set(readings.map((item) => item.id));
    const saved = await save((current) => {
      let next: AssessmentData = {
        ...current,
        referenceItemIds: [...current.referenceItemIds, ...items.map((item) => item.id).filter((id) => !current.referenceItemIds.includes(id))],
      };
      for (const item of items) {
        if (!inModule.has(item.id) && item.kind !== "primary") next = moveSourceTo(next, { type: "reading", id: item.id }, "secondary_outside");
      }
      return next;
    });
    if (saved) {
      setAddOpen(false);
      showToast(items.length === 1 ? "Reading added to this essay." : `${items.length} readings added to this essay.`);
    }
    return saved;
  }

  // Guards against rapid double-taps while the save is in flight, while allowing a source
  // that is already cited to be cited again.
  async function cite(id: string, text: string | null | undefined): Promise<boolean> {
    if (!text || citingRef.current.has(id)) return false;
    citingRef.current.add(id);
    setCiting(new Set(citingRef.current));
    try {
      const saved = await save((current) => withFootnote(current, id, text));
      if (saved) showToast("Footnote added at the end of the draft.");
      return saved;
    } finally {
      citingRef.current.delete(id);
      setCiting(new Set(citingRef.current));
    }
  }

  // Asks first only when page references would go with it, since those are the part
  // that would be hard to put back; the reading itself stays in the module.
  async function removeReading(item: ItemRow) {
    const count = referenceCount(linksForSource(links, item.id));
    if (count) {
      const noun = count === 1 ? "page reference goes" : "page references go";
      const ok = await confirmAction({
        title: `Remove \u201c${item.title}\u201d from this essay?`,
        body: `Its ${count} ${noun} with it, though the reading stays in the module.`,
        confirm: "Remove from essay",
        danger: true,
      });
      if (!ok) return;
    }
    const saved = await save((current) => ({
      ...current,
      referenceItemIds: current.referenceItemIds.filter((x) => x !== item.id),
      sourceLinks: removeLinksForSource(current.sourceLinks ?? EMPTY_LINKS, item.id),
    }));
    if (saved) showToast("Reading removed from this essay, though it stays in the module.");
  }

  // Moves a source to another group or to the admin documents. A reading needs its file's
  // details to become an admin document, which are read from the file it holds.
  async function moveTo(ref: SourceRef, to: SourceDestination) {
    let file: { name: string; size: number; mime: string } | undefined;
    if (ref.type === "reading" && to === "admin") {
      const item = readings.find((reading) => reading.id === ref.id);
      const row = item?.file_id ? await db.files.get(item.file_id) : undefined;
      if (!item || !row) {
        showToast("This reading has no file yet, so it cannot be an admin document.");
        return;
      }
      file = { name: item.title, size: row.bytes, mime: row.mime };
    }
    if (await save((current) => moveSourceTo(current, ref, to, file))) {
      showToast(`Moved to ${to === "admin" ? "Admin documents" : ESSAY_SOURCE_CATEGORY_LABEL[to]}.`);
    }
  }

  function moveItems(ref: SourceRef, current: EssaySourceCategory, toAdmin: boolean): MenuItem[] {
    return [
      ...ESSAY_SOURCE_CATEGORIES.filter((category) => category !== current).map((category) => ({
        label: ESSAY_SOURCE_CATEGORY_LABEL[category],
        onSelect: () => void moveTo(ref, category),
      })),
      ...(toAdmin ? [{ label: "Admin documents", onSelect: () => void moveTo(ref, "admin") }] : []),
    ];
  }

  // Deleting asks first only when page references would go with the source, since those
  // are the part that would be hard to put back.
  async function deleteSource(source: EssaySource) {
    const count = referenceCount(linksForSource(links, source.id));
    if (count) {
      const noun = count === 1 ? "page reference goes" : "page references go";
      const ok = await confirmAction({
        title: `Delete \u201c${source.title}\u201d?`,
        body: `Its ${count} ${noun} with it, because a reference to a deleted source could only show as missing.`,
        confirm: "Delete source",
        danger: true,
      });
      if (!ok) return;
    }
    if (openId === source.id) setOpenId(null);
    if (await save((current) => withoutSource(current, source.id))) showToast("Source deleted.");
  }

  function openReferences(id: string) {
    setOpenId(id);
    setAddingId(null);
  }

  function toggleOpen(id: string) {
    setOpenId((current) => (current === id ? null : id));
    setAddingId(null);
  }

  function startAdding(id: string) {
    setOpenId(id);
    setAddingId(id);
    setLocator("");
    setWholeDocument(false);
  }

  // A reference cites a page or passage unless Whole document is ticked, and any page
  // typed is kept even then, so that unticking it later restores the locator.
  function addLink(event: FormEvent<HTMLFormElement>, sourceId: string) {
    event.preventDefault();
    const fields = locatorFields(locator);
    if (!wholeDocument && !fields.page && !fields.passage) return;
    const link = createSourceLink({ id: newId(), sourceId, ...fields, ...(wholeDocument ? { wholeDocument: true } : {}) });
    void save((current) => withLinks(current, (list) => [...list, link]));
    setAddingId(null);
  }

  // Renaming and rewording change only the writer's own wording, which the helpers keep
  // apart from the source and the passage, so that no edit can detach a reference.
  function renameLink(link: SourceLink, value: string) {
    if (value.trim() === (link.label ?? "")) return;
    void save((current) => withLinks(current, (list) => renameSourceLink(list, link.id, value.trim() || null)));
  }

  function rewordLink(link: SourceLink, value: string) {
    if (value.trim() === (link.footnoteText ?? "")) return;
    void save((current) => withLinks(current, (list) => updateSourceLink(list, link.id, { footnoteText: value.trim() || null })));
  }

  function setLinkWhole(link: SourceLink, checked: boolean) {
    void save((current) => withLinks(current, (list) => updateSourceLink(list, link.id, { wholeDocument: checked })));
  }

  function deleteLink(link: SourceLink) {
    void save((current) => withLinks(current, (list) => removeSourceLink(list, link.id))).then((saved) => {
      if (saved) showToast("Page reference deleted.");
    });
  }

  function setHand(patch: Partial<HandForm>) {
    setHandForm((current) => ({ ...current, ...patch }));
  }

  // Cancel leaves nothing behind, so the next source added by hand starts from a clean form.
  function closeByHand() {
    setByHandOpen(false);
    setHandForm(EMPTY_HAND_FORM);
  }

  // The button is disabled from the first tap until the save finishes, so a double tap
  // can only ever add one source.
  async function addByHand(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const title = handForm.title.trim();
    if (!title || addingSource) return;
    setAddingSource(true);
    const source: CustomSource = {
      id: newId(),
      title,
      kind: handForm.category,
      author: handForm.author.trim() || undefined,
      year: handForm.year.trim() || undefined,
      publisher: handForm.publisher.trim() || undefined,
      url: handForm.url.trim() || undefined,
    };
    const saved = await save((current) => ({ ...current, customSources: [...(current.customSources ?? []), source] }));
    setAddingSource(false);
    if (!saved) return;
    const group = ESSAY_SOURCE_CATEGORY_LABEL[handForm.category];
    closeByHand();
    showToast(`Source added to ${group}.`);
  }

  function renderEditor(source: EssaySource, sourceLinks: SourceLink[]) {
    const adding = addingId === source.id;
    return (
      <div className="essay-ws-source-editor">
        {sourceLinks.length > 0 ? (
          <ul className="essay-ws-source-refs">
            {sourceLinks.map((link) => {
              const linkLocator = sourceLinkLocator(link);
              // Keyed by the last change, so that an edit saved elsewhere refreshes the fields.
              const version = `${link.id}:${link.updated_at ?? ""}`;
              return (
                <li key={link.id} className="essay-ws-source-ref">
                  <input
                    key={`label:${version}`}
                    type="text"
                    className="essay-ws-source-ref-name"
                    defaultValue={link.label ?? ""}
                    placeholder={linkLocator ?? "Whole document"}
                    aria-label="Reference name"
                    onBlur={(event) => renameLink(link, event.currentTarget.value)}
                  />
                  <textarea
                    key={`note:${version}`}
                    className="essay-ws-ref-text"
                    rows={2}
                    defaultValue={link.footnoteText ?? ""}
                    placeholder={formatCustomFootnote(source, linkLocator)}
                    aria-label="Footnote text"
                    onBlur={(event) => rewordLink(link, event.currentTarget.value)}
                  />
                  <div className="essay-ws-source-ref-tools">
                    <label className="small essay-ws-check">
                      <input
                        type="checkbox"
                        checked={Boolean(link.wholeDocument)}
                        onChange={(event) => setLinkWhole(link, event.target.checked)}
                      />
                      Whole document
                    </label>
                    <button type="button" className="button quiet small" onClick={() => onOpenPassage(link, source)}>
                      Open {linkLocator ?? "document"}
                    </button>
                    <button type="button" className="button quiet small is-danger" onClick={() => deleteLink(link)}>
                      Delete reference
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          !adding && <p className="small muted">No page references yet, so add one to cite a particular page or passage.</p>
        )}

        {adding ? (
          <form
            className="essay-ws-source-ref-form"
            onSubmit={(event) => addLink(event, source.id)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setAddingId(null);
              }
            }}
          >
            <input
              type="text"
              value={locator}
              onChange={(event) => setLocator(event.target.value)}
              placeholder="Page or passage, such as 12 or 12-14"
              aria-label="Page or passage"
              autoFocus
            />
            <label className="small essay-ws-check">
              <input type="checkbox" checked={wholeDocument} onChange={(event) => setWholeDocument(event.target.checked)} />
              Whole document
            </label>
            <button type="submit" className="button small" disabled={!wholeDocument && !locator.trim()}>
              Add reference
            </button>
            <button type="button" className="button quiet small" onClick={() => setAddingId(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="essay-ws-source-editor-foot">
            <button type="button" className="button quiet small" onClick={() => startAdding(source.id)}>
              Add a page reference
            </button>
            <button type="button" className="button quiet small" onClick={() => toggleOpen(source.id)}>
              Close
            </button>
          </div>
        )}
      </div>
    );
  }

  // A row's title opens what it names: a reading in the reader, in a new tab, an uploaded
  // paper the same way through the reading it is given, and a source added by hand at its
  // link. A source with nothing to open offers its details instead.
  function renderTitle(row: PanelRow, ref: SourceRef) {
    const label = [row.title, row.sub].filter(Boolean).join(", ");
    const body = (
      <>
        {row.title}
        {row.sub && <span className="essay-ws-source-sub">{` ${row.sub}`}</span>}
      </>
    );
    if (row.reading || (row.paper && row.source && "r2Key" in row.source && row.source.r2Key)) {
      return (
        <Link to={{ view: "reader", id: row.id }} className="essay-ws-source-title" title={label} newTab="always">
          {body}
        </Link>
      );
    }
    const url = row.source && !row.paper ? safeExternalUrl(row.source.url) : null;
    if (url) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="essay-ws-source-title" title={label}>
          {body}
        </a>
      );
    }
    return (
      <button type="button" className="essay-ws-source-title" title={`Edit details of ${row.title}`} onClick={() => onEdit(ref)}>
        {body}
      </button>
    );
  }

  function renderRow(row: PanelRow, category: EssaySourceCategory) {
    const cited = citedIds.has(row.id);
    const { reading, source } = row;
    const sourceLinks = source ? linksForSource(links, source.id) : EMPTY_LINKS;
    const open = Boolean(source) && openId === row.id;
    const ref: SourceRef = { type: reading ? "reading" : row.paper ? "paper" : "custom", id: row.id };
    const footnoteText = reading ? formatChicagoFootnote(reading) : source ? formatCustomFootnote(source) : null;

    const items: MenuItem[] = reading
      ? [
          { label: "Edit details", onSelect: () => onEdit(ref) },
          { label: "Cite in the draft", onSelect: () => void cite(reading.id, footnoteText) },
          { label: "Move to", items: moveItems(ref, category, Boolean(reading.file_id)) },
          { label: "Remove from essay", onSelect: () => void removeReading(reading) },
        ]
      : source
        ? [
            { label: "Edit details", onSelect: () => onEdit(ref) },
            { label: "Page references", onSelect: () => openReferences(source.id) },
            { label: "Cite in the draft", onSelect: () => void cite(source.id, footnoteText) },
            { label: "Move to", items: moveItems(ref, category, row.paper && "r2Key" in source && Boolean(source.r2Key)) },
            { label: "Delete source", danger: true, onSelect: () => void deleteSource(source) },
          ]
        : [];

    const content = (
      <>
        <div className="essay-ws-source-body">
          {renderTitle(row, ref)}
          {sourceLinks.length > 0 && (
            <div className="essay-ws-source-meta">
              {source &&
                sourceLinks.map((link) => {
                  const resolved = resolveSourceLink(link, sources);
                  return (
                    <button
                      key={link.id}
                      type="button"
                      className="essay-ws-link-badge"
                      title={`${resolved.label}. ${resolved.footnoteText}`}
                      onClick={() => onOpenPassage(link, source)}
                    >
                      {link.label?.trim() || resolved.locator || "Whole document"}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
        {/* One narrow vertical column at the right for Cite and ••• so the title keeps its
            full width, and an accent bar on the row marks cited sources without changing shape. */}
        <span className="essay-ws-source-actions">
          {(reading || source) && (
            <button
              type="button"
              className="quiet essay-ws-source-cite"
              aria-label={`Cite \u201c${row.title}\u201d in the draft`}
              title="Cite in the draft"
              disabled={citing.has(row.id)}
              onClick={() => void cite(row.id, footnoteText)}
            >
              <Icon name="cite" size={16} />
            </button>
          )}
          <span className="essay-ws-source-menu">
            <Menu label={`Actions for ${row.title}`} items={items} />
          </span>
        </span>
      </>
    );

    return (
      <SourceItem
        key={row.key}
        id={row.id}
        draggable={draggableIds.has(row.id)}
        cited={cited}
        row={content}
        editor={open && source ? renderEditor(source, sourceLinks) : null}
      />
    );
  }

  return (
    <section className="essay-ws-card essay-ws-sources-card" aria-labelledby="essay-ws-sources-title" data-drop-role="secondary">
      <div className="essay-ws-card-head">
        <h2 id="essay-ws-sources-title" className="essay-ws-card-title">
          Readings and sources
        </h2>
        {total > 0 && <span className="essay-ws-count">{total}</span>}
        <button
          ref={addButton}
          type="button"
          className="button quiet small essay-ws-add-toggle"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          onClick={() => setAddOpen(true)}
        >
          Add
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={READING_ACCEPT}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) onFiles(files, "secondary");
          }}
        />
      </div>

      {error && (
        <p className="small essay-ws-error" role="alert">
          {error}
        </p>
      )}

      {total === 0 && !dragging ? (
        <p className="small muted">
          No readings or sources yet. Drop files here, or use Add to find a reading, upload a file or add a source by hand.
        </p>
      ) : (
        <ul className="essay-ws-source-groups">
          {groups.map((group) => {
            const role = DROP_ROLE[group.category];
            if (!group.rows.length && !(dragging && role)) return null;
            return (
              <li
                key={group.category}
                className={`essay-ws-source-group${role && overRole === role ? " is-drop-target" : ""}`}
                data-drop-role={role}
              >
                <h3 className="essay-ws-source-group-head">
                  {group.label}
                  {group.rows.length > 0 && <span className="essay-ws-source-group-count">{group.rows.length}</span>}
                </h3>
                {group.rows.length > 0 ? (
                  <ul className="essay-ws-sources">{group.rows.map((row) => renderRow(row, group.category))}</ul>
                ) : (
                  <p className="small muted">Drop files here.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddSourcesCard
        open={addOpen}
        onClose={() => setAddOpen(false)}
        anchor={addButton}
        readings={readings}
        chosen={chosenIds}
        onAdd={addReadings}
        onUpload={() => {
          setAddOpen(false);
          fileInput.current?.click();
        }}
        onByHand={() => {
          setAddOpen(false);
          setByHandOpen(true);
        }}
      />

      <Sheet
        open={byHandOpen}
        onClose={closeByHand}
        title="Add a source by hand"
        subtitle="An archive document, article, book or web page that you are not uploading"
        footer={
          <div className="essay-ws-sheet-actions">
            <button type="button" className="button quiet" onClick={closeByHand}>
              Cancel
            </button>
            <button
              type="submit"
              form="essay-ws-hand-form"
              className="button primary"
              disabled={addingSource || !handForm.title.trim()}
            >
              Add source
            </button>
          </div>
        }
      >
        <form id="essay-ws-hand-form" className="essay-ws-byhand" onSubmit={(event) => void addByHand(event)}>
          <label className="field">
            <span>Title</span>
            <input
              type="text"
              autoFocus
              value={handForm.title}
              placeholder="The title of the book, article or document"
              onChange={(event) => setHand({ title: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Author or creator</span>
            <input
              type="text"
              value={handForm.author}
              placeholder="Such as Hobsbawm, Eric, or the Foreign Office"
              onChange={(event) => setHand({ author: event.target.value })}
            />
          </label>
          <div className="essay-ws-byhand-row">
            <label className="field">
              <span>Year or date</span>
              <input
                type="text"
                value={handForm.year}
                placeholder="Such as 1962 or 14 July 1789"
                onChange={(event) => setHand({ year: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Publisher or archive reference</span>
              <input
                type="text"
                value={handForm.publisher}
                placeholder="Such as Weidenfeld and Nicolson, or TNA FO 371"
                onChange={(event) => setHand({ publisher: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Link</span>
            <input
              type="url"
              value={handForm.url}
              placeholder="https://"
              onChange={(event) => setHand({ url: event.target.value })}
            />
          </label>
          <fieldset className="essay-ws-group-choice">
            <legend>Group</legend>
            <div className="essay-ws-group-options">
              {ESSAY_SOURCE_CATEGORIES.map((category) => (
                <label key={category} className="essay-ws-group-option">
                  <input
                    type="radio"
                    name="essay-ws-hand-group"
                    value={category}
                    checked={handForm.category === category}
                    onChange={() => setHand({ category })}
                  />
                  <span>{ESSAY_SOURCE_CATEGORY_LABEL[category]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      </Sheet>
    </section>
  );
}
