// Native OpenXML (.docx) reader, writer, word counter and text extractor.
// Produces genuine Microsoft Word documents with native footnotes (word/footnotes.xml)
// and review comments (word/comments.xml + word/commentsExtended.xml), and reads
// them back without losing footnotes, comments or formatting.

import { createZip, type ZipEntry } from "./zip";

export interface DocxRun {
  type: "text" | "footnote_ref";
  text?: string;
  footnoteId?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  highlight?: string;
  commentIds?: string[];
}

export type DocxBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "blockquote"
  | "bullet"
  | "ordered"
  | "page_break";

export interface DocxBlock {
  id: string;
  type: DocxBlockType;
  align?: "left" | "center" | "right" | "both";
  runs: DocxRun[];
}

export interface DocxFootnote {
  id: string;
  text: string;
  citationItemId?: string | null;
  locator?: string | null;
}

export interface DocxComment {
  id: string;
  author: string;
  date: string;
  text: string;
  resolved?: boolean;
}

export interface DocxSettings {
  font?: "Times New Roman" | "Literata";
  fontSizePt?: number;
  lineSpacing?: 1.15 | 1.5 | 2;
  includeFootnotesInCount?: boolean;
  includeQuotesInCount?: boolean;
}

export interface DocxDocument {
  blocks: DocxBlock[];
  footnotes: DocxFootnote[];
  comments: DocxComment[];
  settings?: DocxSettings;
}

export interface WordCountBreakdown {
  body: number;
  quotes: number;
  footnotes: number;
  total: number;
}

const MAX_ZIP_ENTRIES = 500;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

// Strips characters illegal in XML 1.0 (such as U+000B vertical tab) and escapes XML entities.
export function cleanXmlText(input: string): string {
  // Remove XML 1.0 disallowed control chars and lone surrogates
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd)
    ) {
      out += input[i];
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i++;
      }
    }
  }
  return out;
}

