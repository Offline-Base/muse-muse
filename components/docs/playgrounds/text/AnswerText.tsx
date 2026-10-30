"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { CITE_CLOSE, CITE_OPEN, MARKER_BASE, MARKER_END, parseMarkdown, type MdBlock, type MdInline } from "@/components/docs/playgrounds/text/markdown-lite";
import { cx } from "@/components/docs/playgrounds/text/parts";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * A model's answer drawn from its Markdown (markdown-lite.ts) instead of as raw marks: paragraphs, lists, tables,
 * code and TeX math as text, links opening in a new tab. Everything is React text; nothing from the answer becomes
 * HTML. Headings stay paragraphs (bold), so an answer can't add headings to the docs page's outline.
 *
 * With `cite`, the marks search grounding puts in the text (CITE_OPEN, CITE_CLOSE, markerChar) become the cited
 * stretch's underline and the numbered markers right where the spans end, inside bold text or list items alike.
 */

export interface CiteRender {
  /** The marker after a cited span, for source `n`. */
  marker(n: number): ReactNode;
  /** The class for cited text. */
  citedClass: string;
}

interface Walk {
  cited: boolean;
  key: number;
  cite?: CiteRender;
}

/** Text with the citation marks turned into spans and markers, in reading order (the walk keeps the state). */
function textNodes(v: string, w: Walk): ReactNode[] {
  if (!/[-]/.test(v) && !w.cited) return [v];
  const out: ReactNode[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    out.push(
      w.cited && w.cite ? (
        <span key={w.key++} className={w.cite.citedClass}>
          {buf}
        </span>
      ) : (
        <Fragment key={w.key++}>{buf}</Fragment>
      ),
    );
    buf = "";
  };
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (ch === CITE_OPEN) {
      flush();
      w.cited = true;
    } else if (ch === CITE_CLOSE) {
      flush();
      w.cited = false;
    } else if (code >= MARKER_BASE && code < MARKER_END) {
      flush();
      if (w.cite) out.push(<Fragment key={w.key++}>{w.cite.marker(code - MARKER_BASE)}</Fragment>);
    } else buf += ch;
  }
  flush();
  return out;
}

function inlines(nodes: readonly MdInline[], w: Walk): ReactNode[] {
  return nodes.map((n) => {
    const k = w.key++;
    switch (n.t) {
      case "text":
        return <Fragment key={k}>{textNodes(n.v, w)}</Fragment>;
      case "br":
        return <br key={k} />;
      case "strong":
        return <strong key={k}>{inlines(n.c, w)}</strong>;
      case "em":
        return <em key={k}>{inlines(n.c, w)}</em>;
      case "del":
        return <del key={k}>{inlines(n.c, w)}</del>;
      case "code":
        return (
          <code key={k} className={styles.mdCode}>
            {textNodes(n.v, w)}
          </code>
        );
      case "math":
        return (
          <span key={k} className={styles.mdMath}>
            {textNodes(n.v, w)}
          </span>
        );
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {inlines(n.c, w)}
          </a>
        );
    }
  });
}

/** Blocks, with `tail` (a streaming caret) placed at the end of the last one's text. */
function blocks(list: readonly MdBlock[], w: Walk, tail: ReactNode): ReactNode[] {
  return list.map((b, idx) => {
    const end = idx === list.length - 1 ? tail : null;
    const k = w.key++;
    switch (b.t) {
      case "p":
        return (
          <p key={k}>
            {inlines(b.c, w)}
            {end}
          </p>
        );
      case "h":
        return (
          <p key={k} className={styles.mdHeading}>
            {inlines(b.c, w)}
            {end}
          </p>
        );
      case "list": {
        const items = b.items.map((item, j) => <li key={w.key++}>{blocks(item, w, j === b.items.length - 1 ? end : null)}</li>);
        return b.ordered ? (
          <ol key={k} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case "code":
        return (
          <Fragment key={k}>
            <pre className={styles.mdPre}>
              <code>{textNodes(b.v, w)}</code>
            </pre>
            {end}
          </Fragment>
        );
      case "math":
        return (
          <p key={k} className={styles.mdMathBlock}>
            <span className={styles.mdMath}>{textNodes(b.v, w)}</span>
            {end}
          </p>
        );
      case "quote":
        return <blockquote key={k}>{blocks(b.c, w, end)}</blockquote>;
      case "hr":
        return (
          <Fragment key={k}>
            <hr />
            {end}
          </Fragment>
        );
      case "table":
        return (
          <Fragment key={k}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {b.head.map((c) => (
                      <th key={w.key++} scope="col">
                        {inlines(c, w)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={w.key++}>
                      {r.map((c) => (
                        <td key={w.key++}>{inlines(c, w)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {end}
          </Fragment>
        );
    }
  });
}

export function AnswerText({ text, cite, tail, className }: { text: string; cite?: CiteRender; tail?: ReactNode; className?: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  const walk: Walk = { cited: false, key: 0, cite };
  return <div className={cx(styles.md, className)}>{tree.length ? blocks(tree, walk, tail ?? null) : tail}</div>;
}
