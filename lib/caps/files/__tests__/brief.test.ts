/**
 * The files cap's brief block, writer rules, catalog, build prompt and judge note (docs/CAPABILITIES.md, 2.6 and section
 * 10), with FILES_SEARCH, FILES_DATASETS and DATA_SIGN_IN off and on.
 *
 *   npx tsx --test lib/caps/files/__tests__/brief.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BriefSchema, type Brief } from "@/lib/brief/schema";
import { capsWriterRules, writerBriefField } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks } from "@/lib/caps/catalog";
import { filesCatalogBlock } from "@/lib/caps/files/catalog";
import { FilesBriefBlock, filesRule, filesWriterBlock, filesWriterRules, normalizeFilesBlock } from "@/lib/caps/files/brief";
import { filesJudgeNote } from "@/lib/caps/files/judge";
import { FILES_RENDER } from "@/lib/caps/files/render";
import { capsBuildLines } from "@/lib/caps/render";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const SWITCHES = ["FILES_SEARCH", "FILES_DATASETS", "DATA_SIGN_IN"] as const;
afterEach(() => {
  for (const k of SWITCHES) delete process.env[k];
});
const on = (...names: Array<(typeof SWITCHES)[number]>) => {
  for (const n of names) process.env[n] = "1";
};

const block = { holds: "Field notes as text files and photos", scope: "shared", uploads: "anyone", search: true, datasets: ["palmer-penguins"] } as const;
const brief = (files: unknown = block) => ({ ...BRIEF, files }) as unknown as Brief;
const noEmDash = (s: string) => assert.ok(!s.includes("—"), "no em dashes");

describe("the files brief block", () => {
  it("parses in the stored brief, and an older brief parses without it", () => {
    assert.equal(BriefSchema.parse(brief()).files?.scope, "shared");
    assert.ok(!("files" in BriefSchema.parse(BRIEF)) || BriefSchema.parse(BRIEF).files == null);
    assert.equal(FilesBriefBlock.safeParse({ ...block, datasets: ["a", "b", "c", "d"] }).success, false, "at most 3 datasets");
  });

  it("the writer's block follows DATA_SIGN_IN and FILES_DATASETS", () => {
    assert.equal(filesWriterBlock().safeParse({ ...block, scope: "user", uploads: "owner", datasets: [] }).success, false, "no user scope without sign-in");
    assert.equal(filesWriterBlock().safeParse({ ...block, datasets: [] }).success, true);
    assert.equal(filesWriterBlock().safeParse(block).success, false, "no datasets while FILES_DATASETS is off");
    on("FILES_DATASETS", "DATA_SIGN_IN");
    assert.equal(filesWriterBlock().safeParse(block).success, true);
    assert.equal(filesWriterBlock().safeParse({ ...block, datasets: ["made-up"] }).success, false, "only vetted ids");
    assert.equal(filesWriterBlock().safeParse({ ...block, scope: "user", uploads: "owner" }).success, true);
    assert.ok(writerBriefField("files"), "registered for the writer");
  });

  it("normalize: private scopes upload as their own person, switches that are off clear their parts, unknown datasets go", () => {
    assert.deepEqual(normalizeFilesBlock({ ...block, scope: "visitor" }), { ...block, scope: "visitor", uploads: "owner", search: false, datasets: [] });
    assert.deepEqual(normalizeFilesBlock({ ...block, scope: "user", uploads: "signed_in" }), { ...block, scope: "visitor", uploads: "owner", search: false, datasets: [] }, "nobody can sign in");
    on("FILES_SEARCH", "FILES_DATASETS");
    const n = normalizeFilesBlock({ ...block, datasets: ["palmer-penguins", "nope", "palmer-penguins"] }) as typeof block;
    assert.deepEqual(n.datasets, ["palmer-penguins"]);
    assert.equal(n.search, true);
    assert.equal((normalizeFilesBlock({ ...block, uploads: "everyone" }) as { uploads: string }).uploads, "owner");
    assert.equal((normalizeFilesBlock({ ...block, scope: "user" }, { signIn: true }) as { scope: string }).scope, "user", "kept when the brief signs people in");
  });

  it("filesRule keeps only vetted datasets and makes a private scope's uploads the owner's", () => {
    assert.deepEqual(filesRule({ ...block, datasets: ["palmer-penguins", "nope"] }), { scope: "shared", uploads: "anyone", search: true, datasets: ["palmer-penguins"] });
    assert.equal(filesRule({ ...block, scope: "visitor" })!.uploads, "owner");
    assert.equal(filesRule(null), null);
  });
});

describe("the files cap's text", () => {
  it("writer rules and catalog name search and the datasets only while their switches are on", () => {
    const off = filesWriterRules().join("\n");
    assert.match(off, /files\.search: false\./);
    assert.match(off, /files\.datasets: \[\]\./);
    assert.doesNotMatch(off, /user when/);
    assert.doesNotMatch(filesCatalogBlock(), /files\.search|palmer-penguins/);
    on("FILES_SEARCH", "FILES_DATASETS", "DATA_SIGN_IN");
    const rules = filesWriterRules().join("\n");
    assert.match(rules, /palmer-penguins \(Palmer penguins, CC0-1\.0\)/);
    assert.match(rules, /user when they follow a person who signs in/);
    const catalog = filesCatalogBlock();
    assert.match(catalog, /files\.search/);
    assert.match(catalog, /palmer-penguins \(Palmer penguins, CC0-1\.0\)/);
    assert.match(capsWriterRules(["files"]), /^\n\nPlatform services\n- files: /);
    assert.equal(capsCatalogBlocks(["files"]).length, 3);
    for (const s of [rules, catalog]) noEmDash(s);
  });

  it("the build prompt has its section in 2.6's order, and leaves out what is switched off", () => {
    const offLines = FILES_RENDER.build(brief()).join("\n");
    assert.doesNotMatch(offLines, /search\(request\)|dataset\(request/, "search and datasets are off");
    assert.match(offLines, /"files": \{"scope":"shared","uploads":"anyone","search":false,"datasets":\[\]\}/);
    on("FILES_SEARCH", "FILES_DATASETS");
    const lines = capsBuildLines(brief()).join("\n");
    assert.match(lines, /## Platform services\n\n### Files and search\n/);
    const order = ["The brief asks for", "muse-files/SKILL.md", "uploadFile", "search(request)", "dataset(request", "musemuse.json", "Limits a user can hit", "test space", "checkFiles", "template/AGENTS.md", "platform files"];
    let at = -1;
    for (const word of order) {
      const next = lines.indexOf(word, at + 1);
      assert.ok(next > at, `${word} comes after the line before it`);
      at = next;
    }
    assert.match(lines, /"files": \{"scope":"shared","uploads":"anyone","search":true,"datasets":\["palmer-penguins"\]\}/);
    assert.match(lines, /Uploaded files stay in memory for the request/, "names the AGENTS.md rule that doesn't hold");
    noEmDash(lines);
    assert.match(FILES_RENDER.refine!(brief()).join("\n"), /musemuse\.json`'s `files` block/);
    assert.match(FILES_RENDER.markdown!(brief()).join("\n"), /Scope: shared, added by any visitor\. Search: yes\. Datasets: Palmer penguins \(CC0-1\.0\)\./);
    assert.deepEqual(FILES_RENDER.build(BRIEF as unknown as Brief), [], "nothing for a brief without the block");
  });

  it("the judge note asks for sources only when the product has them", () => {
    assert.match(filesJudgeNote(brief()), /show where they came from/);
    assert.doesNotMatch(filesJudgeNote(brief({ ...block, search: false, datasets: [] })), /came from/);
    assert.match(capsJudgeNotes(brief()), /Platform services in this product/);
    assert.equal(capsJudgeNotes(BRIEF), "");
  });
});
