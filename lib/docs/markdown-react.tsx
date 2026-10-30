import Link from "next/link";
import type { ReactNode } from "react";
import { CodeGroup } from "@/components/docs/page/CodeGroup";
import { ArrowUpRightIcon, BookIcon, CalloutIcon, LinkIcon } from "@/components/docs/page/icons";
import { highlightCode } from "@/lib/docs/highlight";
import { codeTabsOf, parseDocsMarkdown, type Block, type DocsDoc, type Inline } from "@/lib/docs/markdown";
import { docsMarkdown } from "@/lib/docs/pages";

/**
 * Server rendering for the docs mirror: the page model from lib/docs/markdown with its code highlighted, memoized per
 * slug, and the React for it. Everything is a plain element except code blocks (CodeGroup, a client island for tabs,
 * copy and Run). Shiki's highlighted HTML is the only markup injected; Meta's text is always rendered as text.
 */

const docs = new Map<string, Promise<DocsDoc>>();

/**
 * The page's model with every code block highlighted, built once per slug per server process. The root layout reads
 * cookies, so docs pages render on every request; this keeps that to a map lookup after the first.
 */
export function loadDocsDoc(slug: string): Promise<DocsDoc> {
  let doc = docs.get(slug);
  if (!doc) {
    doc = (async () => {
      const model = parseDocsMarkdown(docsMarkdown(slug));
      await Promise.all(
        codeTabsOf([...model.lead, ...model.body]).map(async (tab) => {
          tab.html = await highlightCode(tab.code, tab.lang);
        }),
      );
      return model;
    })();
    docs.set(slug, doc);
    doc.catch(() => docs.delete(slug));
  }
  return doc;
}

function DocsLink({ href, external, title, children }: { href: string; external: boolean; title?: string; children: ReactNode }) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} className="docs-link" title={title}>
        {children}
      </Link>
    );
  }
  if (external) {
    return (
      <a href={href} className="docs-link" title={title} target="_blank" rel="noopener noreferrer">
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <a href={href} className="docs-link" title={title}>
      {children}
    </a>
  );
}

export function renderInlines(nodes: Inline[], key = "i"): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.k) {
      case "text":
        return n.text;
      case "strong":
        return <strong key={k}>{renderInlines(n.children, k)}</strong>;
      case "em":
        return <em key={k}>{renderInlines(n.children, k)}</em>;
      case "del":
        return <del key={k}>{renderInlines(n.children, k)}</del>;
      case "code":
        return (
          <code key={k} className="docs-code-inline">
            {n.text}
          </code>
        );
      case "link":
        return (
          <DocsLink key={k} href={n.href} external={n.external} title={n.title}>
            {renderInlines(n.children, k)}
          </DocsLink>
        );
      case "image":
        return (
          // Hotlinked from dev.meta.ai like the mirror's figures; next/image would proxy and resize Meta's assets.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={k} className="docs-img-inline" src={n.src} alt={n.alt} title={n.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        );
      case "br":
        return <br key={k} />;
      case "checkbox":
        return <input key={k} type="checkbox" className="docs-task" defaultChecked={n.checked} disabled aria-label={n.checked ? "Done" : "Not done"} />;
    }
  });
}

/** What a block's rendering may depend on beyond the block: the page, and the H3 it sits under. */
export interface RenderContext {
  slug?: string;
  /** The text of the latest H3 in the same list of blocks, or null after an H2. */
  section?: string | null;
}

/** The cookbook index's sections and the tint dev.meta.ai gives each one's recipe tiles. */
const RECIPE_TINTS: Readonly<Record<string, "blue" | "purple" | "orange" | "green">> = {
  "API fundamentals": "blue",
  "Segment Anything Model": "blue",
  "Agent patterns": "purple",
  "Building with Muse Code": "purple",
  "Muse Image": "purple",
  "Muse Voice Transcribe": "purple",
  "Use cases": "orange",
  "Run locally": "green",
  "Post-training": "green",
};

/** The recipe tint for cards on the cookbook index, or null for every other card grid. */
export function recipeTint(ctx: RenderContext): string | null {
  if (ctx.slug !== "cookbook") return null;
  return (ctx.section && RECIPE_TINTS[ctx.section]) || "blue";
}

/** The one link a paragraph holds and nothing else, when it leads off the site: dev.meta.ai shows it as a pill. */
function soleExternalLink(children: Inline[]): Extract<Inline, { k: "link" }> | null {
  const parts = children.filter((n) => !(n.k === "text" && !n.text.trim()));
  const [only] = parts;
  return parts.length === 1 && only.k === "link" && only.external ? only : null;
}

