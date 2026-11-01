import type { CapRenderEntry } from "@/lib/caps/render";
import { filesBlock, filesRule, type FilesBrief } from "@/lib/caps/files/brief";
import { vettedDatasets, type Dataset } from "@/lib/caps/files/datasets";
import { FILES_LIMITS } from "@/lib/caps/files/limits";
import { filesDatasetsOn, filesSearchOn } from "@/lib/caps/files/types";
import { env } from "@/lib/env";

/**
 * The files cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 10). Its text names the platform files in
 * template/caps/files: lib/platform/files.ts, lib/platform/search.ts, lib/platform/datasets.ts,
 * components/platform/Citation.tsx, app/api/musemuse/files and its routes, tests/caps/files.ts and the muse-files skill.
 * Search and datasets appear only while their switches are on, so a stored brief built later with one off goes without.
 */

const SCOPE_WORDS: Record<FilesBrief["scope"], string> = {
  shared: "shared: everyone on the product sees them",
  visitor: "visitor: they stay with one browser",
  owner: "owner: only the product's owner",
  user: "user: they follow a person who signs in",
};

const UPLOADER_WORDS: Record<FilesBrief["uploads"], string> = { owner: "the owner", signed_in: "anyone signed in", anyone: "any visitor" };

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function chosen(block: FilesBrief): { search: boolean; datasets: Dataset[] } {
  const rule = filesRule(block)!;
  const all = filesDatasetsOn() ? vettedDatasets() : [];
  return { search: rule.search && filesSearchOn(), datasets: all.filter((d) => rule.datasets.includes(d.id)) };
}

function manifestLine(block: FilesBrief, search: boolean, datasets: Dataset[]): string {
  const files = { scope: block.scope, ...(block.scope === "shared" ? { uploads: block.uploads } : {}), search, datasets: datasets.map((d) => d.id) };
  return `- \`musemuse.json\` gets \`"files"\` in its \`caps\` list and \`"files": ${JSON.stringify(files)}\`, exactly this. Verify checks it against the brief.`;
}

