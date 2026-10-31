import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { DOCS_PAGES, docsMarkdown, docsNav, docsPage } from "@/lib/docs/pages";
import { buildSearchIndex, searchDocs, type SearchHit, type SearchIndex } from "@/lib/docs/search";
import { env } from "@/lib/env";
import { emit } from "@/lib/events";
import { handleBuildMcp, type BuildMcpDeps, type DocsHit } from "@/lib/mcp/build-mcp";
import { catalogSummary } from "@/lib/prompts/catalog";

// The build MCP server that Muse Code inside a build's sandbox calls (lib/mcp/build-mcp.ts), with the build's own token.
// The docs tools read the mirrored Markdown from disk, which next.config.ts traces into this function.
export const runtime = "nodejs";
export const maxDuration = 60;

/** How a note from Muse Code reads in the build room. */
const NOTE_PREFIX = "Muse Code: ";
/** Notes one build may add, so a run that loops can't flood its room. */
const MAX_NOTES = 40;

let index: SearchIndex | null = null;

/** The docs search index, built once per function instance from the mirror. */
function docsIndex(): SearchIndex {
  index ??= buildSearchIndex({ pages: DOCS_PAGES, nav: docsNav(), markdown: docsMarkdown });
  return index;
}

/** A search hit as the tools give it: the page's slug and the section's anchor instead of an href. */
function hitOf(hit: SearchHit): DocsHit {
  const [path = "", anchor] = hit.href.split("#");
  return {
    slug: path.replace(/^\/docs\//, ""),
    ...(anchor ? { anchor } : {}),
    title: hit.title,
    context: hit.context,
    ...(hit.description ? { description: hit.description } : {}),
  };
}

const deps: BuildMcpDeps = {
  secret: () => env.gatewayTokenPepper,
  async findBuild(buildId) {
    const [row] = await db().select({ status: schema.builds.status }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
    return row ?? null;
  },
  async addNote(buildId, text) {
    const [row] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.buildEvents)
      .where(
        and(
          eq(schema.buildEvents.buildId, buildId),
          eq(schema.buildEvents.type, "log"),
          sql`${schema.buildEvents.payload}->>'text' like ${`${NOTE_PREFIX}%`}`,
        ),
      );
    if (Number(row?.n ?? 0) >= MAX_NOTES) return false;
    await emit(buildId, { type: "log", text: `${NOTE_PREFIX}${text}` });
    return true;
  },
  searchDocs: (query, limit) => searchDocs(docsIndex(), query, limit).map(hitOf),
  readDoc(slug) {
    const page = docsPage(slug);
    return page ? { title: page.title, markdown: docsMarkdown(slug) } : null;
  },
  models: () => catalogSummary(),
};

async function handle(req: Request) {
  try {
    return await handleBuildMcp(req, deps);
  } catch (err) {
    console.error("[build-mcp] failed:", err);
    return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