/** Renders a list of blocks. The first H2 of the page drops its rule in CSS (h2:first-of-type), like dev.meta.ai. */
export function renderBlocks(blocks: Block[], key = "b", ctx: RenderContext = {}): ReactNode[] {
  let section: string | null = ctx.section ?? null;
  return blocks.map((b, i) => {
    if (b.k === "heading" && b.depth <= 3) section = b.depth === 3 ? b.text : null;
    return renderBlock(b, `${key}.${i}`, { ...ctx, section });
  });
}

function renderBlock(b: Block, k: string, ctx: RenderContext): ReactNode {
  switch (b.k) {
    case "heading": {
      const Tag = `h${b.depth}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={k} id={b.id} className={`docs-h docs-h${b.depth}`}>
          {renderInlines(b.children, k)}
          {/* A mouse affordance like GitHub's: hidden from screen readers so the heading reads as its text alone. */}
          <a className="docs-anchor" href={`#${b.id}`} aria-hidden tabIndex={-1}>
            #
          </a>
        </Tag>
      );
    }
    case "paragraph": {
      const action = soleExternalLink(b.children);
      if (action) {
        return (
          <p key={k} className="docs-p docs-p-action">
            <a href={action.href} className="docs-btn docs-btn-secondary docs-btn-xs" title={action.title} target="_blank" rel="noopener noreferrer">
              <span>{renderInlines(action.children, k)}</span>
              <ArrowUpRightIcon size={14} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        );
      }
      return (
        <p key={k} className="docs-p">
          {renderInlines(b.children, k)}
        </p>
      );
    }
    case "inline":
      return <span key={k}>{renderInlines(b.children, k)}</span>;
    case "figure":
      return (
        <figure key={k} className="docs-figure">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.src} alt={b.alt} title={b.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        </figure>
      );
    case "list": {
      const items = b.items.map((item, i) => <li key={`${k}.${i}`}>{renderBlocks(item, `${k}.${i}`, { slug: ctx.slug })}</li>);
      return b.ordered ? (
        <ol key={k} className="docs-list" start={b.start ?? undefined}>
          {items}
        </ol>
      ) : (
        <ul key={k} className="docs-list">
          {items}
        </ul>
      );
    }
    case "cards": {
      const tint = recipeTint(ctx);
      return (
        <ul key={k} className={tint ? `docs-cards docs-cards-recipe docs-recipe-${tint}` : "docs-cards"}>
          {b.items.map((card, i) => (
            <li key={`${k}.${i}`} className="docs-card">
              <span className="docs-card-icon">{tint ? <BookIcon size={18} /> : <LinkIcon size={18} />}</span>
              <DocsLink href={card.href} external={card.external}>
                <span className="docs-card-title">{renderInlines(card.title, `${k}.${i}t`)}</span>
              </DocsLink>
              <span className="docs-card-desc">{renderInlines(card.description, `${k}.${i}d`)}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "table":
      return (
        <div key={k} className="docs-table" role="group" aria-label="Table" tabIndex={0}>
          <table>
            {b.head ? (
              <thead>
                <tr>
                  {b.head.map((cell, i) => (
                    <th key={i} style={b.align[i] ? { textAlign: b.align[i] ?? undefined } : undefined}>
                      {renderInlines(cell, `${k}.h${i}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={b.align[i] ? { textAlign: b.align[i] ?? undefined } : undefined}>
                      {renderInlines(cell, `${k}.${r}.${i}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return (
        <div key={k} className={`docs-callout docs-callout-${b.kind}`} role="note">
          <span className="docs-callout-icon">
            <CalloutIcon kind={b.kind} />
          </span>
          <div className="docs-callout-body">
            <p className="docs-callout-title">{renderInlines(b.title, `${k}.t`)}</p>
            {renderBlocks(b.children, k, { slug: ctx.slug })}
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote key={k} className="docs-quote">
          {renderBlocks(b.children, k, { slug: ctx.slug })}
        </blockquote>
      );
    case "code": {
      const request = b.tabs.find((t) => t.request)?.request ?? null;
      return (
        <CodeGroup
          key={k}
          tabs={b.tabs.map((t) => ({ label: t.label, lang: t.lang, html: t.html ?? "" }))}
          request={request}
        />
      );
    }
    case "diagram":
      return (
        <pre key={k} className="docs-diagram" tabIndex={0}>
          {b.text}
        </pre>
      );
    case "hr":
      return <hr key={k} className="docs-hr" />;
    case "raw":
      return (
        <p key={k} className="docs-raw">
          {b.text}
        </p>
      );
  }
}
