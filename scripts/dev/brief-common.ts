// Shared helpers for the brief, fixture and judge test scripts (scripts/dev/brief-*.ts).
// Run any of them with: npx tsx --env-file=.env.local scripts/dev/brief-<name>.ts
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BriefSchema, type Brief } from "@/lib/brief/schema";
import { metaPlatform } from "@/lib/meta/platform";
import type { ModelUsage, Reference } from "@/lib/types";

/** Generated test media lives outside the repo. */
export const MEDIA_DIR = join(tmpdir(), "musemuse-brief-test");
mkdirSync(MEDIA_DIR, { recursive: true });

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[${label}] ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

export function printUsage(usage: ModelUsage[], costUsd: number): void {
  for (const u of usage) {
    const parts = [`in ${u.inputTokens} (cached ${u.cachedInputTokens})`, `out ${u.outputTokens}`];
    if (u.images) parts.push(`images ${u.images}`);
    if (u.audioSeconds) parts.push(`audio ${u.audioSeconds.toFixed(1)} s`);
    console.log(`  usage ${u.model}: ${parts.join(", ")}, $${u.costUsd.toFixed(5)}`);
  }
  console.log(`  total cost $${costUsd.toFixed(5)}`);
}

export function assertBrief(brief: Brief): void {
  const r = BriefSchema.safeParse(brief);
  if (!r.success) throw new Error(`Brief failed BriefSchema: ${JSON.stringify(r.error.issues)}`);
  const strings = JSON.stringify(brief);
  if (strings.includes("—")) throw new Error("Brief contains an em dash");
  console.log("  BriefSchema: valid, no em dashes");
}

export function excerpt(brief: Brief): void {
  console.log(
    JSON.stringify(
      {
        verdict: brief.verdict,
        refusal: brief.refusal,
        name: brief.name,
        slug: brief.slug,
        tagline: brief.tagline,
        user: brief.user,
        references: brief.inspiration.references.map((r) => `${r.index} ${r.kind}: ${r.describes.slice(0, 220)}`),
        borrow: brief.inspiration.borrow,
        dontCopy: brief.inspiration.dontCopy,
        primaryFlow: brief.primaryFlow,
        capabilities: brief.capabilities.map((c) => `${c.model}: ${c.need}`),
        limits: brief.limits,
        complexity: brief.complexity,
        cost: `${brief.estimatedCostPerRunUsd} (${brief.costNotes.slice(0, 200)})`,
        fixtures: brief.fixtures,
        actions: brief.actions,
      },
      null,
      2,
    ),
  );
}

export function dataUrl(bytes: Buffer, contentType: string): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

/** Makes (or reuses) a JPEG with Muse Image. Costs $0.01 the first time. */
export async function cachedImage(name: string, prompt: string, size: "1536x1024" | "1024x1536" = "1536x1024"): Promise<Buffer> {
  const path = join(MEDIA_DIR, `${name}.jpg`);
  if (existsSync(path)) return readFileSync(path);
  const res = await timed(`muse-image ${name}`, () =>
    metaPlatform().images.generate({ model: "muse-image-1.0", prompt, n: 1, size, output_format: "jpeg" }),
  );
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("Muse Image returned no image");
  const bytes = Buffer.from(b64, "base64");
  writeFileSync(path, bytes);
  console.log(`  wrote ${path} (${(bytes.length / 1024).toFixed(0)} KB)`);
  return bytes;
}

export function ref(kind: Reference["kind"], fileName: string, contentType: string, bytes: Buffer, url?: string): Reference {
  return { kind, fileName, contentType, size: bytes.length, url: url ?? dataUrl(bytes, contentType) };
}

export function saveJson(name: string, value: unknown): string {
  const path = join(MEDIA_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

export function loadJson<T>(name: string): T | null {
  const path = join(MEDIA_DIR, `${name}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}