export function escapeXml(input: string): string {
  return cleanXmlText(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function decodeXmlEntities(input: string): string {
  const safeCodePoint = (cp: number): string => {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "\uFFFD";
    try {
      return String.fromCodePoint(cp);
    } catch {
      return "\uFFFD";
    }
  };
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function wordsInString(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

// Word-compatible whitespace word counter with toggles for footnotes and blockquotes.
export function countDocxWords(doc: DocxDocument): WordCountBreakdown {
  let body = 0;
  let quotes = 0;
  const referencedFootnoteIds = new Set<string>();

  for (const block of doc.blocks) {
    if (block.type === "page_break") continue;
    let blockText = "";
    for (const run of block.runs) {
      if (run.type === "text" && run.text) {
        blockText += run.text;
      } else if (run.type === "footnote_ref" && run.footnoteId) {
        referencedFootnoteIds.add(run.footnoteId);
      }
    }
    const count = wordsInString(blockText);
    if (block.type === "blockquote") {
      quotes += count;
    } else {
      body += count;
    }
  }

  let footnotes = 0;
  for (const fn of doc.footnotes) {
    if (referencedFootnoteIds.has(fn.id) || referencedFootnoteIds.size === 0) {
      footnotes += wordsInString(fn.text);
    }
  }

  const includeQuotes = doc.settings?.includeQuotesInCount !== false;
  const includeFootnotes = doc.settings?.includeFootnotesInCount !== false;
  const total = body + (includeQuotes ? quotes : 0) + (includeFootnotes ? footnotes : 0);

  return { body, quotes, footnotes, total };
}

// Computes 1-based footnote numbers in strict document order.
export function computeFootnoteNumbers(doc: DocxDocument): Map<string, number> {
  const map = new Map<string, number>();
  let seq = 1;
  for (const block of doc.blocks) {
    for (const run of block.runs) {
      if (run.type === "footnote_ref" && run.footnoteId && !map.has(run.footnoteId)) {
        map.set(run.footnoteId, seq++);
      }
    }
  }
  for (const fn of doc.footnotes) {
    if (!map.has(fn.id)) {
      map.set(fn.id, seq++);
    }
  }
  return map;
}

function paraIdHex(index: number): string {
  // 8-digit uppercase hex strictly below 0x80000000 per MS-DOCX spec
  const val = ((index + 1) * 0x1045) & 0x7fffffff;
  return val.toString(16).toUpperCase().padStart(8, "0");
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function buildTextRunsXml(text: string, rPrXml: string): string {
  // Handle tabs and line breaks inside text runs while preserving spaces
  const clean = cleanXmlText(text);
  const parts = clean.split(/(\t|\n)/);
  let xml = `<w:r>${rPrXml}`;
  let hasContent = false;
  for (const part of parts) {
    if (part === "\t") {
      xml += `<w:tab/>`;
      hasContent = true;
    } else if (part === "\n") {
      xml += `<w:br/>`;
      hasContent = true;
    } else if (part.length > 0) {
      xml += `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
      hasContent = true;
    }
  }
  if (!hasContent) {
    xml += `<w:t xml:space="preserve"></w:t>`;
  }
  xml += `</w:r>`;
  return xml;
}

export function toDocxBytes(
  doc: DocxDocument,
  options?: { title?: string; author?: string; excludeResolvedComments?: boolean },
): Uint8Array {
  const font = doc.settings?.font ?? "Times New Roman";
  const sizeHalfPt = Math.round((doc.settings?.fontSizePt ?? 12) * 2);
  const spacing = doc.settings?.lineSpacing ?? 1.5;
  const lineTwips = spacing === 2 ? 480 : spacing === 1.15 ? 276 : 360;

  // Collect ordered footnotes referenced in the document (plus any unreferenced in doc.footnotes)
  const fnById = new Map(doc.footnotes.map((f) => [f.id, f]));
  const orderedFootnotes: { id: string; num: number; fn: DocxFootnote }[] = [];
  const fnNumById = new Map<string, number>();

  for (const block of doc.blocks) {
    for (const run of block.runs) {
      if (run.type === "footnote_ref" && run.footnoteId && !fnNumById.has(run.footnoteId)) {
        const fn = fnById.get(run.footnoteId) ?? { id: run.footnoteId, text: "" };
        const num = orderedFootnotes.length + 1;
        fnNumById.set(run.footnoteId, num);
        orderedFootnotes.push({ id: run.footnoteId, num, fn });
      }
    }
  }
  for (const fn of doc.footnotes) {
    if (!fnNumById.has(fn.id)) {
      const num = orderedFootnotes.length + 1;
      fnNumById.set(fn.id, num);
      orderedFootnotes.push({ id: fn.id, num, fn });
    }
  }

  // Filter comments to those not excluded by resolved state AND that have an anchor in the document
  const candidateComments = doc.comments.filter(
    (c) => !(options?.excludeResolvedComments && c.resolved),
  );
  const candidateSet = new Set(candidateComments.map((c) => c.id));

  // Track first and last run index globally for each comment ID so we emit exactly one
  // commentRangeStart before the first fragment and one commentRangeEnd + commentReference after the last.
  const firstRunForComment = new Map<string, string>();
  const lastRunForComment = new Map<string, string>();

  doc.blocks.forEach((block, bIdx) => {
    if (block.type === "page_break") return;
    block.runs.forEach((run, rIdx) => {
      const key = `${bIdx}:${rIdx}`;
      for (const cid of run.commentIds ?? []) {
        if (!candidateSet.has(cid)) continue;
        if (!firstRunForComment.has(cid)) firstRunForComment.set(cid, key);
        lastRunForComment.set(cid, key);
      }
    });
  });

  const activeComments = candidateComments.filter((c) => firstRunForComment.has(c.id));
  const commentNumById = new Map<string, number>();
  activeComments.forEach((c, idx) => commentNumById.set(c.id, idx + 1));

  // Track separate ordered lists so each restarts at 1
  let orderedListNumId = 1; // numId 1 = bullet list, numId 2+ = ordered lists
  const listNums: number[] = [];
  let inOrderedList = false;

  let bodyXml = "";

  doc.blocks.forEach((block, bIdx) => {
    if (block.type === "ordered") {
      if (!inOrderedList) {
        orderedListNumId += 1;
        listNums.push(orderedListNumId);
        inOrderedList = true;
      }
    } else {
      inOrderedList = false;
    }

    if (block.type === "page_break") {
      bodyXml += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
      return;
    }

    let pPr = "";
    if (block.type === "heading1") pPr += `<w:pStyle w:val="Heading1"/>`;
    else if (block.type === "heading2") pPr += `<w:pStyle w:val="Heading2"/>`;
    else if (block.type === "heading3") pPr += `<w:pStyle w:val="Heading3"/>`;
    else if (block.type === "blockquote") pPr += `<w:pStyle w:val="Quote"/>`;
    else if (block.type === "bullet") {
      pPr += `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`;
    } else if (block.type === "ordered") {
      pPr += `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${orderedListNumId}"/></w:numPr>`;
    }

    if (block.align && block.align !== "left") {
      pPr += `<w:jc w:val="${block.align}"/>`;
    }

    let runsXml = "";
    block.runs.forEach((run, rIdx) => {
      const key = `${bIdx}:${rIdx}`;
      const startingComments = (run.commentIds ?? []).filter((cid) => firstRunForComment.get(cid) === key);
      const endingComments = (run.commentIds ?? []).filter((cid) => lastRunForComment.get(cid) === key);

      for (const cid of startingComments) {
        const cNum = commentNumById.get(cid);
        if (cNum !== undefined) runsXml += `<w:commentRangeStart w:id="${cNum}"/>`;
      }

      if (run.type === "footnote_ref" && run.footnoteId) {
        const fnNum = fnNumById.get(run.footnoteId);
        if (fnNum !== undefined) {
          runsXml += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnNum}"/></w:r>`;
        }
      } else {
        let rPr = "";
        if (run.bold) rPr += `<w:b/>`;
        if (run.italic) rPr += `<w:i/>`;
        if (run.strike) rPr += `<w:strike/>`;
        if (run.highlight) rPr += `<w:highlight w:val="${escapeXml(run.highlight)}"/>`;
        if (run.underline) rPr += `<w:u w:val="single"/>`;
        const rPrTag = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";
        runsXml += buildTextRunsXml(run.text ?? "", rPrTag);
      }

      for (const cid of endingComments) {
        const cNum = commentNumById.get(cid);
        if (cNum !== undefined) {
          runsXml += `<w:commentRangeEnd w:id="${cNum}"/>`;
          runsXml += `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${cNum}"/></w:r>`;
        }
      }
    });

    bodyXml += `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runsXml}</w:p>`;
  });

  // A4 page dimensions (11906 x 16838 twips) and 1-inch margins (1440 twips)
  const sectPrXml = `<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyXml}${sectPrXml}</w:body>
</w:document>`;

  // word/footnotes.xml with mandatory separator (-1) and continuationSeparator (0)
  let footnotesXmlItems = `
  <w:footnote w:type="separator" w:id="-1">
    <w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p>
  </w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0">
    <w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p>
  </w:footnote>`;

  for (const { num, fn } of orderedFootnotes) {
    const cleanFnText = cleanXmlText(fn.text ?? "");
    footnotesXmlItems += `
  <w:footnote w:id="${num}">
    <w:p>
      <w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>
      <w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>
      <w:r><w:t xml:space="preserve"> ${escapeXml(cleanFnText)}</w:t></w:r>
    </w:p>
  </w:footnote>`;
  }

  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${footnotesXmlItems}
</w:footnotes>`;

  // word/comments.xml and word/commentsExtended.xml
  let commentsXmlItems = "";
  let commentsExtXmlItems = "";
  activeComments.forEach((c, idx) => {
    const cNum = idx + 1;
    const pId = paraIdHex(idx);
    const isoDate = (c.date || new Date().toISOString()).replace(/\.\d+Z$/, "Z");
    const author = escapeXml(c.author || "Reviewer");
    commentsXmlItems += `
  <w:comment w:id="${cNum}" w:author="${author}" w:date="${escapeXml(isoDate)}" w:initials="${escapeXml((c.author || "R").slice(0, 2).toUpperCase())}">
    <w:p w14:paraId="${pId}">
      <w:pPr><w:pStyle w:val="CommentText"/></w:pPr>
      <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>
      <w:r><w:t xml:space="preserve"> ${escapeXml(c.text)}</w:t></w:r>
    </w:p>
  </w:comment>`;
    commentsExtXmlItems += `
  <w15:commentEx w15:paraId="${pId}" w15:done="${c.resolved ? "1" : "0"}"/>`;
  });

  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">${commentsXmlItems}
</w:comments>`;

  const commentsExtendedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15">${commentsExtXmlItems}
</w15:commentsEx>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:cs="${escapeXml(font)}"/>
        <w:sz w:val="${sizeHalfPt}"/>
        <w:szCs w:val="${sizeHalfPt}"/>
        <w:lang w:val="en-GB"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160" w:line="${lineTwips}" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:ind w:left="720" w:right="720"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:ind w:left="720"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="FootnoteText">
    <w:name w:val="footnote text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="FootnoteReference">
    <w:name w:val="footnote reference"/>
    <w:rPr><w:vertAlign w:val="superscript"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CommentText">
    <w:name w:val="annotation text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="CommentReference">
    <w:name w:val="annotation reference"/>
    <w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>
  </w:style>
</w:styles>`;

  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnotePr>
    <w:footnote w:id="-1"/>
    <w:footnote w:id="0"/>
  </w:footnotePr>
</w:settings>`;

  let orderedNumsXml = "";
  for (const numId of listNums) {
    orderedNumsXml += `
  <w:num w:numId="${numId}">
    <w:abstractNumId w:val="1"/>
    <w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>
  </w:num>`;
  }

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="•"/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>${orderedNumsXml}
</w:numbering>`;

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(options?.title ?? "Essay Draft")}</dc:title>
  <dc:creator>${escapeXml(options?.author ?? "Study Library")}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  <Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: encodeUtf8(contentTypesXml) },
    { name: "_rels/.rels", data: encodeUtf8(rootRelsXml) },
    { name: "docProps/core.xml", data: encodeUtf8(coreXml) },
    { name: "word/document.xml", data: encodeUtf8(documentXml) },
    { name: "word/_rels/document.xml.rels", data: encodeUtf8(docRelsXml) },
    { name: "word/styles.xml", data: encodeUtf8(stylesXml) },
    { name: "word/settings.xml", data: encodeUtf8(settingsXml) },
    { name: "word/numbering.xml", data: encodeUtf8(numberingXml) },
    { name: "word/footnotes.xml", data: encodeUtf8(footnotesXml) },
    { name: "word/comments.xml", data: encodeUtf8(commentsXml) },
    { name: "word/commentsExtended.xml", data: encodeUtf8(commentsExtendedXml) },
  ];

  return createZip(entries);
}

export function toDocxBlob(
  doc: DocxDocument,
  options?: { title?: string; author?: string; excludeResolvedComments?: boolean },
): Blob {
  const bytes = toDocxBytes(doc, options);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// Decompress raw DEFLATE bytes using browser DecompressionStream without leaking unhandled rejections.
async function inflateRaw(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("ZIP entry exceeded safety byte limit during decompression.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  throw new Error("DecompressionStream is not supported in this environment.");
}

// Reads entries from a ZIP archive via its Central Directory.
export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate End of Central Directory (0x06054b50) scanning backwards
  let eocdOffset = -1;
  const minEocd = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Not a valid ZIP or DOCX archive.");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`Archive contains too many entries (${totalEntries}).`);
  }
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = new Map<string, Uint8Array>();
  let ptr = centralDirOffset;
  let actualTotalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > bytes.byteLength || view.getUint32(ptr, true) !== 0x02014b50) {
      break;
    }
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const name = decodeUtf8(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    // Skip embedded media binaries not needed for text/footnote/comment AST
    if (name.startsWith("word/media/")) {
      continue;
    }

    if (uncompSize > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("Archive entry exceeds maximum uncompressed size limit.");
    }

    if (localHeaderOffset + 30 > bytes.byteLength || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      continue;
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = bytes.subarray(dataStart, dataStart + compSize);

    const remainingBudget = MAX_UNCOMPRESSED_BYTES - actualTotalUncompressed;
    if (remainingBudget <= 0) {
      throw new Error("Archive exceeds maximum uncompressed size limit.");
    }

    if (method === 0) {
      actualTotalUncompressed += rawSlice.byteLength;
      if (actualTotalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error("Archive exceeds maximum uncompressed size limit.");
      }
      entries.set(name, rawSlice);
    } else if (method === 8) {
      const inflated = await inflateRaw(rawSlice, remainingBudget);
      actualTotalUncompressed += inflated.byteLength;
      entries.set(name, inflated);
    }
  }

  return entries;
}

function getAttr(tagOpen: string, attrLocalName: string): string | null {
  const re = new RegExp(`(?:^|\\s|[a-zA-Z0-9_]+:)${attrLocalName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(tagOpen);
  if (!m) return null;
  return decodeXmlEntities(m[1] ?? m[2] ?? "");
}

function isToggleOff(tagOpen: string): boolean {
  const val = getAttr(tagOpen, "val")?.toLowerCase();
  return val === "0" || val === "false" || val === "off" || val === "none";
}

function parseParagraphXml(
  pInner: string,
  fnIdMap: Map<string, string>,
  activeCommentsSet: Set<string>,
  commentIdMap: Map<string, string>,
  bulletNumIds: Set<string>,
): { type: DocxBlockType; align?: "left" | "center" | "right" | "both"; runs: DocxRun[] } {
  let type: DocxBlockType = "paragraph";
  let align: "left" | "center" | "right" | "both" | undefined;

  // Check paragraph properties <w:pPr>...</w:pPr>
  const pPrMatch = /<(?:\w+:)?pPr\b[^>]*>([\s\S]*?)<\/(?:\w+:)?pPr>/.exec(pInner);
  if (pPrMatch) {
    // Strip tracked-change property history <w:pPrChange>...</w:pPrChange>
    const pPr = pPrMatch[1].replace(/<(?:\w+:)?pPrChange\b[\s\S]*?<\/(?:\w+:)?pPrChange>/g, "");
    const styleMatch = /<(?:\w+:)?pStyle\b[^>]*>/.exec(pPr);
    const styleVal = styleMatch ? (getAttr(styleMatch[0], "val") ?? "").toLowerCase() : "";
    const outlineMatch = /<(?:\w+:)?outlineLvl\b[^>]*>/.exec(pPr);
    const outlineVal = outlineMatch ? getAttr(outlineMatch[0], "val") : null;

    if (styleVal.includes("heading1") || styleVal === "heading 1" || outlineVal === "0") {
      type = "heading1";
    } else if (styleVal.includes("heading2") || styleVal === "heading 2" || outlineVal === "1") {
      type = "heading2";
    } else if (styleVal.includes("heading3") || styleVal === "heading 3" || outlineVal === "2") {
      type = "heading3";
    } else if (styleVal.includes("quote")) {
      type = "blockquote";
    }

    const numIdMatch = /<(?:\w+:)?numId\b[^>]*>/.exec(pPr);
    if (numIdMatch) {
      const numId = getAttr(numIdMatch[0], "val") ?? "0";
      if (numId !== "0") {
        type = bulletNumIds.has(numId) ? "bullet" : "ordered";
      }
    }

    const jcMatch = /<(?:\w+:)?jc\b[^>]*>/.exec(pPr);
    if (jcMatch) {
      const jc = getAttr(jcMatch[0], "val");
      if (jc === "center" || jc === "right" || jc === "both" || jc === "left") {
        align = jc;
      }
    }
  }

  // Strip self-closing <w:del .../> (e.g. deleted paragraph mark inside w:pPr/w:rPr) BEFORE paired <w:del>...</w:del>
  const cleaned = pInner
    .replace(/<(?:\w+:)?pPr\b[^>]*>[\s\S]*?<\/(?:\w+:)?pPr>/g, "")
    .replace(/<(?:\w+:)?del\b[^>]*\/>/g, "")
    .replace(/<(?:\w+:)?del\b[^>]*>[\s\S]*?<\/(?:\w+:)?del>/g, "");

  // Check for standalone page break paragraph
  if (/<(?:\w+:)?br\b[^>]*w:type\s*=\s*["']page["'][^>]*\/?>/.test(cleaned)) {
    const textCheck = cleaned.replace(/<[^>]+>/g, "").trim();
    if (!textCheck) {
      return { type: "page_break", runs: [] };
    }
  }

  const runs: DocxRun[] = [];
  let inFieldInstruction = false;

  // Tokenise top-level comment range markers and runs in order
  const tokenRe =
    /<(?:\w+:)?commentRangeStart\b[^>]*\/?>|<(?:\w+:)?commentRangeEnd\b[^>]*\/?>|<(?:\w+:)?r\b[^>]*>[\s\S]*?<\/(?:\w+:)?r>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(cleaned)) !== null) {
    const token = m[0];
    if (/^<(?:\w+:)?commentRangeStart\b/.test(token)) {
      const rawId = getAttr(token, "id");
      const mapped = rawId ? commentIdMap.get(rawId) : undefined;
      if (mapped) activeCommentsSet.add(mapped);
      continue;
    }
    if (/^<(?:\w+:)?commentRangeEnd\b/.test(token)) {
      const rawId = getAttr(token, "id");
      const mapped = rawId ? commentIdMap.get(rawId) : undefined;
      if (mapped) activeCommentsSet.delete(mapped);
      continue;
    }

    // Complex field state machine (w:fldChar begin -> separate -> end)
    const fldCharMatch = /<(?:\w+:)?fldChar\b[^>]*>/.exec(token);
    if (fldCharMatch) {
      const fldType = getAttr(fldCharMatch[0], "fldCharType");
      if (fldType === "begin") inFieldInstruction = true;
      else if (fldType === "separate" || fldType === "end") inFieldInstruction = false;
    }
    if (inFieldInstruction || /<(?:\w+:)?instrText\b/.test(token)) {
      continue;
    }

    // Footnote reference
    const fnRefMatch = /<(?:\w+:)?footnoteReference\b[^>]*>/.exec(token);
    if (fnRefMatch) {
      const rawFnId = getAttr(fnRefMatch[0], "id");
      if (rawFnId && rawFnId !== "-1" && rawFnId !== "0") {
        let fnId = fnIdMap.get(rawFnId);
        if (!fnId) {
          fnId = `fn-${rawFnId}`;
          fnIdMap.set(rawFnId, fnId);
        }
        runs.push({
          type: "footnote_ref",
          footnoteId: fnId,
          ...(activeCommentsSet.size > 0 ? { commentIds: [...activeCommentsSet] } : {}),
        });
      }
      continue;
    }

    // Run formatting <w:rPr>
    let bold = false;
    let italic = false;
    let underline = false;
    let strike = false;
    let highlight: string | undefined;

    const rPrMatch = /<(?:\w+:)?rPr\b[^>]*>([\s\S]*?)<\/(?:\w+:)?rPr>/.exec(token);
    if (rPrMatch) {
      const rPr = rPrMatch[1];
      const bTag = /<(?:\w+:)?b\b[^>]*>/.exec(rPr);
      if (bTag && !isToggleOff(bTag[0])) bold = true;
      const iTag = /<(?:\w+:)?i\b[^>]*>/.exec(rPr);
      if (iTag && !isToggleOff(iTag[0])) italic = true;
      const uTag = /<(?:\w+:)?u\b[^>]*>/.exec(rPr);
      if (uTag && !isToggleOff(uTag[0])) underline = true;
      const sTag = /<(?:\w+:)?strike\b[^>]*>/.exec(rPr);
      if (sTag && !isToggleOff(sTag[0])) strike = true;
      const hlTag = /<(?:\w+:)?highlight\b[^>]*>/.exec(rPr);
      if (hlTag && !isToggleOff(hlTag[0])) {
        highlight = getAttr(hlTag[0], "val") ?? "yellow";
      }
    }

    // Extract text, tabs and breaks inside the run
    let runText = "";
    const innerRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?tab\b[^>]*\/?>|<(?:\w+:)?br\b[^>]*\/?>/g;
    let im: RegExpExecArray | null;
    while ((im = innerRe.exec(token)) !== null) {
      if (im[1] !== undefined) {
        runText += decodeXmlEntities(im[1]);
      } else if (/^<(?:\w+:)?tab\b/.test(im[0])) {
        runText += "\t";
      } else if (/^<(?:\w+:)?br\b/.test(im[0])) {
        runText += "\n";
      }
    }

    if (runText.length > 0) {
      const commentIds = activeCommentsSet.size > 0 ? [...activeCommentsSet] : undefined;
      // Merge with previous run if identical formatting and commentIds
      const prev = runs[runs.length - 1];
      if (
        prev &&
        prev.type === "text" &&
        Boolean(prev.bold) === bold &&
        Boolean(prev.italic) === italic &&
        Boolean(prev.underline) === underline &&
        Boolean(prev.strike) === strike &&
        prev.highlight === highlight &&
        JSON.stringify(prev.commentIds ?? []) === JSON.stringify(commentIds ?? [])
      ) {
        prev.text = (prev.text ?? "") + runText;
      } else {
        runs.push({
          type: "text",
          text: runText,
          ...(bold ? { bold: true } : {}),
          ...(italic ? { italic: true } : {}),
          ...(underline ? { underline: true } : {}),
          ...(strike ? { strike: true } : {}),
          ...(highlight ? { highlight } : {}),
          ...(commentIds ? { commentIds } : {}),
        });
      }
    }
  }

  return { type, align, runs };
}

export async function fromDocxBytes(bytes: Uint8Array): Promise<DocxDocument> {
  const entries = await readZipEntries(bytes);
  const docBytes = entries.get("word/document.xml");
  if (!docBytes) {
    throw new Error("The .docx archive does not contain word/document.xml.");
  }

  // Parse numbering.xml to identify bullet vs ordered list numIds
  const bulletNumIds = new Set<string>(["1"]);
  const numberingBytes = entries.get("word/numbering.xml");
  if (numberingBytes) {
    const numberingXml = decodeUtf8(numberingBytes);
    const bulletAbstractIds = new Set<string>();
    const absRe = /<(?:\w+:)?abstractNum\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?abstractNum>/g;
    let am: RegExpExecArray | null;
    while ((am = absRe.exec(numberingXml)) !== null) {
      const absId = getAttr(am[1], "abstractNumId");
      if (absId && /<(?:\w+:)?numFmt\b[^>]*val\s*=\s*["']bullet["']/.test(am[2])) {
        bulletAbstractIds.add(absId);
      }
    }
    const numRe = /<(?:\w+:)?num\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?num>/g;
    let nm: RegExpExecArray | null;
    while ((nm = numRe.exec(numberingXml)) !== null) {
      const numId = getAttr(nm[1], "numId");
      const absMatch = /<(?:\w+:)?abstractNumId\b[^>]*>/.exec(nm[2]);
      const absId = absMatch ? getAttr(absMatch[0], "val") : null;
      if (numId && absId) {
        if (bulletAbstractIds.has(absId)) bulletNumIds.add(numId);
        else bulletNumIds.delete(numId);
      }
    }
  }

  // Parse word/footnotes.xml
  const footnotes: DocxFootnote[] = [];
  const fnIdMap = new Map<string, string>();
  const fnBytes = entries.get("word/footnotes.xml");
  if (fnBytes) {
    const fnXml = decodeUtf8(fnBytes);
    const fnRe = /<(?:\w+:)?footnote\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?footnote>/g;
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(fnXml)) !== null) {
      const rawId = getAttr(fm[1], "id");
      const fnType = getAttr(fm[1], "type");
      if (!rawId || rawId === "-1" || rawId === "0" || fnType === "separator" || fnType === "continuationSeparator") {
        continue;
      }
      let text = "";
      const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(fm[2])) !== null) {
        text += decodeXmlEntities(tm[1]);
      }
      const internalId = `fn-${rawId}`;
      fnIdMap.set(rawId, internalId);
      footnotes.push({ id: internalId, text: text.trim() });
    }
  }

  // Parse word/commentsExtended.xml for resolved states keyed by paraId
  const resolvedParaIds = new Set<string>();
  const commentsExtBytes = entries.get("word/commentsExtended.xml");
  if (commentsExtBytes) {
    const extXml = decodeUtf8(commentsExtBytes);
    const exRe = /<(?:\w+:)?commentEx\b([^>]*)\/?>/g;
    let em: RegExpExecArray | null;
    while ((em = exRe.exec(extXml)) !== null) {
      const pId = getAttr(em[1], "paraId");
      const done = getAttr(em[1], "done");
      if (pId && (done === "1" || done === "true")) {
        resolvedParaIds.add(pId);
      }
    }
  }

  // Parse word/comments.xml
  const comments: DocxComment[] = [];
  const commentIdMap = new Map<string, string>();
  const commentsBytes = entries.get("word/comments.xml");
  if (commentsBytes) {
    const cXml = decodeUtf8(commentsBytes);
    const cRe = /<(?:\w+:)?comment\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?comment>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(cXml)) !== null) {
      const rawId = getAttr(cm[1], "id");
      if (!rawId) continue;
      const author = getAttr(cm[1], "author") ?? "Reviewer";
      const date = getAttr(cm[1], "date") ?? new Date().toISOString();
      const paraMatches = [...cm[2].matchAll(/<(?:\w+:)?p\b([^>]*)>/g)];
      const lastParaAttrs = paraMatches.length > 0 ? paraMatches[paraMatches.length - 1][1] : null;
      const paraId = lastParaAttrs ? getAttr(lastParaAttrs, "paraId") : null;
      let text = "";
      const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(cm[2])) !== null) {
        text += decodeXmlEntities(tm[1]);
      }
      const internalId = `c-${rawId}`;
      commentIdMap.set(rawId, internalId);
      comments.push({
        id: internalId,
        author,
        date,
        text: text.trim(),
        resolved: paraId ? resolvedParaIds.has(paraId) : false,
      });
    }
  }

  // Parse word/document.xml paragraphs (handling both self-closing <w:p/> and paired <w:p>...</w:p>)
  const docXml = decodeUtf8(docBytes);
  const blocks: DocxBlock[] = [];
  const activeCommentsSet = new Set<string>();
  const pRe = /<(?:\w+:)?p(?:\s[^>]*)?\/>|<(?:\w+:)?p(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?p>/g;
  let pm: RegExpExecArray | null;
  let blockIdx = 1;
  while ((pm = pRe.exec(docXml)) !== null) {
    const inner = pm[1] ?? "";
    const parsed = parseParagraphXml(inner, fnIdMap, activeCommentsSet, commentIdMap, bulletNumIds);
    blocks.push({
      id: `b-${blockIdx++}`,
      type: parsed.type,
      ...(parsed.align ? { align: parsed.align } : {}),
      runs: parsed.runs.length ? parsed.runs : [{ type: "text", text: "" }],
    });
  }

  if (blocks.length === 0) {
    blocks.push({ id: "b-1", type: "paragraph", runs: [{ type: "text", text: "" }] });
  }

  return {
    blocks,
    footnotes,
    comments,
    settings: {
      font: "Times New Roman",
      fontSizePt: 12,
      lineSpacing: 1.5,
      includeFootnotesInCount: true,
      includeQuotesInCount: true,
    },
  };
}

