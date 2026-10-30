"use client";

import { Lexer, type Token, type Tokens } from "marked";
import { useMemo, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { decodeEntities } from "@/lib/docs/mirror-parse";
import { closePartialMarkdown, jsonReply, MAX_MARKDOWN_CHARS, safeHref } from "@/lib/markdown-reply";

/**
 * A model's reply, as Markdown (GFM: headings, lists, tables, code, quotes, links). Tokens become React elements, so
 * nothing the model writes is ever injected as HTML: raw HTML shows as text, links open only for http, https and
 * mailto, and an image becomes a link, because loading a URL a model chose could track the reader or carry data out in
 * its query string. A single newline stays a line break, the way people read a model's text.
 */

interface RenderOptions {
  /** False keeps every link as its text: the fine-tuning lab shows public visitors a tuned model's raw output. */
  links: boolean;
}

/** `<br>` is the one tag models write on purpose, inside table cells, where Markdown has no other way to break a line. */
const BR_TAG = /^<br\s*\/?>$/i;

function inline(tokens: Token[] | undefined, key: string, options: RenderOptions): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case "text": {
        const text = t as Tokens.Text;
        return text.tokens?.length ? <span key={k}>{inline(text.tokens, k, options)}</span> : decodeEntities(text.text);
      }
      case "escape":
        return (t as Tokens.Escape).text;
      case "strong":
        return <strong key={k}>{inline((t as Tokens.Strong).tokens, k, options)}</strong>;
      case "em":
        return <em key={k}>{inline((t as Tokens.Em).tokens, k, options)}</em>;
      case "del":
        return <del key={k}>{inline((t as Tokens.Del).tokens, k, options)}</del>;
      case "codespan":
        return <code key={k}>{(t as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={k} />;
      case "checkbox":
        return <input key={k} type="checkbox" className="md-task" checked={(t as Tokens.Checkbox).checked} disabled readOnly aria-label={(t as Tokens.Checkbox).checked ? "Done" : "Not done"} />;
      case "link": {
        const link = t as Tokens.Link;
        const children = inline(link.tokens, k, options);
        const href = options.links ? safeHref(link.href) : null;
        if (!href) return <span key={k}>{children}</span>;
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        );
      }
      case "image": {
        const image = t as Tokens.Image;
        const label = image.text.trim() ? `Image: ${decodeEntities(image.text)}` : "Image";
        const href = options.links ? safeHref(image.href) : null;
        if (!href) return <span key={k}>{label}</span>;
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>
        );
      }
      case "html": {
        const raw = (t as Tokens.HTML).raw;
        return BR_TAG.test(raw.trim()) ? <br key={k} /> : raw;
      }
      default:
        return "text" in t && typeof t.text === "string" ? t.text : t.raw;
    }
  });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <figure className="md-code">
      <figcaption className="md-code-head">
        <span>{lang || "text"}</span>
        <CopyButton value={code} label="Copy the code" className="icon-btn icon-btn-plain icon-btn-sm" />
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function blocks(tokens: Token[], key: string, options: RenderOptions): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case "space":
      case "def":
        return null;
      case "heading": {
        // A reply sits inside a page that has its own H1 and H2, so its headings start at H3.
        const heading = t as Tokens.Heading;
        const Tag = `h${Math.min(6, heading.depth + 2)}` as "h3" | "h4" | "h5" | "h6";
        return <Tag key={k}>{inline(heading.tokens, k, options)}</Tag>;
      }
      case "paragraph":
        return <p key={k}>{inline((t as Tokens.Paragraph).tokens, k, options)}</p>;
      case "text": {
        const text = t as Tokens.Text;
        return <span key={k}>{text.tokens?.length ? inline(text.tokens, k, options) : decodeEntities(text.text)}</span>;
      }
      case "checkbox":
        return inline([t], k, options);
      case "code": {
        const code = t as Tokens.Code;
        return <CodeBlock key={k} code={code.text} lang={(code.lang ?? "").trim().split(/\s+/)[0]} />;
      }
      case "blockquote":
        return <blockquote key={k}>{blocks((t as Tokens.Blockquote).tokens, k, options)}</blockquote>;
      case "list": {
        const list = t as Tokens.List;
        const items = list.items.map((item, n) => <li key={`${k}.${n}`}>{blocks(item.tokens, `${k}.${n}`, options)}</li>);
        return list.ordered ? (
          <ol key={k} start={typeof list.start === "number" && list.start !== 1 ? list.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case "table": {
        const table = t as Tokens.Table;
        const align = (n: number) => (table.align[n] ? { textAlign: table.align[n] ?? undefined } : undefined);
        return (
          <div key={k} className="md-table" role="group" aria-label="Table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, n) => (
                    <th key={n} style={align(n)}>
                      {inline(cell.tokens, `${k}.h${n}`, options)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, n) => (
                      <td key={n} style={align(n)}>
                        {inline(cell.tokens, `${k}.${r}.${n}`, options)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "hr":
        return <hr key={k} />;
      case "html":
        return (t as Tokens.HTML).raw.trim() ? (
          <p key={k} className="md-raw">
            {(t as Tokens.HTML).raw.trim()}
          </p>
        ) : null;
      default:
        return "text" in t && typeof t.text === "string" && t.text.trim() ? <p key={k}>{t.text}</p> : null;
    }
  });
}

export function MarkdownText({
  text,
  streaming = false,
  links = true,
  className,
}: {
  text: string;
  /** The reply is still arriving: unfinished markers are closed, and a caret follows the text. */
  streaming?: boolean;
  links?: boolean;
  /** Added to the element, such as the playgrounds' pg-stream-text. */
  className?: string;
}) {
  const content = useMemo(() => {
    if (text.length > MAX_MARKDOWN_CHARS) return null;
    const json = jsonReply(text, streaming);
    if (json !== null) return <CodeBlock code={json} lang="json" />;
    try {
      const tokens = new Lexer({ gfm: true, breaks: true }).lex(streaming ? closePartialMarkdown(text) : text);
      return blocks(tokens, "md", { links });
    } catch {
      return null;
    }
  }, [text, streaming, links]);

  const classes = ["md", className].filter(Boolean).join(" ");
  if (content === null) return <div className={`${classes} md-plain`}>{text}</div>;
  return (
    <div className={classes} data-streaming={streaming || undefined}>
      {text ? content : streaming ? <p /> : null}
    </div>
  );
}
