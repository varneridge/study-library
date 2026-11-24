// The source card: where a file dropped on the essay page, or a reading, an admin document
// or a source already on the essay, has its details checked before it is kept. It is a
// centred card on a laptop and a sheet from the foot of the screen on a phone, with the
// file's picture on the left and its fields on the right. Each source is Admin, Primary or
// Secondary, and the fields follow: a name for an admin document, a type and its details
// for a primary source, and the usual reading fields for a secondary one. Several files
// are stepped through as "1 of 3" with Next source and Previous source, and nothing is
// written until the last step, so Cancel leaves the essay exactly as it was.
//
// useEssayFileDrop is the other half: it turns a drop on any part of the page into files
// and the role of the part they landed on, which a part names with data-drop-role.

import { useEffect, useRef, useState, type DragEvent } from "react";
import { PRIMARY_TYPES, PRIMARY_TYPE_LABEL, type PrimaryType } from "../lib/essaySources";
import { isImage } from "../lib/photos";
import { commitDrafts, readFileDetails, withFileDetails, type SourceDraft, type SourceRole } from "../lib/sourceIntake";
import { showToast } from "../lib/ui";
import { mimeFor } from "../lib/uploads";
import { Icon } from "./icons";
import { Sheet } from "./Sheet";

const FORM_ID = "essay-ws-intake-form";

const ROLES: { role: SourceRole; label: string }[] = [
  { role: "admin", label: "Admin" },
  { role: "primary", label: "Primary" },
  { role: "secondary", label: "Secondary" },
];

const WORK_KINDS: { value: SourceDraft["work_kind"]; label: string }[] = [
  { value: "article", label: "Journal article" },
  { value: "chapter", label: "Book chapter" },
  { value: "book", label: "Book" },
];

// What a primary source's details field asks for depends on its type, so that a
// newspaper is named as one and a speech is placed where it was given.
const PRIMARY_DETAILS: Record<PrimaryType, { label: string; placeholder: string }> = {
  image: { label: "Collection or archive", placeholder: "Such as the Imperial War Museum, or TNA INF 3" },
  newspaper: { label: "Newspaper", placeholder: "Such as The Times" },
  speech: { label: "Where it was given", placeholder: "Such as the House of Commons" },
  other: { label: "Details", placeholder: "Such as an archive reference" },
};

const revoke = (draft: SourceDraft) => {
  if (draft.thumb) URL.revokeObjectURL(draft.thumb);
};