export const FILES_RENDER: CapRenderEntry = {
  title: "Files and search",
  build(brief) {
    const block = filesBlock(brief);
    if (!block) return [];
    const { search, datasets } = chosen(block);
    const shared = block.scope === "shared";
    return [
      `The brief asks for files people keep on the platform: ${cell(block.holds)}`,
      "",
      `- Scope: ${SCOPE_WORDS[block.scope]}.${shared ? ` Who adds files: ${UPLOADER_WORDS[block.uploads]}. Only the owner deletes them.` : " Each person adds and deletes their own."}`,
      ...(search ? ["- Search: on. The product indexes the text of its files (and saved items, if it has any) and shows where each answer came from."] : []),
      ...(datasets.length ? [`- Datasets: ${datasets.map((d) => `\`${d.id}\` (${d.title}, ${d.license.spdx}; files ${d.files.map((f) => `\`${f.name}\``).join(", ")})`).join("; ")}.`] : []),
      "",
      "- Read `.agents/skills/muse-files/SKILL.md` first. It has the helper calls, the scope rules and the test helpers.",
      `- Uploads: in the browser, \`uploadFile(file, { scope })\` from \`lib/platform/files-browser.ts\` sends the file straight to storage through the product's own \`/api/musemuse/files\` route and returns \`{ id, name, contentType, bytes, url }\`. It takes pictures, audio, video, PDF and plain text (txt, csv, md, json) up to ${env.filesMaxFileMb} MB.`,
      `- On the server, in route handlers or server actions: \`files(request)\` from \`lib/platform/files.ts\` with \`.list({ scope, after })\`, \`.get(id)\` (the file's facts and a read URL good for an hour) and \`.delete(id)\`. Pass the incoming request (or \`await headers()\`), so the gateway knows who is asking. Show a picture with \`<img src={file.url}>\`; read a file's bytes on the server with \`fetch(file.url)\`.`,
      ...(search
        ? [
            "- Search: `search(request).index({ source: { fileId }, title, text })` adds text, `search(request).query(q)` gives ranked hits with a snippet and a `citation` `{ source, name, offset }`, and `search(request).remove({ source })` takes text out. Index a file's text right after its upload: plain text as it is, and text in a PDF or a photo from the product's own Muse Wonder call (`metaClient(request)`), which spends from its Meta budget.",
            "- Every answer that comes from a file, an item or a dataset shows `<Citation citation={hit.citation} />` from `components/platform/Citation.tsx` beside it: the file's name, where in its text, and for a dataset its license. Never state something as from a file without one.",
          ]
        : []),
      ...(datasets.length
        ? [
            "- Datasets: `dataset(request, \"<id>\").text(\"<file>\")` (or `.bytes(...)`) from `lib/platform/datasets.ts` reads a vetted file through the gateway and checks its sha256. Show `<Citation citation={datasetCitation(info)} />` (from `components/platform/Citation.tsx`, with `info` from `dataset(request, id).info()`) where its data is used, so the license is on screen.",
          ]
        : []),
      manifestLine(block, search, datasets),
      shared
        ? "- Shared files: everyone on the product can open them. Never put personal details in one, and say on the upload button who will see the file."
        : `- ${block.scope === "visitor" ? "Visitor files stay with this browser (its mm_vid cookie). Clearing the site's data loses them, so say so next to the list." : block.scope === "owner" ? "Owner files need the product's owner pass: only the owner, opened from Muse Muse, adds and reads them." : "User files follow the person who signed in. Without a session the list is empty and an upload answers `sign_in_required`."}`,
      "- Give people a way to delete what they uploaded (`files(request).delete(id)`), and say plainly that files are kept until then, not for a day.",
      `- Limits a user can hit: ${env.filesMaxFileMb} MB a file, ${FILES_LIMITS.subjectBytes / 1024 / 1024} MB a person, ${env.filesProductMb} MB and ${FILES_LIMITS.filesPerProduct.toLocaleString("en-US")} files for the product. A refused upload is a \`CapError\` with \`code\` \`quota_exceeded\` or \`invalid_arguments\`: show its message next to the upload button. An upload can also be refused after it is sent, when the product filled up meanwhile: show that message too.`,
      "- In this build every file is a real file in the build's own test space, deleted when the build ends. Nothing a real person uploaded reaches it.",
      "- A test's browser is a visitor, as on the live product. `openAsOwner(page)` from `tests/caps/files.ts` makes it the owner for the owner's own steps.",
      `- Smoke test: call \`checkFiles(page, { upload: "fixtures/<file>", listed: "<its name>"${search ? ', search: { q: "<a phrase in it>", expect: "<text the hit shows>" }' : ""}${datasets.length ? ', dataset: { shows: "<text the page shows from the dataset>" }' : ""} })\` from \`tests/caps/files.ts\` once. It uploads the fixture through the page's file input (the input needs \`data-testid="file-upload"\`), reloads, expects the file listed${search ? ", searches with the page's search box (`data-testid=\"file-search\"`) and expects a hit with a citation on screen" : ""}${datasets.length ? ", and expects the dataset's text and its citation" : ""}, takes the judge screenshot captioned "After a reload", and records the checks. Keep the smoke test to about 20 files and search calls.`,
      "- `template/AGENTS.md` says \"Uploaded files stay in memory for the request\" and that a file sent with `uploadMedia` is kept for up to a day. That holds for files sent to the model. Files kept with `uploadFile` stay until someone deletes them, so say that instead. It also says the build machine reaches only npm, the Meta API and the Muse Muse gateway: files go through that gateway and its storage, so nothing more is opened.",
      "- `lib/platform/files.ts`, `lib/platform/files-browser.ts`, `lib/platform/search.ts`, `lib/platform/datasets.ts`, `components/platform/Citation.tsx`, the routes in `app/api/musemuse/files` and `tests/caps/files.ts` are platform files. Wrap them, never edit them.",
    ];
  },
  refine(brief) {
    const block = filesBlock(brief);
    if (!block) return [];
    const { search, datasets } = chosen(block);
    return [
      `- It keeps ${block.scope} files through the platform with \`files(request)\` and \`uploadFile\` (\`.agents/skills/muse-files/SKILL.md\`)${search ? ", searches them with `search(request)` and shows a `Citation` with each answer" : ""}${datasets.length ? `, and reads ${datasets.map((d) => `\`${d.id}\``).join(", ")} with \`dataset(request, id)\`` : ""}. Keep that, and keep \`musemuse.json\`'s \`files\` block in step with it.`,
    ];
  },
  markdown(brief) {
    const block = filesBlock(brief);
    if (!block) return [];
    const { search, datasets } = chosen(block);
    return [
      `Keeps: ${cell(block.holds)}`,
      "",
      `Scope: ${block.scope}${block.scope === "shared" ? `, added by ${UPLOADER_WORDS[block.uploads]}` : ""}. Search: ${search ? "yes" : "no"}.${datasets.length ? ` Datasets: ${datasets.map((d) => `${d.title} (${d.license.spdx})`).join(", ")}.` : ""}`,
    ];
  },
};
