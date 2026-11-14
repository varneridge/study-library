// The floating toolbar that appears over selected text, shaped like Word's
// mini toolbar, and the block handle beside each paragraph, with BlockNote's
// "+" button taken away so the handle only drags. Works with BlockNote 0.44
// to 0.57: every API used here has the same shape in both.

import {
  BasicTextStyleButton, BlockTypeSelect, blockTypeSelectItems, ColorStyleButton, CreateLinkButton, DragHandleButton,
  FormattingToolbar, SideMenu, useBlockNoteEditor, useComponentsContext, useSelectedBlocks,
  type BlockTypeSelectItem, type SideMenuProps,
} from "@blocknote/react";
import { useMemo } from "react";
import { typeSelectItems, type NoteVariant } from "../lib/noteRules";

// blockTypeSelectItems takes the dictionary up to 0.5x and the editor after,
// and reading the wrong one throws at once, so try the newer form first.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultTypeItems(editor: any): BlockTypeSelectItem[] {
  const build = blockTypeSelectItems as unknown as (arg: unknown) => BlockTypeSelectItem[];
  try {
    return build(editor);
  } catch {
    return build(editor.dictionary);
  }
}

function Separator() {
  return <span className="nt-sep" aria-hidden="true" />;
}

const BULLET_ICON = (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor">
    <circle cx="4" cy="5" r="1.5" /><circle cx="4" cy="10" r="1.5" /><circle cx="4" cy="15" r="1.5" />
    <rect x="8" y="4.25" width="9" height="1.5" rx="0.75" /><rect x="8" y="9.25" width="9" height="1.5" rx="0.75" /><rect x="8" y="14.25" width="9" height="1.5" rx="0.75" />
  </svg>
);

const NUMBERED_ICON = (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor">
    <text x="1.5" y="7" fontSize="5.5" fontFamily="system-ui, sans-serif">1</text>
    <text x="1.5" y="12" fontSize="5.5" fontFamily="system-ui, sans-serif">2</text>
    <text x="1.5" y="17" fontSize="5.5" fontFamily="system-ui, sans-serif">3</text>
    <rect x="8" y="4.25" width="9" height="1.5" rx="0.75" /><rect x="8" y="9.25" width="9" height="1.5" rx="0.75" /><rect x="8" y="14.25" width="9" height="1.5" rx="0.75" />
  </svg>
);

// Turns the selected lines into a list, or back into normal text when they all
// already are that list, as Word's list buttons do. One undo step for all.
function ListButton({ type, label, icon }: { type: "bulletListItem" | "numberedListItem"; label: string; icon: React.ReactNode }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  const selected = useSelectedBlocks(editor);
  // Only blocks that hold text can become list items; quotations cannot.
  const blockSchema = editor.schema.blockSchema as Record<string, { content?: string }>;
  const lines = selected.filter((b) => blockSchema[b.type]?.content === "inline");
  if (!Components || !lines.length) return null;
  const active = lines.every((b) => b.type === type);
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      mainTooltip={label}
      label={label}
      icon={icon}
      isSelected={active}
      onClick={() => {
        editor.transact(() => {
          for (const block of lines) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            editor.updateBlock(block, { type: active ? "paragraph" : type } as any);
          }
        });
        editor.focus();
      }}
    />
  );
}

export function NotesFormattingToolbar({ variant }: { variant: NoteVariant }) {
  const editor = useBlockNoteEditor();
  const items = useMemo(() => typeSelectItems(variant, defaultTypeItems(editor)), [editor, variant]);

  if (variant === "reading") {
    return (
      <FormattingToolbar>
        <BasicTextStyleButton basicTextStyle="bold" key="bold" />
        <BasicTextStyleButton basicTextStyle="italic" key="italic" />
        <BasicTextStyleButton basicTextStyle="underline" key="underline" />
        <Separator key="sep" />
        <ListButton type="bulletListItem" label="Bullet list" icon={BULLET_ICON} key="bullets" />
        <ListButton type="numberedListItem" label="Numbered list" icon={NUMBERED_ICON} key="numbers" />
      </FormattingToolbar>
    );
  }

  return (
    <FormattingToolbar>
      <BlockTypeSelect items={items} key="type" />
      <Separator key="sep1" />
      <BasicTextStyleButton basicTextStyle="bold" key="bold" />
      <BasicTextStyleButton basicTextStyle="italic" key="italic" />
      <BasicTextStyleButton basicTextStyle="underline" key="underline" />
      <BasicTextStyleButton basicTextStyle="strike" key="strike" />
      <Separator key="sep2" />
      <ColorStyleButton key="colour" />
      <CreateLinkButton key="link" />
    </FormattingToolbar>
  );
}

// The block handle without BlockNote's "+" button: drag to move a paragraph,
// click for its menu. New lines come from Enter, or "/" for a block type.
export function DragOnlySideMenu(props: SideMenuProps) {
  return (
    <SideMenu {...props}>
      <DragHandleButton {...props} />
    </SideMenu>
  );
}
