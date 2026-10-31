import type { ReactNode } from "react";
import { CopyField } from "@/components/CopyButton";
import type { GetItSlots } from "@/components/product/GetItPanel";
import type { ProductView } from "@/components/view-types";
import { plural } from "@/lib/format";
import { cliFileName, outputLinks, pluginFileName, publicActions } from "@/lib/outputs/generate";
import { settleProveView } from "@/lib/outputs/labels";
import { condenseProveEvents, type ProveItemView } from "@/lib/types";

/** What a Prove it run says about an output, in the words a visitor reads. */
const PROOF_PILL: Record<ProveItemView["state"], { text: string; tone: string }> = {
  planned: { text: "Testing it now", tone: "pill-neutral" },
  running: { text: "Testing it now", tone: "pill-neutral" },
  done: { text: "Tested", tone: "pill-live" },
  failed: { text: "Didn't pass", tone: "pill-failed" },
  skipped: { text: "Not tested", tone: "pill-neutral" },
};

function testedOn(at: string | null): string | null {
  if (!at) return null;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What the last Prove it run did with this output, with its video. Nothing before a run has said anything about it. */
function Proof({ item }: { item: ProveItemView | undefined }) {
  if (!item) return null;
  const pill = PROOF_PILL[item.state];
  const on = testedOn(item.at);
  return (
    <div className="output-proof">
      <p className="output-proof-head">
        <span className={`pill ${pill.tone}`}>{pill.text}</span>
        <span>{item.title}</span>
        {on && item.state !== "planned" && item.state !== "running" ? <span className="muted small">{on}</span> : null}
      </p>
      {item.detail ? <p className="muted small">{item.detail}</p> : null}
      {item.checks?.length ? (
        <ul className="small">
          {item.checks.map((c, i) => (
            <li key={i}>
              {c.ok ? "Passed" : "Failed"}: {c.label}
            </li>
          ))}
        </ul>
      ) : null}
      {item.media ? (
        <>
          <video className="demo" src={item.media.url} poster={item.media.posterUrl ?? undefined} controls preload="none" playsInline aria-label={item.media.caption} />
          <p className="muted small">{item.media.caption}</p>
        </>
      ) : null}
    </div>
  );
}

function Panel({ children, item }: { children: ReactNode; item: ProveItemView | undefined }) {
  return (
    <div className="output-panel">
      {children}
      <Proof item={item} />
    </div>
  );
}

/**
 * The Get it panel's output slots (docs/PRODUCT_OUTPUTS.md): how to connect or download each thing a product comes with,
 * and what the last Prove it run found. A product with no live link or no actions has none. The target slots belong to
 * other units.
 */
export function productOutputSlots(input: {
  product: Pick<ProductView, "slug" | "name" | "liveUrl" | "manifest">;
  origin: string;
  events: ReadonlyArray<{ type: string; at?: string }>;
  now: number;
}): GetItSlots {
  const { product, origin, events, now } = input;
  const actions = publicActions(product.manifest);
  if (!product.liveUrl || !actions.length) return {};
  const links = outputLinks(origin, product.slug);
  const view = settleProveView(condenseProveEvents(events), now);
  const proof = (id: ProveItemView["item"]) => view?.items.find((i) => i.item === id);
  const { slug } = product;
  const names = actions.map((a) => a.name).join(", ");
  const example = actions[0]!.name;

  return {
    mcp: (
      <Panel item={proof("mcp")}>
        <p>
          Connect it to any app that speaks MCP. It has {plural(actions.length, "tool")}: {names}. No sign-in.
        </p>
        <CopyField value={links.mcp} label="MCP server URL" />
        <ol>
          <li>
            <strong>Muse app:</strong> add this URL as a custom connector.
          </li>
          <li>
            <strong>Claude Code:</strong> <code>claude mcp add --transport http {slug} {links.mcp}</code>
          </li>
          <li>
            <strong>Anything else:</strong> add it as a remote server over streamable HTTP.
          </li>
        </ol>
      </Panel>
    ),
    cli: (
      <Panel item={proof("cli")}>
        <p>One file that runs its actions from a terminal. It needs Node 18 or newer and nothing else.</p>
        <CopyField value={`curl -fsSL ${links.cli} -o ${cliFileName(slug)}`} label="Download command" />
        <ol>
          <li>
            See what it does: <code>node {cliFileName(slug)} --help</code>
          </li>
          <li>
            See what an action takes: <code>node {cliFileName(slug)} {example} --help</code>
          </li>
          <li>
            Add <code>--json</code> to any call to print only JSON.
          </li>
        </ol>
        <p>
          <a href={links.cli} download={cliFileName(slug)}>
            Download {cliFileName(slug)}
          </a>
        </p>
      </Panel>
    ),
    skill: (
      <Panel item={proof("skill")}>
        <p>A skill file that tells a coding agent what this product does and how to call it.</p>
        <CopyField value={`curl -fsSL ${links.skill} -o SKILL.md`} label="Download command" />
        <ol>
          <li>
            <strong>Muse Code:</strong> save it as <code>.agents/skills/{slug}/SKILL.md</code> in your project.
          </li>
          <li>
            <strong>Claude Code:</strong> save it as <code>~/.claude/skills/{slug}/SKILL.md</code>.
          </li>
        </ol>
        <p>
          <a href={links.skill} download="SKILL.md">
            Download SKILL.md
          </a>
        </p>
      </Panel>
    ),
    claude_plugin: (
      <Panel item={proof("claude_plugin")}>
        <p>A Claude plugin with this product&apos;s MCP server and skill in one zip. It isn&apos;t listed in any directory.</p>
        <ol>
          <li>
            <a href={links.claudePlugin} download={pluginFileName(slug)}>
              Download {pluginFileName(slug)}
            </a>
          </li>
          <li>
            Try it in Claude Code: <code>claude --plugin-dir {pluginFileName(slug)}</code>
          </li>
        </ol>
      </Panel>
    ),
    chatgpt: (
      <Panel item={proof("chatgpt")}>
        <p>ChatGPT can connect to the same MCP server through its custom MCP settings, for people whose plan has them.</p>
        <CopyField value={links.mcp} label="MCP server URL" />
        <ol>
          <li>In ChatGPT on the web, open Settings and turn on Developer Mode, or open Plugins if your account has that instead.</li>
          <li>Add a custom MCP server, give it a name and paste this URL.</li>
          <li>Choose no authentication, accept the warning and create it.</li>
        </ol>
        <p className="muted small">
          We haven&apos;t confirmed this for every ChatGPT plan. OpenAI&apos;s menus and limits differ by plan and keep changing, and ChatGPT may ask you to confirm each call or block some. It isn&apos;t listed in
          ChatGPT&apos;s directory.
        </p>
      </Panel>
    ),
  };
}