// Extracts plain text paragraphs from a .docx file (used for attached video transcripts).
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const parsed = await fromDocxBytes(bytes);
  const lines: string[] = [];
  for (const block of parsed.blocks) {
    if (block.type === "page_break") continue;
    const text = block.runs
      .filter((r) => r.type === "text" && r.text)
      .map((r) => r.text!)
      .join("")
      .trim();
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function sameRunFormatting(a: DocxRun, b: DocxRun): boolean {
  if (a.type !== "text" || b.type !== "text") return false;
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.strike) === Boolean(b.strike) &&
    (a.highlight ?? undefined) === (b.highlight ?? undefined) &&
    JSON.stringify(a.commentIds ?? []) === JSON.stringify(b.commentIds ?? [])
  );
}

export function coalesceRuns(runs: DocxRun[]): DocxRun[] {
  const out: DocxRun[] = [];
  for (const r of runs) {
    if (r.type === "footnote_ref") {
      out.push(r);
      continue;
    }
    const text = r.text ?? "";
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && sameRunFormatting(prev, r)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? "") + text };
    } else {
      out.push({ ...r, text });
    }
  }
  if (!out.some((r) => r.type === "text")) {
    const template = runs.find((r) => r.type === "text");
    out.unshift({ ...(template ?? { type: "text" }), type: "text", text: "" });
  }
  return out;
}

