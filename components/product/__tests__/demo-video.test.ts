/**
 * The demo video's poster on the gallery card and the build room's media card, and the recording's poster in the
 * build room's state, old recording events (without one) included.
 *   npx tsx --test components/product/__tests__/demo-video.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { deriveRoom } from "@/components/build/derive";
import { BuildOutput } from "@/components/build/turns";
import { ProductCard } from "@/components/product/ProductCard";
import type { BuildView, ProductCardView } from "@/components/view-types";
import type { BuildEvent } from "@/lib/types";

const card: ProductCardView = {
  slug: "receipt-counter",
  name: "Receipt Counter",
  tagline: "Adds up a week of receipts",
  status: "live",
  liveUrl: "https://musemuse-receipt-counter.vercel.app",
  demoVideoUrl: "https://blob/demos/b1/demo.mp4",
  demoPosterUrl: "https://blob/demos/b1/poster.jpg",
  muse: null,
  models: ["muse-spark-1.3"],
  buildMs: null,
  costUsd: null,
  fixRounds: null,
  rebuildOf: null,
};

/** The <video ...> tag in rendered HTML. */
const videoTag = (html: string) => /<video[^>]*>/.exec(html)?.[0] ?? "";

describe("demo video poster", () => {
  it("puts the poster on the gallery card's video, which loads only metadata and plays inline, muted, without autoplay", () => {
    const tag = videoTag(renderToString(createElement(ProductCard, { p: card })));
    assert.match(tag, /poster="https:\/\/blob\/demos\/b1\/poster\.jpg"/);
    assert.match(tag, /preload="metadata"/);
    assert.match(tag, /playsInline=""|playsinline=""/i);
    assert.match(tag, /muted=""/);
    assert.doesNotMatch(tag, /autoplay/i);
  });

  it("leaves the poster off when the video has none", () => {
    const tag = videoTag(renderToString(createElement(ProductCard, { p: { ...card, demoPosterUrl: null } })));
    assert.ok(tag.startsWith("<video"));
    assert.doesNotMatch(tag, /poster=/);
  });

  it("puts the poster on the build room's media card", () => {
    const html = renderToString(createElement(BuildOutput, { name: card.name, demoUrl: card.demoVideoUrl, demoPosterUrl: card.demoPosterUrl }));
    assert.match(videoTag(html), /poster="https:\/\/blob\/demos\/b1\/poster\.jpg"/);
  });

  it("keeps the recording's poster in the build room, and none for recordings from before posters", () => {
    const build: BuildView = {
      id: "b1",
      kind: "build",
      message: null,
      rebuildOf: null,
      productId: "p1",
      userId: "u1",
      inspirationId: "i1",
      status: "live",
      step: null,
      brief: null,
      buildModel: null,
      museSessionId: null,
      fixRounds: 0,
      previewUrl: null,
      costUsd: 0,
      error: null,
      startedAt: "2026-10-28T10:00:00.000Z",
      finishedAt: "2026-10-28T10:09:00.000Z",
    };
    const recording = (id: number, body: { url: string; posterUrl?: string | null }): BuildEvent => ({
      id,
      at: `2026-10-28T10:0${id}:00.000Z`,
      type: "recording",
      ...body,
    });
    const room = deriveRoom(build, [recording(5, { url: card.demoVideoUrl!, posterUrl: card.demoPosterUrl })]);
    assert.equal(room.recordingUrl, card.demoVideoUrl);
    assert.equal(room.recordingPosterUrl, card.demoPosterUrl);
    const seg = room.segments.find((s) => s.type === "record");
    assert.equal(seg?.type === "record" ? seg.posterUrl : undefined, card.demoPosterUrl);

    const old = deriveRoom(build, [recording(5, { url: "https://blob/demos/old/demo.mp4" })]);
    assert.equal(old.recordingPosterUrl, null);
  });
});
