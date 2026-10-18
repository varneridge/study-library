import type { Block, InlineLink, InlineText } from "../lib/types";

function Inline({ node }: { node: InlineText | InlineLink }) {
  if (node.type === "link") {
    return (
      <a href={node.href} target="_blank" rel="noreferrer">
        {node.content.map((child, i) => <Inline key={i} node={child} />)}
      </a>
    );
  }
  let content: React.ReactNode = node.text.split("\n").flatMap((line, i) => (i ? [<br key={i} />, line] : [line]));
  const styles = node.styles ?? {};
  if (styles.code) content = <code>{content}</code>;
  if (styles.bold) content = <strong>{content}</strong>;
  if (styles.italic) content = <em>{content}</em>;
  if (styles.underline) content = <u>{content}</u>;
  if (styles.strike) content = <s>{content}</s>;
  return <>{content}</>;
}

function Content({ block }: { block: Block }) {
  return <>{(block.content ?? []).map((node, i) => <Inline key={i} node={node} />)}</>;
}

// Read-only rendering of BlockNote blocks. Consecutive list items share a list.
export function BlockView({ blocks }: { blocks: Block[] }) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "bulletListItem" || block.type === "numberedListItem") {
      const type = block.type;
      const items: Block[] = [];
      while (i < blocks.length && blocks[i].type === type) items.push(blocks[i++]);
      const List = type === "bulletListItem" ? "ul" : "ol";
      out.push(
        <List key={block.id}>
          {items.map((item) => (
            <li key={item.id}>
              <Content block={item} />
              {item.children?.length ? <BlockView blocks={item.children} /> : null}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (block.type === "image") {
      const props = block.props ?? {};
      const url = String(props.url ?? "");
      const width = Number(props.previewWidth) || undefined;
      const align = String(props.textAlignment ?? "left");
      if (url) {
        out.push(
          <figure key={block.id} className={`align-${align}`}>
            <img src={url} alt={String(props.caption ?? props.name ?? "")} style={{ width: width ? `${width}px` : undefined }} loading="lazy" />
            {props.caption ? <figcaption>{String(props.caption)}</figcaption> : null}
          </figure>,
        );
      }
      i += 1;
      continue;
    }
    if (block.type === "heading") {
      const level = Number(block.props?.level ?? 2);
      const Heading = level === 1 ? "h2" : "h3";
      out.push(<Heading key={block.id}><Content block={block} /></Heading>);
    } else {
      out.push(<p key={block.id}><Content block={block} /></p>);
    }
    i += 1;
  }
  return <div className="blocks">{out}</div>;
}
