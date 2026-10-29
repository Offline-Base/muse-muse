import { Fragment, type ReactNode } from "react";

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const ORDERED = /^\s*\d/;
/** A rule line: three or more -, * or _, maybe spaced out. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^\s*#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
/** A label a model sometimes leaves at the start of its first paragraph: "Intro:", "**Introduction:**". */
const INTRO = /^\s*(?:\*\*|__)?(?:intro|introduction)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*/i;
/** A line that starts a block of its own: a code fence, a heading, a list item or a rule. */
const opensBlock = (line: string) => /^\s*(`{3,}|~{3,}|#{1,6}\s)/.test(line) || LIST_ITEM.test(line) || RULE.test(line);

/**
 * Renders a model's plain-text reply that may use simple markdown: paragraphs, headings, lists, code blocks, rules,
 * `inline code` and **bold**. No links or HTML. Use it instead of printing model text raw. A single line break stays a
 * line break, so "Wins: ..." and "Next steps: ..." on their own lines stay apart, unless the line stops mid-sentence and
 * the next one goes on in lower case: that is one sentence wrapped by hand, and it joins up again. Pass the card's h2
 * as `title`, and a heading that opens the reply is left out, whatever it says: the h2 already names the card. A
 * leading "Intro:" or "Introduction:" label on the first paragraph is always left out.
 */
export function Markdown({ text, title }: { text: string; title?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let firstParagraph = true;
  if (title) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (lines[i]?.match(HEADING)) i += 1;
  }
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
    if (RULE.test(line)) {
      blocks.push(<hr key={blocks.length} />);
      i += 1;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push(<h3 key={blocks.length}>{inline(heading[1])}</h3>);
      i += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = ORDERED.test(line);
      const sameKind = (l: string | undefined) => l !== undefined && !RULE.test(l) && LIST_ITEM.test(l) && ORDERED.test(l) === ordered;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (sameKind(l)) items.push([l.replace(LIST_ITEM, "")]);
        // An indented line that opens no block of its own goes on with the item above it.
        else if (/^\s+\S/.test(l) && !opensBlock(l)) items[items.length - 1].push(l);
        // A blank line between two items of the same list keeps them in one list.
        else if (!l.trim() && sameKind(lines[i + 1])) {
          // nothing to add
        } else break;
        i += 1;
      }
      const rows = items.map((item, k) => <li key={k}>{lineBreaks(item)}</li>);
      const start = ordered ? parseInt(line, 10) : 1;
      blocks.push(
        ordered ? (
          <ol key={blocks.length} start={start !== 1 ? start : undefined}>
            {rows}
          </ol>
        ) : (
          <ul key={blocks.length}>{rows}</ul>
        ),
      );
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !opensBlock(lines[i])) para.push(lines[i++]);
    if (firstParagraph && INTRO.test(para[0])) {
      para[0] = para[0].replace(INTRO, "");
      if (!para[0].trim()) para.shift();
      if (!para.length) continue;
      const first = para[0].trimStart();
      para[0] = first.charAt(0).toUpperCase() + first.slice(1);
    }
    firstParagraph = false;
    blocks.push(<p key={blocks.length}>{lineBreaks(para)}</p>);
  }
  return <div className="prose">{blocks}</div>;
}

/**
 * One block's lines with their breaks: each break stays, except where a line stops mid-sentence (no closing
 * punctuation) and the next goes on in lower case, a digit or a bracket. Two spaces or a backslash at the end of a
 * line always break, as in markdown. Lines that join up are styled as one run, so **bold** can span the join.
 */
function lineBreaks(lines: string[]): ReactNode[] {
  const runs: string[] = [];
  lines.forEach((raw, k) => {
    const text = raw.trim().replace(/\\$/, "");
    const prev = lines[k - 1];
    const joins = k > 0 && !/ {2,}$|\\$/.test(prev) && !/[.!?:;]["')\]*_`]*$/.test(prev.trim()) && /^[a-z0-9(]/.test(text);
    if (joins) runs[runs.length - 1] += ` ${text}`;
    else runs.push(text);
  });
  return runs.flatMap((run, k) => [...(k ? [<br key={`br-${k}`} />] : []), <Fragment key={k}>{inline(run)}</Fragment>]);
}

function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, k) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    return <Fragment key={k}>{part}</Fragment>;
  });
}
