"use client";

import type { ReactNode } from "react";
import { blocks, inlineTokens, linkTarget, type InlineToken } from "@/components/docs/playgrounds/protocols/inline-md";
import styles from "@/components/docs/playgrounds/protocols/protocols.module.css";

/**
 * Meta's cell and description Markdown, drawn with the mirror's own inline styles (docs-code-inline, docs-link).
 * Links to another schema on the same page call `onSchema`, so the explorer opens it in place; links to other docs
 * pages stay on the mirror; anything else opens in a new tab.
 */

interface Props {
  md: string;
  /** The schemas page these links belong to, such as "api-reference/responses/schemas". */
  pagePath: string;
  onSchema?: (anchor: string) => void;
}

function render(tokens: readonly InlineToken[], props: Omit<Props, "md">, key = ""): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}${i}`;
    if (t.kind === "text") return t.text;
    if (t.kind === "code") {
      return (
        <code key={k} className="docs-code-inline">
          {t.text}
        </code>
      );
    }
    if (t.kind === "strong") return <strong key={k}>{render(t.children, props, `${k}-`)}</strong>;
    const target = linkTarget(t.href, props.pagePath);
    const children = render(t.children, props, `${k}-`);
    if (target.kind === "schema" && props.onSchema) {
      const anchor = target.anchor;
      return (
        <button key={k} type="button" className={styles.refButton} onClick={() => props.onSchema?.(anchor)}>
          {children}
        </button>
      );
    }
    if (target.kind === "schema") {
      return (
        <a key={k} className="docs-link" href={`#${target.anchor}`}>
          {children}
        </a>
      );
    }
    if (target.kind === "docs") {
      return (
        <a key={k} className="docs-link" href={target.href}>
          {children}
        </a>
      );
    }
    return (
      <a key={k} className="docs-link" href={target.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  });
}

/** One line of inline Markdown. */
export function InlineMd({ md, ...props }: Props) {
  return <>{render(inlineTokens(md), props)}</>;
}

/** A description: paragraphs and lists. */
export function ProseMd({ md, ...props }: Props) {
  const list = blocks(md);
  if (!list.length) return null;
  return (
    <div className={styles.prose}>
      {list.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{render(b.tokens, props, `p${i}-`)}</p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{render(item, props, `u${i}-${j}-`)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
