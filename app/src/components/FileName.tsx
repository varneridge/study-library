import { splitFileName } from "../lib/names";

// Width-aware middle truncation in pure CSS. The filename is split into
// a shrinking head, a fixed tail of the stem, and the extension.
export function FileName({ name, className }: { name: string; className?: string }) {
  const { stem, ext } = splitFileName(name);
  const tail = stem.length > 8 ? stem.slice(-6) : "";
  const head = tail ? stem.slice(0, -6) : stem;
  return (
    <span className={`filename${className ? ` ${className}` : ""}`} title={name}>
      <span className="truncate">{head}</span>
      {tail && <span className="filename-fixed">{tail}</span>}
      {ext && <span className="filename-fixed">{ext}</span>}
    </span>
  );
}
