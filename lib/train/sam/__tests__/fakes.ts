/**
 * Fakes for U6's tests: rate_limits counters in memory with reserveCounter's rule (add only while the total stays within
 * the limit), and a made-up SAM 3.1 reply. No database, no Meta, no Blob.
 */
import type { SpendDeps } from "@/lib/train/sam/spend";
import type { SamPhoto } from "@/lib/train/sam/types";

export interface FakeCounters extends SpendDeps {
  counts: Map<string, number>;
  /** Every reserve asked, refused ones too. */
  reserves: Array<{ key: string; amount: number; limit: number; ok: boolean }>;
  platformOk: boolean;
}

export function fakeCounters(now = new Date("2026-11-04T05:00:00Z")): FakeCounters {
  const counts = new Map<string, number>();
  const reserves: FakeCounters["reserves"] = [];
  const at = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const fake: FakeCounters = {
    counts,
    reserves,
    platformOk: true,
    async reserveCounter(key, w, amount, limit) {
      const k = at(key, w);
      const next = (counts.get(k) ?? 0) + amount;
      const ok = next <= limit;
      reserves.push({ key, amount, limit, ok });
      if (!ok) return null;
      counts.set(k, next);
      return next;
    },
    async adjustCounter(key, w, delta) {
      const k = at(key, w);
      counts.set(k, Math.max(0, (counts.get(k) ?? 0) + delta));
    },
    async platformSpendOk() {
      return fake.platformOk;
    },
    now: () => now,
  };
  return fake;
}

/** The total of every window of a key, in micro-dollars. */
export function counted(fake: FakeCounters, key: string): number {
  let sum = 0;
  for (const [k, v] of fake.counts) if (k.startsWith(`${key}@`)) sum += v;
  return sum;
}

/** A made-up SAM reply for a 640 x 480 photo with two boxes: a big likely one and a small doubtful one. */
export function samReply(opts: { empty?: boolean; usage?: boolean } = {}): unknown {
  const mask = "<|mask;x=0;y=0;data=4,4,!00001abcde|>";
  const text = opts.empty
    ? ""
    : `<0f>3<|box;x1=10;y1=20;x2=109;y2=219;w=640;h=480;c=0.91|>${mask},7<|box;x1=300;y1=300;x2=339;y2=339;w=640;h=480;c=0.42|>${mask}`;
  return { output_text: text, ...(opts.usage ? { usage: { images_processed: 1 } } : {}) };
}

export function photos(n: number, start = 0): SamPhoto[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://made-up.public.blob.vercel-storage.com/samtune/run/photos/p${start + i}.jpg`,
    split: (start + i) % 3 === 2 ? "held" : "train",
    box: null,
    skipped: false,
  }));
}
