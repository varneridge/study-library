// The Readings and sources card of the essay workspace. It is one quiet list of everything
// the essay can cite, grouped as Primary, Secondary (course) and Secondary (outside), so
// that the course readings chosen for the essay sit beside the files uploaded onto it and
// the sources added by hand, and there is one place to add, cite and check any of them. A
// single Add control offers an upload, a choice from the course readings or a source typed
// by hand, and each row keeps its other actions in its ••• menu so that a long list stays
// calm. Uploaded and hand-added sources hold the passage-linked references that cite them,
// so that a reference can be renamed or reworded without losing the page or passage it
// points at.

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import {
  essaySourcesOf,
  formatChicagoFootnote,
  saveModuleAssessment,
  useModuleAssessment,
  type AssessmentData,
  type AttachedPaper,
  type CustomSource,
  type EssaySource,
} from "../lib/assessment";
import { db } from "../lib/db";
import type { DocxFootnote } from "../lib/docx";
import {
  ESSAY_SOURCE_CATEGORIES,
  ESSAY_SOURCE_CATEGORY_LABEL,
  createSourceLink,
  formatCustomFootnote,
  linksForSource,
  normaliseSourceCategory,
  removeLinksForSource,
  removeSourceLink,
  renameSourceLink,
  resolveSourceLink,
  sourceLinkLocator,
  updateSourceLink,
  type EssaySourceCategory,
  type SourceLink,
} from "../lib/essaySources";
import { newId } from "../lib/sync";
import { fullTitle } from "../lib/titles";
import type { ItemRow } from "../lib/types";
import { confirmAction, showToast } from "../lib/ui";
import { mimeFor } from "../lib/uploads";
import { Menu } from "./Menu";
import { Sheet } from "./Sheet";
import "./AssessmentPage.css";

// Where an uploaded file was stored, so that the paper made from it can be opened later.
export interface EssaySourceUpload {
  fileId?: string;
  r2Key?: string;
}

export interface EssaySourcesPanelProps {
  moduleId: string;
  moduleCode?: string;
  essayId?: string;
  // Stores the file, such as through the reading upload queue, and says where it went.
  uploadFile: (file: File) => Promise<EssaySourceUpload>;
  // Opens the source at the page or passage a reference cites, so that it can be checked.
  onOpenPassage: (link: SourceLink, source: EssaySource) => void;
}

const EMPTY_LINKS: SourceLink[] = [];
const PRIMARY_CATEGORY: EssaySourceCategory = "primary";
const COURSE_CATEGORY: EssaySourceCategory = "secondary_course";
// Uploads land in Secondary (outside), since most papers brought in by hand are outside
// reading, and a row's menu moves one elsewhere in a tap.
const UPLOAD_CATEGORY: EssaySourceCategory = "secondary_outside";

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

function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || name;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// A course reading is grouped by its own kind, so that a primary source set in a week
// sits with the other primary sources rather than among the secondary reading.
function readingCategory(item: ItemRow): EssaySourceCategory {
  return item.kind === "primary" ? PRIMARY_CATEGORY : COURSE_CATEGORY;
}

