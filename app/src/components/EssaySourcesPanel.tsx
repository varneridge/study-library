// The Sources card of the essay workspace. It lists every source the essay can cite
// apart from its reading list items, grouped as Primary, Secondary (course) and
// Secondary (outside), with a search so that thirty or more sources stay easy to find.
// Files are uploaded straight onto the essay rather than into a week of the module, and
// each source holds the passage-linked references that cite it, so that a reference can
// be renamed or reworded without ever losing the page or passage it points at.

import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  essaySourcesOf,
  saveModuleAssessment,
  useModuleAssessment,
  type AssessmentData,
  type AttachedPaper,
  type EssaySource,
} from "../lib/assessment";
import {
  ESSAY_SOURCE_CATEGORIES,
  ESSAY_SOURCE_CATEGORY_LABEL,
  createSourceLink,
  filterSources,
  formatCustomFootnote,
  groupSourcesByCategory,
  isEssaySourceCategory,
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
import { mimeFor } from "../lib/uploads";
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

export function EssaySourcesPanel({ moduleId, moduleCode, essayId, uploadFile, onOpenPassage }: EssaySourcesPanelProps) {
  const data = useModuleAssessment(moduleId, moduleCode, essayId);
  const sources = useMemo(() => essaySourcesOf(data), [data]);
  const links = data.sourceLinks ?? EMPTY_LINKS;
  const [query, setQuery] = useState("");
  const [uploadKind, setUploadKind] = useState<EssaySourceCategory>("secondary_outside");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [locator, setLocator] = useState("");
  const [wholeDocument, setWholeDocument] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => groupSourcesByCategory(filterSources(sources, { query })), [sources, query]);
  const filtering = query.trim().length > 0;

  // Every change is applied to the freshest stored data inside the essay's save lock, so
  // that two quick edits, or an edit made on another device, never overwrite each other.
  function save(update: (current: AssessmentData) => AssessmentData): Promise<void> {
    setError(null);
    return saveModuleAssessment(moduleId, update, { moduleCode, essayId }).then(
      () => undefined,
      (err: unknown) => setError(errorText(err, "The change could not be saved.")),
    );
  }

  // Each file is saved onto the essay as soon as it is stored, so that one failed file
  // in a batch does not lose the papers uploaded before it.
  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const stored = await uploadFile(file);
        const paper: AttachedPaper = {
          id: newId(),
          title: titleFromFileName(file.name),
          kind: uploadKind,
          name: file.name,
          size: file.size,
          added_at: new Date().toISOString(),
        };
        const mime = mimeFor(file) ?? file.type;
        if (mime) paper.mime = mime;
        if (stored.fileId) paper.fileId = stored.fileId;
        if (stored.r2Key) paper.r2Key = stored.r2Key;
        await save((current) => ({ ...current, attachedPapers: [...(current.attachedPapers ?? []), paper] }));
      }
    } catch (err) {
      setError(errorText(err, "The file could not be uploaded."));
    } finally {
      setBusy(false);
    }
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

  function deleteSource(source: EssaySource) {
    const count = linksForSource(links, source.id).length;
    const noun = count === 1 ? "reference" : "references";
    if (count && !window.confirm(`Delete \u201c${source.title}\u201d and its ${count} ${noun}?`)) return;
    if (openId === source.id) setOpenId(null);
    void save((current) => withoutSource(current, source.id));
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
    void save((current) => withLinks(current, (list) => removeSourceLink(list, link.id)));
  }

  function renderEditor(source: EssaySource, sourceLinks: SourceLink[]) {
    return (
      <div className="essay-ws-ref-body">
        <div className="essay-ws-ref-tools">
          <label className="small">
            Category{" "}
            <select
              value={normaliseSourceCategory(source.kind)}
              onChange={(event) => {
                const kind = event.target.value;
                if (isEssaySourceCategory(kind)) void save((current) => withCategory(current, source.id, kind));
              }}
            >
              {ESSAY_SOURCE_CATEGORIES.map((category) => (
                <option key={category} value={category}>{ESSAY_SOURCE_CATEGORY_LABEL[category]}</option>
              ))}
            </select>
          </label>
          {addingId !== source.id && (
            <button type="button" className="button" onClick={() => startAdding(source.id)}>Add reference</button>
          )}
        </div>

        {addingId === source.id && (
          <form className="essay-ws-ref-tools" onSubmit={(event) => addLink(event, source.id)}>
            <input
              value={locator}
              onChange={(event) => setLocator(event.target.value)}
              placeholder="Page or passage, such as 12 or 12-14"
              aria-label="Page or passage"
              autoFocus
            />
            <label className="small">
              <input type="checkbox" checked={wholeDocument} onChange={(event) => setWholeDocument(event.target.checked)} />{" "}
              Whole document
            </label>
            <button type="submit" className="button" disabled={!wholeDocument && !locator.trim()}>Add</button>
            <button type="button" className="button" onClick={() => setAddingId(null)}>Cancel</button>
          </form>
        )}

        {sourceLinks.length ? (
          <ul className="essay-ws-ref-list">
            {sourceLinks.map((link) => {
              const linkLocator = sourceLinkLocator(link);
              // Keyed by the last change, so that an edit saved elsewhere refreshes the fields.
              const version = `${link.id}:${link.updated_at ?? ""}`;
              return (
                <li key={link.id} className="essay-ws-ref">
                  <div className="essay-ws-ref-body">
                    <input
                      key={`label:${version}`}
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
                    <div className="essay-ws-ref-tools">
                      <label className="small">
                        <input
                          type="checkbox"
                          checked={Boolean(link.wholeDocument)}
                          onChange={(event) => setLinkWhole(link, event.target.checked)}
                        />{" "}
                        Whole document
                      </label>
                      <button type="button" className="button" onClick={() => onOpenPassage(link, source)}>
                        Open {linkLocator ?? "document"}
                      </button>
                      <button
                        type="button"
                        className="essay-ws-source-action is-danger"
                        aria-label="Delete reference"
                        title="Delete reference"
                        onClick={() => deleteLink(link)}
                      >
                        {"\u00d7"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="small">No references yet, so add one to cite a particular page or passage.</p>
        )}
      </div>
    );
  }

  function renderSource(source: EssaySource) {
    const sourceLinks = linksForSource(links, source.id);
    const open = openId === source.id;
    const sub = sourceSub(source);
    return (
      <li key={source.id}>
        <div className="essay-ws-source">
          <div className="essay-ws-source-body">
            <span className="essay-ws-source-title" title={[source.title, sub].filter(Boolean).join(", ")}>
              {source.title}
              {sub && <span className="essay-ws-source-sub">{` ${sub}`}</span>}
            </span>
            {sourceLinks.length > 0 && (
              <div className="essay-ws-source-links">
                {sourceLinks.map((link) => {
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
          <div className="essay-ws-source-actions">
            <button
              type="button"
              className="essay-ws-source-action"
              aria-expanded={open}
              aria-label={open ? "Close references" : "Edit references"}
              title={open ? "Close references" : "Edit references"}
              onClick={() => {
                setOpenId(open ? null : source.id);
                if (open) setAddingId(null);
              }}
            >
              {open ? "\u25be" : "\u25b8"}
            </button>
            <button
              type="button"
              className="essay-ws-source-action"
              aria-label="Add reference"
              title="Add reference"
              onClick={() => startAdding(source.id)}
            >
              +
            </button>
            <button
              type="button"
              className="essay-ws-source-action is-danger"
              aria-label="Delete source"
              title="Delete source"
              onClick={() => deleteSource(source)}
            >
              {"\u00d7"}
            </button>
          </div>
        </div>
        {open && renderEditor(source, sourceLinks)}
      </li>
    );
  }

  return (
    <section className="essay-panel essay-ws-card" aria-labelledby="essay-ws-sources-title">
      <div className="essay-ws-card-head">
        <h2 id="essay-ws-sources-title" className="essay-ws-card-title">Sources</h2>
        <span className="small">{sources.length}</span>
        <button type="button" className="button" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? "Uploading" : "Upload"}
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => void handleFiles(event)} />
      </div>

      <div className="essay-ws-ref-tools">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by title, author or year"
          aria-label="Search sources"
        />
        <label className="small">
          Upload to{" "}
          <select
            value={uploadKind}
            onChange={(event) => {
              const kind = event.target.value;
              if (isEssaySourceCategory(kind)) setUploadKind(kind);
            }}
          >
            {ESSAY_SOURCE_CATEGORIES.map((category) => (
              <option key={category} value={category}>{ESSAY_SOURCE_CATEGORY_LABEL[category]}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="small" role="alert">{error}</p>}

      {sources.length === 0 ? (
        <p className="small essay-ws-drop-hint">No sources yet, so upload a file to add the first one to this essay.</p>
      ) : (
        <ul className="essay-ws-source-groups">
          {groups.map((group) => (
            <li key={group.category} className="essay-ws-source-group">
              <h3 className="essay-ws-source-group-head">
                {group.label}
                <span className="essay-ws-source-group-count">{group.sources.length}</span>
              </h3>
              {group.sources.length ? (
                <ul className="essay-ws-sources">{group.sources.map(renderSource)}</ul>
              ) : (
                <p className="small">{filtering ? "No sources in this group match the search." : "None yet."}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
