/**
 * Writes lib/tools/composio/catalog.json from lib/tools/catalog.source.ts and what Composio reports.
 *
 *   npm run tools:sync            write the file
 *   npm run tools:sync -- --check fail if the file is out of date, and list the tools newer than their pin
 *
 * Reads schemas, tags and prices only: no tool runs and nothing is charged. It needs COMPOSIO_API_KEY.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TOOL_POLICIES, TOOLKIT_PINS } from "@/lib/tools/catalog.source";
import { buildCatalog, CatalogRefusal, stableJson, type RemoteTool, type RemoteToolkit } from "@/lib/tools/composio/sync";

const BASE = "https://backend.composio.dev/api/v3.1";
const OUTPUT = path.join(process.cwd(), "lib/tools/composio/catalog.json");

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error("COMPOSIO_API_KEY is not set.");
  process.exit(1);
}

const getJson = async (pathname: string): Promise<unknown> => {
  const res = await fetch(`${BASE}${pathname}`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Composio answered ${res.status} for ${pathname}`);
  return res.json();
};

const fetchTool = async (slug: string, version?: string): Promise<RemoteTool> => {
  const query = new URLSearchParams({ include_pricing: "true" });
  if (version) query.set("version", version);
  return (await getJson(`/tools/${encodeURIComponent(slug)}?${query}`)) as RemoteTool;
};

type ToolkitReply = { slug: string; meta?: { categories?: { slug?: string; name?: string }[] } };

const fetchToolkit = async (slug: string): Promise<RemoteToolkit> => {
  const reply = (await getJson(`/toolkits/${encodeURIComponent(slug)}`)) as ToolkitReply;
  return {
    slug: reply.slug,
    categories: (reply.meta?.categories ?? []).flatMap((c) => [c.slug, c.name].filter((v): v is string => Boolean(v))),
  };
};

const main = async () => {
  const check = process.argv.includes("--check");
  const { catalog, notes } = await buildCatalog(TOOL_POLICIES, TOOLKIT_PINS, { fetchTool, fetchToolkit });
  const next = stableJson(catalog);
  for (const note of notes) console.log(`note: ${note}`);

  if (check) {
    const current = existsSync(OUTPUT) ? await readFile(OUTPUT, "utf8") : "";
    if (current !== next) {
      console.error("lib/tools/composio/catalog.json is out of date. Run npm run tools:sync.");
      process.exit(1);
    }
    console.log(`Catalog is up to date: ${catalog.tools.length} tools.`);
    return;
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, next);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}: ${catalog.tools.length} tools.`);
};

main().catch((error: unknown) => {
  console.error(error instanceof CatalogRefusal ? `Refused: ${error.message}` : error instanceof Error ? error.message : "The sync failed.");
  process.exit(1);
});