function TextField({ label, value, onChange, placeholder, inputMode }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: "numeric";
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// A choice from a few, laid out in one tap rather than as a dropdown, as the group of a
// source added by hand is.
function Chips<T extends string>({ legend, name, value, options, onChange }: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <fieldset className="essay-ws-group-choice">
      <legend>{legend}</legend>
      <div className="essay-ws-group-options">
        {options.map((option) => (
          <label key={option.value} className="essay-ws-group-option">
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface SourceCardProps {
  // The sources to check. Ones added while the card is open, by another drop, join the end.
  drafts: SourceDraft[];
  // A new source or a set of them, or one already on the essay being edited again.
  mode: "add" | "edit";
  // The essay the sources are kept on.
  essay: { moduleId: string; moduleCode?: string; essayId?: string };
  // Cancel, the close button, Escape, a tap outside and the back gesture all end here.
  onClose: () => void;
  // Every source has been kept. A source that could not be stays on the card instead.
  onDone: (result: { added: number; updated: number }) => void;
}

export function SourceCard({ drafts, mode, essay, onClose, onDone }: SourceCardProps) {
  const [items, setItems] = useState<SourceDraft[]>(drafts);
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Which drafts the card has taken in and which have had their file read, so that a
  // draft already saved and taken off the card is never put back by a later drop.
  const seen = useRef(new Set(drafts.map((draft) => draft.key)));
  const detailed = useRef(new Set<string>());
  // What earlier attempts at saving kept, for the one result that onDone is given.
  const totals = useRef({ added: 0, updated: 0 });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The pictures are object URLs, so they are let go when the card is.
  useEffect(() => () => itemsRef.current.forEach(revoke), []);

  useEffect(() => {
    const extra = drafts.filter((draft) => !seen.current.has(draft.key));
    if (!extra.length) return;
    extra.forEach((draft) => seen.current.add(draft.key));
    setItems((current) => [...current, ...extra]);
  }, [drafts]);

  // The file itself adds its picture and what its details say, to fields still empty.
  useEffect(() => {
    for (const draft of items) {
      if (!draft.file || detailed.current.has(draft.key)) continue;
      detailed.current.add(draft.key);
      void readFileDetails(draft.file).then((details) => {
        if (!alive.current) {
          if (details.thumb) URL.revokeObjectURL(details.thumb);
          return;
        }
        setItems((current) => current.map((d) => (d.key === draft.key ? withFileDetails(d, details) : d)));
      });
    }
  }, [items]);

  const at = Math.min(index, items.length - 1);
  const draft = items[at];

  // Each step opens with the cursor in its first field.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input[type='text']")?.focus({ preventScroll: true });
  }, [at]);

  if (!draft) return null;

  const last = at === items.length - 1;
  const change = (patch: Partial<SourceDraft>) =>
    setItems((current) => current.map((d, i) => (i === at ? { ...d, ...patch, error: undefined } : d)));

  const close = () => {
    if (!savingRef.current) onClose();
  };

  // A double tap can only ever keep the sources once, because the button is disabled
  // from the first tap and a second call stops here as well.
  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await commitDrafts(essay, items);
      totals.current = { added: totals.current.added + result.added, updated: totals.current.updated + result.updated };
      if (!result.failed.length) {
        onDone(totals.current);
        return;
      }
      const failed = new Map(result.failed.map((f) => [f.key, f.message]));
      items.filter((d) => !failed.has(d.key)).forEach(revoke);
      if (!alive.current) return;
      setItems(items.filter((d) => failed.has(d.key)).map((d) => ({ ...d, error: failed.get(d.key) })));
      setIndex(0);
      const saved = result.added + result.updated;
      showToast(
        saved
          ? `Saved ${saved} ${saved === 1 ? "source" : "sources"}, but the others need attention, so their messages are on the card.`
          : "Nothing could be saved, so check the messages on the card.",
      );
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : "The sources could not be saved, so try again in a moment.");
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  const keep = mode === "edit" ? "Save details" : items.length === 1 ? "Add source" : `Add ${items.length} sources`;
  const details = PRIMARY_DETAILS[draft.primaryType];
  const sourceLabel = draft.work_kind === "chapter" ? "Book title" : draft.work_kind === "article" ? "Journal" : "Source";

  return (
    <Sheet
      open
      onClose={close}
      title={mode === "edit" ? "Edit details" : items.length === 1 ? "Add a source" : "Add sources"}
      className="essay-ws-intake-sheet"
      footer={
        <div className="essay-ws-sheet-actions">
          {items.length > 1 && (
            <span className="essay-ws-intake-count" role="status">
              {at + 1} of {items.length}
            </span>
          )}
          <button type="button" className="button quiet" disabled={saving} onClick={close}>
            Cancel
          </button>
          {at > 0 && (
            <button type="button" className="button" disabled={saving} onClick={() => setIndex(at - 1)}>
              Previous source
            </button>
          )}
          <button type="submit" form={FORM_ID} className="button primary" disabled={saving}>
            {saving ? "Saving" : last ? keep : "Next source"}
          </button>
        </div>
      }
    >
      <form
        id={FORM_ID}
        ref={form}
        className="essay-ws-intake"
        onSubmit={(event) => {
          event.preventDefault();
          if (last) void save();
          else setIndex(at + 1);
        }}
      >
        <div className="essay-ws-intake-thumb">
          <div className="essay-ws-intake-thumb-frame">
            {draft.thumb ? <img src={draft.thumb} alt="" /> : <Icon name="reading" size={32} />}
          </div>
          {draft.file && (
            <p className="essay-ws-intake-file" title={draft.file.name}>
              {draft.file.name}
            </p>
          )}
        </div>

        <div className="essay-ws-intake-fields">
          <div className="segmented essay-ws-intake-role" role="group" aria-label="What this source is">
            {ROLES.map(({ role, label }) => (
              <button
                key={role}
                type="button"
                className="tool"
                aria-pressed={draft.role === role}
                disabled={role === "admin" && Boolean(draft.customId)}
                title={role === "admin" && draft.customId ? "A source added by hand has no file, so it cannot be an admin document." : undefined}
                onClick={() => change({ role })}
              >
                {label}
              </button>
            ))}
          </div>

          {draft.role === "admin" && <TextField label="Name" value={draft.name} onChange={(name) => change({ name })} />}

          {draft.role === "primary" && (
            <>
              <Chips
                legend="Type"
                name={`${draft.key}-type`}
                value={draft.primaryType}
                options={PRIMARY_TYPES.map((value) => ({ value, label: PRIMARY_TYPE_LABEL[value] }))}
                onChange={(primaryType) => change({ primaryType })}
              />
              <div className="essay-ws-byhand-row">
                <TextField label="Creator" value={draft.author} onChange={(author) => change({ author })} placeholder="Churchill, Winston" />
                <TextField label="Date" value={draft.doc_date} onChange={(doc_date) => change({ doc_date })} placeholder="14 July 1789" />
              </div>
              <TextField label="Title" value={draft.title} onChange={(title) => change({ title })} />
              <TextField label={details.label} value={draft.source} onChange={(source) => change({ source })} placeholder={details.placeholder} />
              <TextField label="DOI or URL" value={draft.doi} onChange={(doi) => change({ doi })} placeholder="10.1080/... or https://..." />
            </>
          )}

          {draft.role === "secondary" && (
            <>
              <Chips
                legend="Kind"
                name={`${draft.key}-kind`}
                value={draft.work_kind}
                options={WORK_KINDS}
                onChange={(work_kind) => change({ work_kind })}
              />
              <div className="essay-ws-byhand-row">
                <TextField label="Author" value={draft.author} onChange={(author) => change({ author })} placeholder="Hobsbawm, Eric" />
                <TextField label="Year" value={draft.year} onChange={(year) => change({ year })} inputMode="numeric" />
              </div>
              <TextField label="Title" value={draft.title} onChange={(title) => change({ title })} />
              <div className="essay-ws-byhand-row">
                <TextField label={sourceLabel} value={draft.source} onChange={(source) => change({ source })} />
                <TextField label="Pages" value={draft.pages} onChange={(pages) => change({ pages })} />
              </div>
              <TextField label="DOI or URL" value={draft.doi} onChange={(doi) => change({ doi })} placeholder="10.1080/... or https://..." />
            </>
          )}

          {draft.role !== "admin" && (
            <p className="small muted">Any field can stay blank. Without a title, one is made from the others.</p>
          )}
          {draft.error && (
            <p className="small essay-ws-error" role="alert">
              {draft.error}
            </p>
          )}
        </div>
      </form>
    </Sheet>
  );
}

export interface EssayFileDrop {
  // Whether files are being dragged over the page, for marking the parts that take them.
  dragging: boolean;
  // The part they are over, or null where a drop would go to Secondary.
  overRole: SourceRole | null;
  // Spread onto the page's root.
  handlers: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

function roleAt(target: EventTarget | null): SourceRole | null {
  const found = target instanceof Element ? target.closest("[data-drop-role]")?.getAttribute("data-drop-role") : null;
  return found === "admin" || found === "primary" || found === "secondary" ? found : null;
}

// Documents, slides, videos and pictures can be sources. A folder, which a browser hands
// over as a file with no kind, and a recording of sound alone cannot.
const usable = (file: File) => {
  const mime = mimeFor(file);
  return (mime !== null && !mime.startsWith("audio/")) || isImage(file);
};

// A drop anywhere on the page gives onFiles the files it can use and the role of the part
// they landed on, Secondary where that part names none. The drop is claimed, so that the
// app's own "choose where these go" sheet does not also open, and what could not be used
// is said in a notice. A drop that something inside the page has already taken, such as a
// picture dropped into the plan's notes, is left to it, though the drag's marks still clear.
export function useEssayFileDrop(onFiles: (files: File[], role: SourceRole) => void): EssayFileDrop {
  const [dragging, setDragging] = useState(false);
  const [overRole, setOverRole] = useState<SourceRole | null>(null);
  // Entering a part of the page leaves the one around it, so the drag is counted in and out.
  const depth = useRef(0);
  const latest = useRef(onFiles);
  latest.current = onFiles;

  const reset = () => {
    depth.current = 0;
    setDragging(false);
    setOverRole(null);
  };

  return {
    dragging,
    overRole,
    handlers: {
      onDragEnter(event) {
        if (!hasFiles(event)) return;
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(event) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOverRole(roleAt(event.target));
      },
      onDragLeave(event) {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) reset();
      },
      onDrop(event) {
        if (!hasFiles(event)) return;
        const taken = event.defaultPrevented;
        event.preventDefault();
        reset();
        if (taken) return;
        const role = roleAt(event.target) ?? "secondary";
        const files = Array.from(event.dataTransfer.files);
        const kept = files.filter(usable);
        const left = files.length - kept.length;
        if (left) {
          showToast(`${left === 1 ? "One file was" : `${left} files were`} left out, because that kind of file cannot be a source.`);
        }
        if (kept.length) latest.current(kept, role);
      },
    },
  };
}
