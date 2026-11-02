import { convertToDissertation } from "../lib/sections";
import { useRef, useState } from "react";
import { blockText } from "../lib/notes";
import { deleteModule, setReadingWeek, withUndo } from "../lib/edits";
import { TERMS, WEEK_NUMBERS, weekCode } from "../lib/modules";
import { navigate } from "../lib/router";
import { newId, update } from "../lib/sync";
import type { Block, ModuleRow, WeekRow } from "../lib/types";
import { confirmAction, showToast, useCloseOnBack } from "../lib/ui";
import { uploadModulePicture } from "../lib/uploads";

function toText(blocks: Block[] | null): string {
  return (blocks ?? []).map(blockText).join("\n\n");
}

function toBlocks(text: string): Block[] | null {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return null;
  return paragraphs.map((p) => ({
    id: newId(), type: "paragraph", props: {}, children: [],
    content: [{ type: "text", text: p, styles: {} }],
  }));
}

// Editing a module: its code, title, description and reading weeks, and
// deleting it.
export function ModuleSettings({ module, weeks, onClose }: { module: ModuleRow; weeks: WeekRow[]; onClose: () => void }) {
  useCloseOnBack(true, onClose);
  const convert = async () => {
    const ok = await confirmAction({
      title: `Change ${module.code} to a dissertation?`,
      body: "Its weeks give way to sections. Each week with readings, notes, questions or recordings becomes a section named after it, such as AT3, which you can rename. Weeks with nothing in them are removed. Nothing you have written or added is lost.",
      confirm: "Change to a dissertation",
    });
    if (!ok) return;
    await convertToDissertation(module);
    onClose();
  };
  const [code, setCode] = useState(module.code);
  const [title, setTitle] = useState(module.title ?? "");
  const original = toText(module.description);
  const [description, setDescription] = useState(original);
  const [busy, setBusy] = useState(false);
  const [imageKey, setImageKey] = useState<string | null>(module.image_key ?? null);
  const [pictureBusy, setPictureBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickSeq = useRef(0);

  async function onPickPicture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    pickSeq.current += 1;
    const current = pickSeq.current;
    setPictureBusy(true);

    try {
      const key = await uploadModulePicture(file);
      if (current !== pickSeq.current) return;
      await update("modules", module.id, { image_key: key });
      setImageKey(key);
      showToast("Picture updated.");
    } catch (err) {
      if (current === pickSeq.current) {
        showToast(err instanceof Error ? err.message : "The picture could not be added.");
      }
    } finally {
      if (current === pickSeq.current) {
        setPictureBusy(false);
      }
    }
  }

  async function removePicture() {
    if (!imageKey) return;
    pickSeq.current += 1;
    setPictureBusy(true);
    const prev = imageKey;
    try {
      setImageKey(null);
      await update("modules", module.id, { image_key: null });
      showToast("Picture removed.", {
        label: "Undo",
        run: async () => {
          await update("modules", module.id, { image_key: prev });
          setImageKey(prev);
        },
      });
    } finally {
      setPictureBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    try {
      await update("modules", module.id, {
        code: code.trim(),
        title: title.trim() || null,
        ...(description !== original ? { description: toBlocks(description) } : {}),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function toggleWeek(week: WeekRow) {
    setBusy(true);
    const { kept } = await setReadingWeek(week, module, !week.is_reading_week);
    setBusy(false);
    if (kept) {
      showToast(`${weekCode(week)} is now a reading week. ${kept === 1 ? "One session" : `${kept} sessions`} with notes or recordings stayed.`);
    }
  }

  async function remove() {
    const ok = await confirmAction({
      title: `Delete ${module.code}?`,
      body: "Its weeks, readings, highlights, notes and recordings go with it. You can restore it from Settings for 90 days.",
      confirm: "Delete module",
      danger: true,
      typed: module.code,
    });
    if (!ok) return;
    await withUndo(`${module.code} deleted.`, deleteModule(module));
    navigate({ view: "home" });
  }

  return (
    <form className="editor section" style={{ marginTop: "1rem" }} onSubmit={save}>
      <div className="row">
        <label className="field" style={{ flex: "0 0 9rem" }}>
          <span>Code</span>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} required />
        </label>
        <label className="field" style={{ flex: 1, minWidth: "14rem" }}>
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>About this module</span>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Convenor, assessment, anything worth keeping to hand. A blank line starts a new paragraph." />
      </label>
      <div className="row">
        <button className="button primary" disabled={busy || !code.trim()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="quiet" onClick={onClose} disabled={busy}>Cancel</button>
      </div>

      <div className="field" style={{ marginTop: "1.5rem" }}>
        <span>Cover picture</span>
        <p className="small muted" style={{ margin: "0.2rem 0 0.5rem" }}>
          Shown on the card for this module on the home page. Cropped to 16:9.
        </p>
        <div className="module-settings-picture">
          {imageKey ? (
            <div className="module-picture-preview">
              <img
                src={imageKey.startsWith("pictures/") ? `/api/${imageKey}` : `/api/pictures/${imageKey}`}
                alt=""
              />
            </div>
          ) : (
            <div className="module-picture-placeholder">
              <span>No picture chosen</span>
            </div>
          )}
          <div className="row" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
            <button
              type="button"
              className="button"
              disabled={pictureBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {pictureBusy ? "Processing…" : imageKey ? "Change picture" : "Choose picture"}
            </button>
            {imageKey && (
              <button
                type="button"
                className="quiet"
                disabled={pictureBusy}
                onClick={removePicture}
              >
                Remove picture
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={onPickPicture}
          />
        </div>
      </div>

      {module.kind !== "dissertation" && (
      <div className="field" style={{ marginTop: "1.5rem" }}>
        <span>Reading weeks</span>
        <p className="small muted" style={{ margin: "0 0 0.5rem" }}>
          Changes save straight away. A reading week keeps its readings and loses its empty sessions.
        </p>
        <div className="picker" role="group" aria-label="Reading weeks">
          {TERMS.map((term) => (
            <div key={term} style={{ display: "contents" }}>
              <span>{term}</span>
              {WEEK_NUMBERS.map((n) => {
                const week = weeks.find((w) => w.term === term && w.number === n);
                if (!week) return <span key={n} />;
                return (
                  <button type="button" key={n} disabled={busy} aria-pressed={week.is_reading_week} onClick={() => toggleWeek(week)}>{n}</button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      )}
      {module.kind !== "dissertation" && (
        <div className="field" style={{ marginTop: "1.5rem" }}>
          <span>Organise by sections instead</span>
          <p className="small muted" style={{ margin: "0.2rem 0 0.5rem" }}>
            For a dissertation: sections you name and order, key dates, and supervision meetings. Every week with something
            in it becomes a section named after it, to rename or merge; empty weeks go.
          </p>
          <div><button type="button" className="button" onClick={convert}>Change to a dissertation</button></div>
        </div>
      )}

      <div className="field" style={{ marginTop: "1.5rem" }}>
        <span>Delete this module</span>
        <div><button type="button" className="button danger" onClick={remove}>Delete {module.code}</button></div>
      </div>
    </form>
  );
}
