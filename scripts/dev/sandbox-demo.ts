/**
 * End-to-end test of the demo video in a real sandbox, with no Muse Code run. Provisions a sandbox, writes a fake
 * product (a form with a photo picker, a 7 s wait under aria-busy, then a result table) and a smoke test with
 * captioned steps, runs verify (which builds it), then records the way the record step does: writeDemoSpec, the demo
 * task, finishDemo with skipUpload. Saves demo.mp4, poster.jpg, studio.json, timeline.json, the logs and a few stills
 * to outDir, and deletes the sandbox unless --keep is given.
 *
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-demo.ts <snapshotId | fresh> [outDir] [--keep]
 *
 * "fresh" ignores BUILDER_SNAPSHOT_ID and installs everything from template/ (a few minutes), to try template changes
 * before making a snapshot. A snapshot from before Demo Studio records the old way; the script says which one ran.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { stepTimeoutMs } from "@/lib/pipeline/steps";
import {
  collectVerifyResult,
  finishDemo,
  killCommand,
  pollTask,
  provisionSandbox,
  startTask,
  writeDemoSpec,
  writeProductFile,
} from "@/lib/sandbox/builder";
import { DEMO_OUT_DIR, DEMO_RECORDING_DIR, DEMO_STUDIO_MARKER, LOG_DIR, PRISTINE_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const keep = process.argv.includes("--keep");
const source = args[0];
if (source === "fresh") {
  if (process.env.VERCEL) throw new Error("fresh installs from template/, which only works from a checkout.");
  delete process.env.BUILDER_SNAPSHOT_ID;
} else if (source?.startsWith("snap_")) {
  process.env.BUILDER_SNAPSHOT_ID = source;
} else {
  throw new Error("usage: sandbox-demo.ts <snapshotId | fresh> [outDir] [--keep]");
}
const out = args[1] || "/tmp/musemuse-demo";
mkdirSync(out, { recursive: true });

const PAGE = `"use client";

import { useRef, useState, type FormEvent } from "react";
import { FilePicker } from "@/components/FilePicker";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface Row {
  day: string;
  receipts: number;
  total: number;
}

export default function Home() {
  const [store, setStore] = useState("");
  const [weeks, setWeeks] = useState("1");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);

  async function count(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRows(null);
    // Stands in for a model call, so the demo has a wait to speed up.
    await new Promise((r) => setTimeout(r, 7000));
    const n = Number(weeks);
    setRows(DAYS.map((day, i) => ({ day, receipts: (i * 3 + 2) * n, total: Math.round((i * 17.35 + 12.4) * n * 100) / 100 })));
    setBusy(false);
    requestAnimationFrame(() => {
      resultRef.current?.scrollIntoView({ block: "start" });
      resultRef.current?.focus();
    });
  }

  const sum = rows?.reduce((s, r) => s + r.total, 0) ?? 0;
  return (
    <main className="stack">
      <header className="hero">
        <h1>Receipt Counter</h1>
        <p className="tagline">Adds up a week of shop receipts, day by day.</p>
      </header>
      <form className="card fields" onSubmit={count}>
        <div className="field">
          <label htmlFor="store">Store name</label>
          <input id="store" value={store} onChange={(e) => setStore(e.target.value)} placeholder="Where you shop" required />
        </div>
        <FilePicker label="Photo of a receipt" accept="image/*" button="Choose a photo" hint="Optional" onFile={(f) => setPhoto(f?.name ?? null)} />
        <div className="field">
          <label htmlFor="weeks">Weeks</label>
          <select id="weeks" value={weeks} onChange={(e) => setWeeks(e.target.value)}>
            <option value="1">1 week</option>
            <option value="2">2 weeks</option>
            <option value="4">4 weeks</option>
          </select>
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Counting" : "Count the receipts"}
          </button>
        </div>
      </form>
      <section className="card result" aria-busy={busy} aria-live="polite">
        {busy ? <p className="meta">Reading the receipts. This takes a few seconds.</p> : null}
        {rows ? (
          <>
            <h2 ref={resultRef} tabIndex={-1}>Totals for {store}</h2>
            <p className="big-number">\${sum.toFixed(2)}</p>
            <p className="meta">{rows.reduce((s, r) => s + r.receipts, 0)} receipts{photo ? \` · read from \${photo}\` : ""} · estimate</p>
            <div className="table-wrap">
              <table aria-label="Receipts by day">
                <thead>
                  <tr><th>Day</th><th className="num">Receipts</th><th className="num">Total</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.day}><td>{r.day}</td><td className="num">{r.receipts}</td><td className="num">\${r.total.toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {!busy && !rows ? <p className="meta">Totals show up here.</p> : null}
      </section>
    </main>
  );
}
`;

// Single quotes on the first import and a type import on the second, so the demo's import rewrite sees both.
const SMOKE = `import { test, expect } from '@playwright/test';
import type { Page } from "@playwright/test";
import { judgeShot } from "./judge-shot";

async function waitForResult(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Receipts by day" })).toBeVisible();
}

test("adds up a week of receipts", async ({ page }) => {
  await test.step("Open the receipt counter", async () => {
    await page.goto("/");
    await judgeShot(page, "01-start");
  });
  await test.step("Type the name of the store", async () => {
    await page.getByLabel("Store name").fill("Corner Market");
  });
  await test.step("Attach a photo of a receipt", async () => {
    await page.getByLabel("Photo of a receipt").setInputFiles("fixtures/receipt.png");
  });
  await test.step("Count two weeks of receipts", async () => {
    await page.getByLabel("Weeks").selectOption("2");
    await page.getByRole("button", { name: "Count the receipts" }).click();
    await waitForResult(page);
  });
  await test.step("Read the totals for each day", async () => {
    await expect(page.getByRole("heading", { name: "Totals for Corner Market" })).toBeVisible();
    await judgeShot(page, "02-result");
  });
});
`;

/** A 1x1 PNG: the page only shows the file's name. */
const RECEIPT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const t0 = Date.now();
const s = (t = t0) => `${((Date.now() - t) / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a task to the end, or stops it at the step's cap like the workflow does. */
async function runTask(name: string, task: "verify" | "demo") {
  const capMs = stepTimeoutMs(task === "demo" ? "record" : "verify");
  const started = Date.now();
  const { cmdId } = await startTask(name, task);
  for (;;) {
    await sleep(3000);
    const p = await pollTask(name, cmdId);
    if (p.done) return p;
    if (Date.now() - started > capMs) {
      await killCommand(name, cmdId);
      throw new Error(`${task} ran past its ${capMs / 60_000}-minute cap and was stopped. Last output:\n${p.outputTail}`);
    }
  }
}

/** Copies one file out of the sandbox into `out`. Returns false when it isn't there. */
async function save(sb: Sandbox, from: string, name: string): Promise<boolean> {
  const buf = await sb.readFileToBuffer({ path: from }).catch(() => null);
  if (!buf) return false;
  writeFileSync(`${out}/${name}`, buf);
  return true;
}

const slug = `demo-${Date.now().toString(36)}`;
const buildId = randomUUID();
const { sandboxName } = await provisionSandbox({
  buildId,
  productId: randomUUID(),
  slug,
  references: [],
  fixtures: [],
  promptMarkdown: "# Brief\n\nDemo test.\n",
  buildToken: "mm_build_test",
  gatewayUrl: "https://example.invalid/api/gateway",
});
console.log(`provisioned ${sandboxName} from ${source} in ${s()}`);
try {
  const sb = await Sandbox.get({ name: sandboxName, resume: true });
  await writeProductFile(sandboxName, "app/page.tsx", PAGE);
  await writeProductFile(sandboxName, "tests/smoke.spec.ts", SMOKE);
  await sb.writeFiles([{ path: `${PRODUCT_DIR}/fixtures/receipt.png`, content: RECEIPT_PNG }]);
  const studio = (await sh(sb, `[ -f ${q(`${PRISTINE_DIR}/${DEMO_STUDIO_MARKER}`)} ]`, { allowFail: true })).exitCode === 0;
  console.log(studio ? "pristine copy has Demo Studio: recording with the studio" : "pristine copy has no Demo Studio: recording the old way");

  let t = Date.now();
  const v = await runTask(sandboxName, "verify");
  console.log(`verify exit ${v.exitCode} in ${s(t)}`);
  const r = await collectVerifyResult({ sandboxName, buildId, round: 0, exitCode: v.exitCode, outputTail: v.outputTail, skipUpload: true });
  console.log(`verify passed ${r.summary.passed}: ${r.summary.steps.map((x) => `${x.name}:${x.ok}`).join(" ")}`);
  if (!r.summary.passed) console.log(r.summary.failureOutput.slice(-2000));

  const spec = await writeDemoSpec(sandboxName, {
    title: "Receipt Counter",
    tagline: "Adds up a week of shop receipts, day by day.",
    models: ["Muse Spark 1.3", "SAM 3.1"],
    url: "https://musemuse-receipt-counter.vercel.app",
  });
  console.log(`spec: ${JSON.stringify(spec)}`);
  t = Date.now();
  const d = await runTask(sandboxName, "demo");
  console.log(`demo exit ${d.exitCode} in ${s(t)}\n${d.outputTail.split("\n").slice(-12).join("\n")}`);

  t = Date.now();
  const f = await finishDemo({ sandboxName, buildId, title: spec.title, subtitle: spec.tagline, skipUpload: true }).catch((err: unknown) => {
    console.log(`finishDemo threw: ${String(err)}`);
    return { videoUrl: null, posterUrl: null };
  });
  console.log(`finishDemo in ${s(t)}: ${JSON.stringify(f)}`);

  await save(sb, `${LOG_DIR}/demo.log`, "demo.log");
  await save(sb, `${LOG_DIR}/demo-basic.log`, "demo-basic.log");
  await save(sb, `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/timeline.json`, "timeline.json");
  await save(sb, `${DEMO_OUT_DIR}/studio.json`, "studio.json");
  if (f.videoUrl) {
    const mp4 = f.videoUrl.replace(`sandbox://${sandboxName}`, "");
    const probe = await sh(sb, `ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate -show_entries format=duration,size -of compact ${q(mp4)}`);
    console.log(`ffprobe: ${probe.stdout.trim().replace(/\n/g, " | ")}`);
    await save(sb, mp4, "demo.mp4");
    if (f.posterUrl) await save(sb, f.posterUrl.replace(`sandbox://${sandboxName}`, ""), "poster.jpg");
    const seconds = Number(/duration=([\d.]+)/.exec(probe.stdout)?.[1]) || 0;
    const stills: Array<[string, number]> = [0.1, 0.25, 0.5, 0.75, 0.95].map((at) => [`still-${Math.round(at * 100)}`, at * seconds]);
    for (const [name, at] of stills) {
      await sh(sb, `ffmpeg -nostdin -y -loglevel error -ss ${at.toFixed(2)} -i ${q(mp4)} -frames:v 1 /tmp/${name}.png`, { allowFail: true });
      await save(sb, `/tmp/${name}.png`, `${name}.png`);
    }
  }
  console.log(`saved to ${out}`);
} finally {
  if (keep) {
    console.log(`kept ${sandboxName}; delete it with scripts/dev/sandbox-delete.ts. Total ${s()}`);
  } else {
    const sb = await Sandbox.get({ name: sandboxName });
    await sb.delete({ deleteOrphanSnapshots: true });
    console.log(`deleted ${sandboxName}, total ${s()}`);
  }
}
