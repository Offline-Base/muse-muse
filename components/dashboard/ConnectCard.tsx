"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/icons";

export interface ConnectProduct {
  slug: string;
  name: string;
  connectorUrl: string;
}

type Client = "muse" | "claude" | "curl";

const CLIENTS: Array<{ key: Client; label: string; desc: string }> = [
  { key: "muse", label: "Muse app", desc: "Add a product to the Muse app as a custom connector with this URL" },
  { key: "claude", label: "Claude Code", desc: "Add a product to Claude Code as an MCP server in your terminal" },
  { key: "curl", label: "cURL", desc: "List a product's tools over MCP from your terminal" },
];

/** The command for one client, split around the URL so the URL can show as a link. */
function command(client: Client, p: ConnectProduct): [string, string, string] {
  if (client === "claude") return [`claude mcp add --transport http ${p.slug} `, p.connectorUrl, ""];
  if (client === "curl")
    return [
      "curl -s ",
      p.connectorUrl,
      ` -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ];
  return ["", p.connectorUrl, ""];
}

/**
 * The dashboard's top card, laid out like "Start building with Muse": client tabs on the right of the title, a
 * second row of tabs to pick a product, and the command in a code block with a copy button.
 */
export function ConnectCard({
  products,
  unpublished,
  publishOff,
}: {
  products: ConnectProduct[];
  unpublished: number;
  /** Why products aren't published here (env.publishOffReason), or null when they are. */
  publishOff: string | null;
}) {
  const id = useId();
  const [client, setClient] = useState<Client>("muse");
  const [slug, setSlug] = useState(products[0]?.slug ?? null);
  const product = products.find((p) => p.slug === slug) ?? products[0] ?? null;
  const current = CLIENTS.find((c) => c.key === client)!;
  const [before, url, after] = product ? command(client, product) : ["", "", ""];

  return (
    <section className="hero-card" aria-labelledby={`${id}-title`}>
      <div className="hero-card-head">
        <h1 id={`${id}-title`}>Use your products in Muse</h1>
        <div className="tabs" role="tablist" aria-label="Where to use it">
          {CLIENTS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={c.key === client}
              aria-controls={`${id}-panel`}
              onClick={() => setClient(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="hero-card-body" id={`${id}-panel`} role="tabpanel">
        {product ? (
          <>
            <p className="hero-card-desc">{current.desc}</p>
            {products.length > 1 ? (
              <div className="tabs" role="tablist" aria-label="Product">
                {products.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={p.slug === product.slug}
                    onClick={() => setSlug(p.slug)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="code-block">
              <code>
                {before}
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
                {after}
              </code>
              <CopyButton value={`${before}${url}${after}`} label="Copy" className="icon-btn icon-btn-plain" />
            </div>
          </>
        ) : (
          <>
            <p className="hero-card-desc">
              {unpublished
                ? `Connectors go live when a product is published to its own link. ${unpublished === 1 ? "One product is" : `${unpublished} products are`} built but not published${publishOff ? `, because ${publishOff}` : ""}.`
                : "Every product Muse Muse publishes gets a connector. Make one first, then its connector URL shows up here."}
            </p>
            <Link className="btn btn-outline" href="/">
              <Icon name="sparkle" size={18} />
              Make something
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
