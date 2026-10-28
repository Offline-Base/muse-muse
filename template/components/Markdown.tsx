import { Fragment, type ReactNode } from "react";

/**
 * Renders a model's plain-text reply that may use simple markdown: paragraphs, headings, lists, code blocks,
 * `inline code` and **bold**. No links or HTML. Use it instead of printing model text raw.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(<h3 key={blocks.length}>{inline(heading[1])}</h3>);
      i += 1;
      continue;
    }
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && listItem.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) items.push(lines[i++].replace(listItem, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={blocks.length}>
          {items.map((item, k) => (
            <li key={k}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(`{3,}|~{3,}|#{1,6}\s)/.test(lines[i]) && !listItem.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
  }
  return <div className="prose">{blocks}</div>;
}

function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, k) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    return <Fragment key={k}>{part}</Fragment>;
  });
}
