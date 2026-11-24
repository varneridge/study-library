// The source picker: a small card beside the button that opened it, or a sheet from the
// foot of the screen on a phone, listing what the essay can cite, to link a reference or a
// footnote to one. It is built on a choice card, so it is a modal dialog with a visible
// Cancel, and Escape, a tap outside and the back gesture all close it. The list is the
// readings and sources chosen for this essay, in alphabetical order and narrowed by the
// search box. A reading with pages offers "Choose a passage", which opens it to highlight
// the words being cited, and any source can be cited as a whole.

import { useMemo, useState, type RefObject } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { essaySourcesOf, formatChicagoFootnote, useModuleAssessment } from "../lib/assessment";
import { db } from "../lib/db";
import { compareSourceTitles, filterSources, formatCustomFootnote, type SearchableSourceFields } from "../lib/essaySources";
import { isVideoMime } from "../lib/kinds";
import { moduleReadings } from "../lib/library";
import { fullTitle } from "../lib/titles";
import type { ItemRow } from "../lib/types";
import { ChoiceCard } from "./ChoiceCard";
import { SearchField } from "./SearchField";

export interface SourceChoice {
  kind: "whole" | "passage";
  sourceId: string;
  // The reading, when the source is one, which a passage is chosen in.
  item?: ItemRow;
  // The note as the source alone gives it, for the footnote that cites it.
  footnoteText: string;
}

export interface SourcePickerProps {
  open: boolean;
  onClose: () => void;
  // The button that opened it, which the card sits beside and returns focus to.
  anchor: RefObject<HTMLElement | null>;
  moduleId: string;
  moduleCode?: string;
  essayId?: string;
  title?: string;
  // Called with the choice, after which the card closes itself.
  onPick: (choice: SourceChoice) => void;
}

// One line of the list: a reading chosen for the essay, or a source held on it.
interface Entry extends SearchableSourceFields {
  key: string;
  id: string;
  title: string;
  label: string;
  sub: string;
  sortKey: string;
  item?: ItemRow;
  video: boolean;
  footnoteText: string;
}

function PickerBody({ moduleId, moduleCode, essayId, onPick }: Pick<SourcePickerProps, "moduleId" | "moduleCode" | "essayId"> & { onPick: (choice: SourceChoice) => void }) {
  const data = useModuleAssessment(moduleId, moduleCode, essayId);
  const [query, setQuery] = useState("");

  // The readings chosen for the essay, each with whether it is a video, which has no
  // pages to choose a passage from. A reading whose file is still waiting to upload is
  // told apart by its upload.
  const refIds = data.referenceItemIds.join(",");
  const readings = useLiveQuery(
    async () => {
      const chosen = new Set(data.referenceItemIds);
      const items = (await moduleReadings(moduleId, data.referenceItemIds)).filter((item) => chosen.has(item.id));
      return Promise.all(
        items.map(async (item) => {
          const file = item.file_id ? await db.files.get(item.file_id) : undefined;
          const upload = file ? undefined : await db.uploads.where("item_id").equals(item.id).first();
          return { item, video: isVideoMime(file?.mime ?? upload?.mime) };
        }),
      );
    },
    [moduleId, refIds],
    [],
  );

  const entries = useMemo(() => {
    const list: Entry[] = readings.map(({ item, video }) => {
      const label = fullTitle(item);
      return {
        key: `reading:${item.id}`,
        id: item.id,
        title: item.title,
        author: item.author,
        year: item.year,
        publisher: item.publisher,
        notes: item.source,
        label,
        sub: video ? "A video, so it can only be cited as a whole." : "",
        sortKey: label,
        item,
        video,
        footnoteText: formatChicagoFootnote(item),
      };
    });
    for (const source of essaySourcesOf(data)) {
      list.push({
        key: `source:${source.id}`,
        id: source.id,
        title: source.title,
        author: source.author,
        year: source.year,
        publisher: source.publisher,
        notes: source.notes,
        label: [source.author?.trim(), source.title].filter(Boolean).join(", "),
        sub: [source.publisher?.trim(), source.year?.trim()].filter(Boolean).join(", "),
        sortKey: [source.author?.trim(), source.title].filter(Boolean).join(", "),
        video: false,
        footnoteText: formatCustomFootnote(source),
      });
    }
    return list.sort((a, b) => compareSourceTitles(a.sortKey, b.sortKey));
  }, [readings, data]);

  const shown = useMemo(() => filterSources(entries, { query }), [entries, query]);

  const choose = (entry: Entry, kind: SourceChoice["kind"]) =>
    onPick({
      kind,
      sourceId: entry.id,
      ...(entry.item ? { item: entry.item } : {}),
      footnoteText: entry.footnoteText,
    });

  return (
    <>
      <SearchField value={query} onChange={setQuery} label="Search sources" placeholder="Search readings and sources" className="essay-ws-pick-search" />
      {entries.length === 0 ? (
        <p className="small muted essay-ws-pick-empty">This essay has no readings or sources yet, so add some to it first.</p>
      ) : shown.length === 0 ? (
        <p className="small muted essay-ws-pick-empty">{`No readings or sources match \u201c${query.trim()}\u201d.`}</p>
      ) : (
        <ul className="essay-ws-pick-list">
          {shown.map((entry) => (
            <li key={entry.key} className="essay-ws-pick-row">
              <div className="essay-ws-pick-main">
                <span className="essay-ws-pick-title">{entry.label}</span>
                {entry.sub && <span className="essay-ws-pick-sub">{entry.sub}</span>}
              </div>
              <div className="essay-ws-pick-actions">
                {entry.item && !entry.video && (
                  <button type="button" className="button small" onClick={() => choose(entry, "passage")}>
                    Choose a passage
                  </button>
                )}
                <button type="button" className="button quiet small" onClick={() => choose(entry, "whole")}>
                  Cite the whole source
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SourcePicker({ open, onClose, anchor, moduleId, moduleCode, essayId, title = "Choose a source", onPick }: SourcePickerProps) {
  return (
    <ChoiceCard
      open={open}
      onClose={onClose}
      anchor={anchor}
      label={title}
      title={<h3 className="choice-title">{title}</h3>}
      className="essay-ws-pick"
      initialFocus="input[type='search']"
    >
      <PickerBody
        moduleId={moduleId}
        moduleCode={moduleCode}
        essayId={essayId}
        onPick={(choice) => {
          onPick(choice);
          onClose();
        }}
      />
    </ChoiceCard>
  );
}