// Updates a block's runs after a plain-text edit while preserving per-run formatting,
// comment anchors and mid-paragraph footnote_ref positions.
export function spliceRunsOnTextEdit(runs: DocxRun[], newText: string): DocxRun[] {
  const oldText = runs
    .filter((r) => r.type === "text")
    .map((r) => r.text ?? "")
    .join("");
  if (oldText === newText) return runs;

  let prefixLen = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefixLen < maxPrefix && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(oldText.length - prefixLen, newText.length - prefixLen);
  while (
    suffixLen < maxSuffix &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const replaceEnd = oldText.length - suffixLen;
  const inserted = newText.slice(prefixLen, newText.length - suffixLen);

  // Determine the formatting template for inserted text from the run overlapping [prefixLen, replaceEnd]
  let insertTemplate: DocxRun = { type: "text" };
  let scanPos = 0;
  for (const r of runs) {
    if (r.type !== "text") continue;
    const len = (r.text ?? "").length;
    const isReplacing = replaceEnd > prefixLen;
    if (
      isReplacing
        ? scanPos + len > prefixLen
        : prefixLen > 0
          ? scanPos < prefixLen && scanPos + len >= prefixLen
          : scanPos <= prefixLen
    ) {
      insertTemplate = r;
      break;
    }
    scanPos += len;
  }

  const nextRuns: DocxRun[] = [];
  let pos = 0;
  let didInsert = false;

  for (const r of runs) {
    if (r.type === "footnote_ref") {
      if (!didInsert && pos >= prefixLen) {
        if (inserted) nextRuns.push({ ...insertTemplate, type: "text", text: inserted });
        didInsert = true;
      }
      nextRuns.push(r);
      continue;
    }

    const t = r.text ?? "";
    const runStart = pos;
    const runEnd = pos + t.length;
    pos = runEnd;

    // Text before replaced region
    if (runStart < prefixLen) {
      const sliceEnd = Math.min(runEnd, prefixLen);
      const beforeStr = t.slice(0, sliceEnd - runStart);
      if (beforeStr) nextRuns.push({ ...r, text: beforeStr });
    }

    // Emit inserted text once we reach prefixLen
    if (!didInsert && runEnd >= prefixLen) {
      if (inserted) nextRuns.push({ ...insertTemplate, type: "text", text: inserted });
      didInsert = true;
    }

    // Text after replaced region
    if (runEnd > replaceEnd) {
      const sliceStart = Math.max(runStart, replaceEnd);
      const afterStr = t.slice(sliceStart - runStart);
      if (afterStr) nextRuns.push({ ...r, text: afterStr });
    }
  }

  if (!didInsert && inserted) {
    nextRuns.push({ ...insertTemplate, type: "text", text: inserted });
  }

  return coalesceRuns(nextRuns);
}

// Inserts a non-text run (such as a footnote_ref) at a character offset within the block.
export function insertRunAtOffset(runs: DocxRun[], offset: number, inserted: DocxRun): DocxRun[] {
  const out: DocxRun[] = [];
  let pos = 0;
  let placed = false;

  for (const r of runs) {
    if (r.type !== "text") {
      out.push(r);
      continue;
    }
    const t = r.text ?? "";
    const runStart = pos;
    const runEnd = pos + t.length;
    pos = runEnd;

    if (!placed && offset >= runStart && offset <= runEnd) {
      const cut = offset - runStart;
      const before = t.slice(0, cut);
      const after = t.slice(cut);
      if (before) out.push({ ...r, text: before });
      out.push(inserted);
      if (after) out.push({ ...r, text: after });
      placed = true;
    } else {
      out.push(r);
    }
  }

  if (!placed) {
    out.push(inserted);
  }
  return coalesceRuns(out);
}

// Splits a block's runs into two blocks at a character offset (used on Enter key).
export function splitBlockRunsAtOffset(
  runs: DocxRun[],
  offset: number,
): { before: DocxRun[]; after: DocxRun[] } {
  const before: DocxRun[] = [];
  const after: DocxRun[] = [];
  let pos = 0;

  for (const r of runs) {
    if (r.type !== "text") {
      if (pos <= offset) before.push(r);
      else after.push(r);
      continue;
    }
    const t = r.text ?? "";
    const runStart = pos;
    const runEnd = pos + t.length;
    pos = runEnd;

    if (runEnd <= offset) {
      before.push(r);
    } else if (runStart >= offset) {
      after.push(r);
    } else {
      const cut = offset - runStart;
      before.push({ ...r, text: t.slice(0, cut) });
      after.push({ ...r, text: t.slice(cut) });
    }
  }

  return {
    before: coalesceRuns(before),
    after: coalesceRuns(after),
  };
}

// Applies formatting or comment updates to text runs within [startOffset, endOffset]
// (or to all text runs in the block when startOffset === endOffset).
export function formatRunsInRange(
  runs: DocxRun[],
  startOffset: number,
  endOffset: number,
  updater: (run: DocxRun) => DocxRun,
): DocxRun[] {
  if (startOffset >= endOffset) {
    const hasNonEmptyText = runs.some((r) => r.type === "text" && (r.text ?? "").length > 0);
    if (!hasNonEmptyText) {
      const firstIdx = runs.findIndex((r) => r.type === "text");
      if (firstIdx >= 0) {
        return runs.map((r, i) => (i === firstIdx ? updater(r) : r));
      }
      return [updater({ type: "text", text: "" }), ...runs];
    }
    return coalesceRuns(runs.map((r) => (r.type === "text" ? updater(r) : r)));
  }

  const out: DocxRun[] = [];
  let pos = 0;
  for (const r of runs) {
    if (r.type !== "text") {
      out.push(r);
      continue;
    }
    const t = r.text ?? "";
    const runStart = pos;
    const runEnd = pos + t.length;
    pos = runEnd;

    if (runEnd <= startOffset || runStart >= endOffset) {
      out.push(r);
      continue;
    }

    if (runStart < startOffset) {
      out.push({ ...r, text: t.slice(0, startOffset - runStart) });
    }
    const midStart = Math.max(runStart, startOffset) - runStart;
    const midEnd = Math.min(runEnd, endOffset) - runStart;
    const midText = t.slice(midStart, midEnd);
    if (midText) {
      out.push(updater({ ...r, text: midText }));
    }
    if (runEnd > endOffset) {
      out.push({ ...r, text: t.slice(endOffset - runStart) });
    }
  }

  return coalesceRuns(out);
}
