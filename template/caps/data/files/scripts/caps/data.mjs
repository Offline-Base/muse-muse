// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for saved data:
//   manifest         musemuse.json's data collections are the brief's, with the same scopes and, for shared ones, the
//                    same writers (the brief's list comes from the gateway's record of this build, which product code
//                    can't write)
//   writes           the gateway saw this verify's smoke test save items in the build's own space
//   second-browser   a second browser, after a reload, saw the shared item (tests/caps/data.ts)
//   visitor-private  a second browser didn't see a private item, when the brief has visitor or user collections
//   user-follows     the same made-up person, signed in on the second browser, saw their item, when the brief has a user
//                    collection; and the gateway saw a signed-in person write
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The brief's collections, from the gateway's `brief:<name>:<scope>` (`brief:<name>:shared:<writes>`) counts. */
export function briefCollections(proof) {
  if (!proof) return null;
  return Object.keys(proof)
    .filter((k) => k.startsWith("brief:"))
    .map((k) => {
      const [, name, scope, writes] = k.split(":");
      return scope === "shared" ? { name, scope, writes: writes || "owner" } : { name, scope };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function manifestCollections(root) {
  const file = path.join(root, "musemuse.json");
  const manifest = existsSync(file) ? readJson(file) : null;
  const list = manifest?.data?.collections;
  if (!Array.isArray(list)) return null;
  return list
    .filter((c) => c && typeof c.name === "string" && typeof c.scope === "string")
    .map((c) => (c.scope === "shared" ? { name: c.name, scope: c.scope, writes: typeof c.writes === "string" ? c.writes : "owner" } : { name: c.name, scope: c.scope }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);

export async function check({ record, proof, root }) {
  const out = [];
  const brief = briefCollections(proof);
  const manifest = manifestCollections(root);
  const say = (list) => list.map((c) => `${c.name} (${c.scope}${c.writes ? `, written by ${c.writes}` : ""})`).join(", ") || "none";
  if (!brief) out.push({ id: "manifest", ok: false, detail: "the gateway's record of the brief's collections is missing" });
  else if (!manifest) out.push({ id: "manifest", ok: false, detail: "musemuse.json has no data.collections" });
  else out.push({ id: "manifest", ok: JSON.stringify(brief) === JSON.stringify(manifest), detail: `musemuse.json has ${say(manifest)}; the brief has ${say(brief)}` });

  const writes = Number(proof?.writes ?? 0);
  out.push({ id: "writes", ok: writes > 0, detail: proof ? `the gateway saw ${writes} item${writes === 1 ? "" : "s"} saved in this build's space` : "the gateway's record is missing" });

  const shared = (brief ?? []).some((c) => c.scope === "shared");
  const priv = (brief ?? []).some((c) => c.scope === "visitor" || c.scope === "user");
  const user = (brief ?? []).some((c) => c.scope === "user");
  const second = recorded(record, "second-browser");
  if (shared || !brief) out.push({ id: "second-browser", ok: second?.ok === true, detail: second?.detail ?? "the smoke test didn't run checkSecondBrowser with a shared item" });
  if (priv) {
    const hidden = recorded(record, "visitor-private");
    out.push({ id: "visitor-private", ok: hidden?.ok === true, detail: hidden?.detail ?? "the smoke test didn't check that a private item stays private" });
  }
  if (user) {
    const follows = recorded(record, "user-follows");
    const users = Number(proof?.users ?? 0);
    out.push({
      id: "user-follows",
      ok: follows?.ok === true && users > 0,
      detail: follows?.ok !== true ? (follows?.detail ?? "the smoke test didn't sign the same person in on a second browser") : users > 0 ? follows.detail : "the gateway saw no signed-in person save anything",
    });
  }
  return out;
}