// Moves one source into another group wherever it is held, whether it was added by
// hand or uploaded, leaving every other field of it as stored.
function withCategory(current: AssessmentData, id: string, kind: EssaySourceCategory): AssessmentData {
  return {
    ...current,
    customSources: (current.customSources ?? []).map((source) => (source.id === id ? { ...source, kind } : source)),
    attachedPapers: current.attachedPapers?.map((paper) => (paper.id === id ? { ...paper, kind } : paper)),
  };
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
// does, and leaves the draft alone when a footnote already cites it, so that two quick
// taps still make a single note.
function withFootnote(current: AssessmentData, sourceId: string, text: string): AssessmentData {
  if (current.draft.footnotes.some((note) => note.citationItemId === sourceId)) return current;
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
interface PanelRow {
  key: string;
  id: string;
  title: string;
  sub: string;
  reading?: ItemRow;
  source?: EssaySource;
}

const readingRow = (item: ItemRow): PanelRow => ({ key: `reading:${item.id}`, id: item.id, title: fullTitle(item), sub: "", reading: item });

const sourceRow = (source: EssaySource): PanelRow => ({
  key: `source:${source.id}`,
  id: source.id,
  title: source.title,
  sub: sourceSub(source),
  source,
});

// A row that a mouse can carry into References, by the rules in drag.ts, which keep a
// finger from dragging it since there is no handle; Cite in the draft does the same job
// on a phone. The id is the panel's own, so it never clashes with another draggable list,
// while the data carries the source's id that the drop looks up.
function SourceItem({ id, draggable, row, editor }: { id: string; draggable: boolean; row: ReactNode; editor?: ReactNode }) {
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
      <div className="essay-ws-source" {...(draggable ? listeners : {})}>
        {row}
      </div>
      {editor}
    </li>
  );
}

export function EssaySourcesPanel({ moduleId, moduleCode, essayId, uploadFile, onOpenPassage }: EssaySourcesPanelProps) {
  const data = useModuleAssessment(moduleId, moduleCode, essayId);
  const sources = useMemo(() => essaySourcesOf(data), [data]);
  const links = data.sourceLinks ?? EMPTY_LINKS;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [byHandOpen, setByHandOpen] = useState(false);
  const [handForm, setHandForm] = useState<HandForm>(EMPTY_HAND_FORM);
  const [addingSource, setAddingSource] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [locator, setLocator] = useState("");
  const [wholeDocument, setWholeDocument] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);

  // Every reading set in the module's weeks or its tray, together with any already chosen
  // for the essay, so that the choice sheet can list them and the card can show the chosen.
  const refIds = data.referenceItemIds.join(",");
  const readings = useLiveQuery(
    async () => {
      const weeks = (await db.weeks.where("module_id").equals(moduleId).toArray()).filter((w) => !w.deleted);
      const weekIds = new Set(weeks.map((w) => w.id));
      const weekLinks = (await db.week_items.toArray()).filter((wi) => !wi.deleted && weekIds.has(wi.week_id));
      const ids = new Set(weekLinks.map((wi) => wi.item_id));
      for (const chosen of data.referenceItemIds) ids.add(chosen);
      const rows = (await db.items.toArray()).filter(
        (i) => !i.deleted && i.kind !== "slides" && (ids.has(i.id) || i.tray_module_id === moduleId),
      );
      return rows.sort((a, b) => fullTitle(a).localeCompare(fullTitle(b)));
    },
    [moduleId, refIds],
    [] as ItemRow[],
  );

  const chosenReadings = useMemo(() => {
    const chosen = new Set(data.referenceItemIds);
    return readings.filter((item) => chosen.has(item.id));
  }, [readings, data.referenceItemIds]);

  const groups = useMemo(
    () =>
      ESSAY_SOURCE_CATEGORIES.map((category) => ({
        category,
        label: ESSAY_SOURCE_CATEGORY_LABEL[category],
        rows: [
          ...chosenReadings.filter((item) => readingCategory(item) === category).map(readingRow),
          ...sources.filter((source) => normaliseSourceCategory(source.kind) === category).map(sourceRow),
        ],
      })),
    [chosenReadings, sources],
  );
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  const citedIds = useMemo(() => {
    const set = new Set<string>();
    for (const note of data.draft.footnotes) if (note.citationItemId) set.add(note.citationItemId);
    return set;
  }, [data.draft.footnotes]);

  // Only readings and sources added by hand are known to the References drop, so only
  // those rows can be carried there; an uploaded paper is cited from its menu instead.
  const draggableIds = useMemo(
    () => new Set([...chosenReadings.map((item) => item.id), ...(data.customSources ?? []).map((source) => source.id)]),
    [chosenReadings, data.customSources],
  );

  // The first choice takes focus when the Add panel opens, so the keyboard lands in it.
  useEffect(() => {
    if (addOpen) firstChoice.current?.focus();
  }, [addOpen]);

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

  function closeAdd() {
    setAddOpen(false);
    addButton.current?.focus();
  }

  // Each file is saved onto the essay as soon as it is stored, so that one failed file
  // in a batch does not lose the papers uploaded before it.
  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setError(null);
    let added = 0;
    try {
      for (const file of files) {
        const stored = await uploadFile(file);
        const paper: AttachedPaper = {
          id: newId(),
          title: titleFromFileName(file.name),
          kind: UPLOAD_CATEGORY,
          name: file.name,
          size: file.size,
          added_at: new Date().toISOString(),
        };
        const mime = mimeFor(file) ?? file.type;
        if (mime) paper.mime = mime;
        if (stored.fileId) paper.fileId = stored.fileId;
        if (stored.r2Key) paper.r2Key = stored.r2Key;
        if (!(await save((current) => ({ ...current, attachedPapers: [...(current.attachedPapers ?? []), paper] })))) break;
        added += 1;
      }
    } catch (err) {
      setError(errorText(err, "The file could not be uploaded, so check the connection and try again."));
    } finally {
      setBusy(false);
    }
    if (added) {
      const what = added === 1 ? "The file was" : `${added} files were`;
      showToast(`${what} added to ${ESSAY_SOURCE_CATEGORY_LABEL[UPLOAD_CATEGORY]}, and its menu moves it elsewhere.`);
    }
  }

  function cite(id: string, text: string | null | undefined) {
    if (!text) return;
    if (citedIds.has(id)) {
      showToast("That source is already cited in the references.");
      return;
    }
    void save((current) => withFootnote(current, id, text)).then((saved) => {
      if (saved) showToast("Footnote added at the end of the draft.");
    });
  }

  function toggleReading(id: string) {
    void save((current) => ({
      ...current,
      referenceItemIds: current.referenceItemIds.includes(id)
        ? current.referenceItemIds.filter((x) => x !== id)
        : [...current.referenceItemIds, id],
    }));
  }

  function removeReading(item: ItemRow) {
    void save((current) => ({ ...current, referenceItemIds: current.referenceItemIds.filter((x) => x !== item.id) })).then(
      (saved) => {
        if (saved) showToast("Reading removed from this essay, though it stays in the module.");
      },
    );
  }

  function moveSource(source: EssaySource, category: EssaySourceCategory) {
    void save((current) => withCategory(current, source.id, category)).then((saved) => {
      if (saved) showToast(`Moved to ${ESSAY_SOURCE_CATEGORY_LABEL[category]}.`);
    });
  }

  // Deleting asks first only when page references would go with the source, since those
  // are the part that would be hard to put back.
  async function deleteSource(source: EssaySource) {
    const count = linksForSource(links, source.id).length;
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

  function renderRow(row: PanelRow) {
    const cited = citedIds.has(row.id);
    const { reading, source } = row;
    const sourceLinks = source ? linksForSource(links, source.id) : EMPTY_LINKS;
    const open = Boolean(source) && openId === row.id;

    const items = reading
      ? [
          ...(cited ? [] : [{ label: "Cite in the draft", onSelect: () => cite(reading.id, formatChicagoFootnote(reading)) }]),
          { label: "Remove from essay", onSelect: () => removeReading(reading) },
        ]
      : source
        ? [
            { label: "Add a page reference", onSelect: () => startAdding(source.id) },
            ...(cited ? [] : [{ label: "Cite in the draft", onSelect: () => cite(source.id, formatCustomFootnote(source)) }]),
            ...ESSAY_SOURCE_CATEGORIES.filter((category) => category !== normaliseSourceCategory(source.kind)).map((category) => ({
              label: `Move to ${ESSAY_SOURCE_CATEGORY_LABEL[category]}`,
              onSelect: () => moveSource(source, category),
            })),
            { label: "Delete source", danger: true, onSelect: () => void deleteSource(source) },
          ]
        : [];

    const content = (
      <>
        <div className="essay-ws-source-body">
          {reading ? (
            <Link to={{ view: "reader", id: reading.id }} className="essay-ws-source-title" title={row.title}>
              {row.title}
            </Link>
          ) : (
            <button
              type="button"
              className="essay-ws-source-title"
              aria-expanded={open}
              title={[row.title, row.sub].filter(Boolean).join(", ")}
              onClick={() => toggleOpen(row.id)}
            >
              {row.title}
              {row.sub && <span className="essay-ws-source-sub">{` ${row.sub}`}</span>}
            </button>
          )}
          {(cited || sourceLinks.length > 0) && (
            <div className="essay-ws-source-meta">
              {cited && <span className="essay-ws-chip">Cited</span>}
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
        <span className="essay-ws-source-menu">
          <Menu label={`Actions for ${row.title}`} items={items} />
        </span>
      </>
    );

    return (
      <SourceItem
        key={row.key}
        id={row.id}
        draggable={draggableIds.has(row.id)}
        row={content}
        editor={open && source ? renderEditor(source, sourceLinks) : null}
      />
    );
  }

  return (
    <section className="essay-panel essay-ws-card essay-ws-sources-card" aria-labelledby="essay-ws-sources-title">
      <div className="essay-ws-card-head">
        <h2 id="essay-ws-sources-title" className="essay-ws-card-title">
          Readings and sources
        </h2>
        {total > 0 && <span className="essay-ws-count">{total}</span>}
        <button
          ref={addButton}
          type="button"
          className="button quiet small essay-ws-add-toggle"
          aria-expanded={addOpen}
          aria-controls="essay-ws-add-panel"
          disabled={busy}
          onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}
        >
          {busy ? "Uploading" : "Add"}
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => void handleFiles(event)} />
      </div>

      {addOpen && (
        <div
          id="essay-ws-add-panel"
          className="essay-ws-add-panel"
          role="group"
          aria-label="Add a reading or source"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAdd();
            }
          }}
        >
          <button
            ref={firstChoice}
            type="button"
            className="essay-ws-add-choice"
            onClick={() => {
              setAddOpen(false);
              fileInput.current?.click();
            }}
          >
            <span>Upload a file</span>
            <span className="essay-ws-add-choice-note">
              Added to {ESSAY_SOURCE_CATEGORY_LABEL[UPLOAD_CATEGORY]}, and moved from its menu if it belongs elsewhere
            </span>
          </button>
          <button
            type="button"
            className="essay-ws-add-choice"
            onClick={() => {
              setAddOpen(false);
              setChoosing(true);
            }}
          >
            <span>Choose from course readings</span>
            <span className="essay-ws-add-choice-note">The readings set in the weeks of this module</span>
          </button>
          <button
            type="button"
            className="essay-ws-add-choice"
            onClick={() => {
              setAddOpen(false);
              setByHandOpen(true);
            }}
          >
            <span>Add by hand</span>
            <span className="essay-ws-add-choice-note">A book, article or archive document without a file</span>
          </button>
          <button type="button" className="button quiet small essay-ws-add-cancel" onClick={closeAdd}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="small essay-ws-error" role="alert">
          {error}
        </p>
      )}

      {total === 0 ? (
        <p className="small muted">
          No readings or sources yet. Use Add to upload a file, choose course readings or add a source by hand.
        </p>
      ) : (
        <ul className="essay-ws-source-groups">
          {groups.map((group) =>
            group.rows.length > 0 ? (
              <li key={group.category} className="essay-ws-source-group">
                <h3 className="essay-ws-source-group-head">
                  {group.label}
                  <span className="essay-ws-source-group-count">{group.rows.length}</span>
                </h3>
                <ul className="essay-ws-sources">{group.rows.map(renderRow)}</ul>
              </li>
            ) : null,
          )}
        </ul>
      )}

      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title="Choose course readings"
        subtitle={moduleCode ? `Readings assigned in ${moduleCode}` : "Readings assigned in this module"}
        className="essay-sources-sheet"
        footer={
          <button type="button" className="button primary" onClick={() => setChoosing(false)}>
            Done
          </button>
        }
      >
        {readings.length === 0 ? (
          <p className="small muted">This module has no readings yet, so add them to its weeks first.</p>
        ) : (
          (["primary", "secondary"] as const).map((group) => {
            const rows = readings.filter((item) => (group === "primary" ? item.kind === "primary" : item.kind !== "primary"));
            if (!rows.length) return null;
            return (
              <div key={group} className="essay-ws-source-group">
                <h3 className="essay-ws-source-group-head">{group === "primary" ? "Primary sources" : "Secondary reading"}</h3>
                <ul className="citation-list">
                  {rows.map((item) => (
                    <li key={item.id}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={data.referenceItemIds.includes(item.id)}
                          onChange={() => toggleReading(item.id)}
                        />
                        <span>{fullTitle(item)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </Sheet>

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
