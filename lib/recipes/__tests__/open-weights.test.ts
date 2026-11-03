import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAC_CHECK_IDS, checkDiagnosis, defaultHosts, planMacCluster } from "../skills/recipe-open-weights/helpers/mac-cluster";
import { checkConversation, csvToConversations, duplicateLines, parseJsonl, recipeFiles, splitHeldOut, toJsonl, trainedSegments } from "../skills/recipe-open-weights/helpers/sft-data";
import { grpoAdvantages, lastBoxed, readGroup, score, summarizeSpread, withTaskSnippet } from "../skills/recipe-open-weights/helpers/grpo";

describe("recipe-open-weights: Mac cluster kit", () => {
  it("plans two and four Macs from the page's numbers", () => {
    const two = planMacCluster({ macs: 2, memoryGb: 512, hosts: defaultHosts(2) });
    assert.deepEqual(two.problems, []);
    assert.equal(two.sharePerMacGb, 268.5);
    assert.equal(two.links.length, 1);
    assert.equal(two.cables, 2);
    const four = planMacCluster({ macs: 4, memoryGb: 256, hosts: defaultHosts(4) });
    assert.deepEqual(four.problems, []);
    assert.equal(four.sharePerMacGb, 134.25);
    assert.equal(four.links.length, 6);
    assert.match(four.setupScript, /--backend jaccl --env MLX_METAL_FAST_SYNCH=1/);
    assert.match(four.commands.find((c) => c.id === "hostfile")!.code, /--hosts mac-studio-1\.local,mac-studio-2\.local,mac-studio-3\.local,mac-studio-4\.local --over thunderbolt/);
    const hostfile = JSON.parse(four.hostfileSkeleton) as Array<{ ssh: string; ips: string[]; rdma: unknown[] }>;
    hostfile.forEach((h, i) => assert.equal(h.rdma[i], null));
    assert.equal(hostfile[1].ips.length, 0);
  });

  it("refuses what the recipe doesn't cover, and host names a shell would run", () => {
    assert.ok(planMacCluster({ macs: 2, memoryGb: 256, hosts: defaultHosts(2) }).problems.some((p) => /512 GB/.test(p)));
    assert.ok(planMacCluster({ macs: 3, memoryGb: 512, hosts: defaultHosts(3) }).problems.length);
    assert.ok(planMacCluster({ macs: 2, memoryGb: 512, hosts: ["mac-1.local", "mac 2; rm -rf ~"] }).problems.some((p) => /aren't host names/.test(p)));
  });

  it("keeps a doctor's answer only when it names a known check", () => {
    assert.ok(MAC_CHECK_IDS.includes("rdma"));
    assert.equal(checkDiagnosis("none"), "none");
    assert.equal(checkDiagnosis("gpu-drivers"), null);
    assert.match((checkDiagnosis("rdma") as { fix: string }).fix, /rdma_ctl enable/);
  });
});

describe("recipe-open-weights: SFT data studio", () => {
  const sample = [
    '{"messages": [{"role": "user", "content": "Do you fix flat tires?"}, {"role": "assistant", "content": "Yes, same day."}]}',
    '{"messages": [{"role": "user", "content": "Hours?"}, {"role": "assistant", "content": ""}]}',
    '{"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}, {"role": "user", "content": "Bye"}]}',
    '{"messages": [{"role": "user", "content": "Do you fix flat tires?"}, {"role": "assistant", "content": "Yes, same day."}]}',
    '{"messages": [{"role": "user", "content": [{"type": "audio", "path": "/data/a.mp3"}, {"type": "text", "text": "Transcribe this audio."}]}, {"role": "assistant", "content": "Hi."}]}',
    "not json",
  ].join("\n");

  it("finds each planted problem", () => {
    const lines = parseJsonl(sample);
    assert.equal(lines.find((l) => l.line === 6)?.error, "This line isn't valid JSON.");
    const checks = lines.filter((l) => !l.error).map((l) => checkConversation(l.row, l.line));
    assert.deepEqual(checks[0].errors, []);
    assert.ok(checks[1].errors.some((e) => /empty/.test(e)));
    assert.ok(checks[2].warnings.some((w) => /Ends on a user/.test(w)));
    assert.ok(checks[4].errors.some((e) => /WAV/.test(e)));
    assert.ok(checkConversation({ messages: [{ role: "user", content: "x" }] }, 9).errors.some((e) => /No assistant reply/.test(e)));
    assert.deepEqual(duplicateLines(lines), [4]);
  });

  it("trains only the assistant's reply and its recipient", () => {
    const segs = trainedSegments({ messages: [{ role: "user", content: "What is 2+2?" }, { role: "assistant", content: "4" }] });
    assert.deepEqual(segs.filter((s) => s.trained).map((s) => s.text), [" to=user<|message|>4<|eot|>"]);
    assert.equal(segs[0].trained, false);
  });

  it("parses a CSV with a quoted comma, splits the same way twice, and pins the date", () => {
    const rows = csvToConversations('question,answer\n"Open Sunday, too?",Yes from 10 to 4\nPrice of a tune-up?,$45\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].messages[0].content, "Open Sunday, too?");
    const many = Array.from({ length: 30 }, (_, i) => i);
    assert.deepEqual(splitHeldOut(many, 7), splitHeldOut(many, 7));
    assert.equal(splitHeldOut(many, 7).heldOut.length, 3);
    assert.equal(toJsonl(rows).trim().split("\n").length, 2);
    const files = recipeFiles({ dataPaths: ["/data/train.jsonl"], date: "2026-11-03", media: false });
    assert.match(files.recipePy, /current_date="2026-11-03"/);
    assert.match(files.run, /CONFIG=muse_spark_debugmodel_sft/);
    assert.match(recipeFiles({ dataPaths: ["/d/a.jsonl"], date: "2026-11-03", media: true }).recipePy, /816B-A42B_mm/);
  });
});

describe("recipe-open-weights: reward spread", () => {
  it("scores the three rewards", () => {
    assert.equal(lastBoxed("first \\boxed{1} then \\boxed{\\frac{1}{2}}"), "\\frac{1}{2}");
    assert.equal(score("boxed", "Answer: \\boxed{1,240}", "1240").reward, 1);
    assert.equal(score("boxed", "Answer: 1240", "1240").reward, 0);
    assert.equal(score("exact", " 42 ", "42").reward, 1);
    assert.equal(score("number", "So about 1,198 crates.", "1200", 5).reward, 1);
  });

  it("reads groups: no signal, truncation, learns", () => {
    assert.equal(grpoAdvantages([1, 1, 1, 1]).noSignal, true);
    const adv = grpoAdvantages([1, 0, 0, 1]).advantages;
    assert.ok(adv[0] > 0 && adv[1] < 0);
    assert.equal(readGroup([{ reward: 1, cutOff: false }, { reward: 0, cutOff: true }]).kind, "truncation");
    assert.equal(readGroup([{ reward: 1, cutOff: false }, { reward: 0, cutOff: false }]).kind, "learns");
    const easy = summarizeSpread([
      [{ reward: 1, cutOff: false }, { reward: 1, cutOff: false }],
      [{ reward: 1, cutOff: false }, { reward: 1, cutOff: false }],
      [{ reward: 1, cutOff: false }, { reward: 0, cutOff: false }],
    ]);
    assert.equal(easy.learns, 1);
    assert.match(easy.verdict, /already solves most/);
    assert.match(withTaskSnippet("Crate Counts"), /def muse_spark_crate_counts\(\)/);
  });
});
