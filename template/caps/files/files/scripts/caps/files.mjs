// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for kept files:
//   manifest        musemuse.json's files block is the brief's: the same scope, for a shared space the same uploaders,
//                   search, and datasets (the brief's choices come from the gateway's record of this build, which
//                   product code can't write)
//   uploaded        the gateway saw this verify's smoke test keep a file in the build's own space
//   upload-listed   the uploaded file was still listed after a reload (tests/caps/files.ts checkFiles)
//   search-cited    when the brief searches: the gateway indexed text, and a search found the fixture with a citation
//   dataset-cited   when the brief has datasets: the gateway served one of them, and the page showed it with its license
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The brief's files choices, from the gateway's `brief:...` counts, or null when the record has none. */
export function briefFiles(proof) {
  if (!proof) return null;
  const keys = Object.keys(proof).filter((k) => k.startsWith("brief:"));
  const scope = keys.find((k) => k.startsWith("brief:scope:"))?.slice("brief:scope:".length);
  if (!scope) return null;
  const uploads = keys.find((k) => k.startsWith("brief:uploads:"))?.slice("brief:uploads:".length);
  return {
    scope,
    ...(scope === "shared" ? { uploads: uploads || "owner" } : {}),
    search: keys.includes("brief:search"),
    datasets: keys.filter((k) => k.startsWith("brief:dataset:")).map((k) => k.slice("brief:dataset:".length)).sort(),
  };
}

export function manifestFiles(root) {
  const file = path.join(root, "musemuse.json");
  const block = existsSync(file) ? readJson(file)?.files : null;
  if (!block || typeof block !== "object" || typeof block.scope !== "string") return null;
  return {
    scope: block.scope,
    ...(block.scope === "shared" ? { uploads: typeof block.uploads === "string" ? block.uploads : "owner" } : {}),
    search: block.search === true,
    datasets: Array.isArray(block.datasets) ? block.datasets.filter((d) => typeof d === "string").sort() : [],
  };
}

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);
const say = (f) => `${f.scope}${f.uploads ? ` (added by ${f.uploads})` : ""}, search ${f.search ? "on" : "off"}, datasets ${f.datasets.join(", ") || "none"}`;

export async function check({ record, proof, root }) {
  const out = [];
  const brief = briefFiles(proof);
  const manifest = manifestFiles(root);
  if (!brief) out.push({ id: "manifest", ok: false, detail: "the gateway's record of the brief's files block is missing" });
  else if (!manifest) out.push({ id: "manifest", ok: false, detail: "musemuse.json has no files block" });
  else out.push({ id: "manifest", ok: JSON.stringify(brief) === JSON.stringify(manifest), detail: `musemuse.json has ${say(manifest)}; the brief has ${say(brief)}` });

  const uploaded = Number(proof?.uploaded ?? 0);
  out.push({ id: "uploaded", ok: uploaded > 0, detail: proof ? `the gateway kept ${uploaded} file${uploaded === 1 ? "" : "s"} in this build's space during this check` : "the gateway's record is missing" });

  const listed = recorded(record, "upload-listed");
  out.push({ id: "upload-listed", ok: listed?.ok === true, detail: listed?.detail ?? "the smoke test didn't run checkFiles" });

  if (brief?.search) {
    const cited = recorded(record, "search-cited");
    const indexed = Number(proof?.indexed ?? 0);
    out.push({
      id: "search-cited",
      ok: cited?.ok === true && indexed > 0,
      detail: cited?.ok !== true ? (cited?.detail ?? "the smoke test didn't search with checkFiles") : indexed > 0 ? cited.detail : "the gateway indexed no text during this check",
    });
  }
  if (brief?.datasets.length) {
    const cited = recorded(record, "dataset-cited");
    const read = brief.datasets.some((d) => Number(proof?.[`dataset:${d}`] ?? 0) > 0);
    out.push({
      id: "dataset-cited",
      ok: cited?.ok === true && read,
      detail: cited?.ok !== true ? (cited?.detail ?? "the smoke test didn't check a dataset with checkFiles") : read ? cited.detail : `the gateway served none of ${brief.datasets.join(", ")} during this check`,
    });
  }
  return out;
}
