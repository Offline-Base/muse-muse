/**
 * A local product for the promote tests (not a test file): the rows a local run's database has for a shipped Bird
 * Count with a failed refinement after it, its files at localhost links, and the bundle scripts/promote-local.ts sends
 * once those files are in the live store. Every call makes new ids.
 */
import { randomUUID } from "node:crypto";
import type { Brief } from "@/lib/brief/schema";
import type { BuildEventBody } from "@/lib/types";
import type { ImportBundle } from "../bundle";
import { findLocalFileUrls, localFileKeyOf, rewriteLocalUrls, toBundle, type LocalRows } from "../local";

export const LOCAL = "http://localhost:3000/api/files";
export const STORE = "https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com";

export const BRIEF: Brief = {
  verdict: "yes",
  refusal: null,
  name: "Bird Count",
  slug: "bird-count",
  tagline: "Count the birds in a photo",
  user: "Birders",
  inspiration: {
    summary: "A photo of a feeder.",
    references: [{ index: 0, kind: "image", describes: "Three sparrows on a feeder." }],
    borrow: ["Counting birds from a photo"],
    dontCopy: ["The exact pixels of the person's photo"],
  },
  primaryFlow: ["Upload a photo", "See the count with boxes"],
  screens: [],
  capabilities: [{ need: "Find birds", model: "sam-3.1", why: "It boxes objects" }],
  inputs: [{ kind: "image", required: true, notes: "A photo" }],
  outputs: [{ kind: "overlay", notes: "Boxes" }],
  limits: ["Counts are estimates."],
  complexity: "simple",
  estimatedCostPerRunUsd: 0.01,
  costNotes: "One SAM call.",
  fixtures: [{ kind: "image", description: "The person's feeder photo", fromUserSample: true, referenceIndex: 0 }],
  actions: [{ name: "count_birds", description: "Takes a photo, returns a count." }],
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 12, minute));

export function sampleRows(over: { slug?: string; ownerId?: string } = {}): LocalRows {
  const slug = over.slug ?? "bird-count";
  const ownerId = over.ownerId ?? randomUUID();
  const productId = randomUUID();
  const museId = randomUUID();
  const refineMuseId = randomUUID();
  const buildId = randomUUID();
  const refineId = randomUUID();
  const sessionId = randomUUID();
  const sandboxName = `product-${slug}-${productId.slice(0, 8)}`;
  const video = `${LOCAL}/demos/${buildId}/demo-1a2b3c4d.mp4`;
  const poster = `${LOCAL}/demos/${buildId}/poster-5e6f7a8b.jpg`;
  const build = {
    inspirationId: museId,
    userId: ownerId,
    rebuildOf: null,
    productId,
    step: null,
    brief: BRIEF,
    buildModel: "muse-wonder-1.0",
    sandboxName,
    museSessionId: sessionId,
    workflowRunId: "wrun_local_1",
    museRound: null,
    stopRequested: false,
    requestedTargets: null,
    toolFixtures: null,
    roundPlan: null,
    liveCheck: null,
    capsDropped: null,
    previewUrl: "https://sb-1a2b3c.vercel.run",
  };
  let eventId = 0;
  const event = (buildRef: string, payload: BuildEventBody, minute: number) => ({
    id: ++eventId,
    buildId: buildRef,
    type: payload.type,
    payload,
    at: at(minute),
  });
  return {
    product: {
      id: productId,
      slug,
      name: "Bird Count",
      tagline: "Count the birds in a photo",
      ownerId,
      inspirationId: museId,
      rebuildOf: null,
      manifest: {
        name: "Bird Count",
        slug,
        tagline: "Count the birds in a photo",
        inspiration: "A feeder photo",
        models: [{ id: "sam-3.1", usedFor: "Boxes the birds" }],
        actions: [],
        fixtures: [],
        limits: [],
        estimatedCostPerRunUsd: 0.01,
      },
      latestBuildId: buildId,
      sandboxName,
      museSessionId: sessionId,
      vercelProjectId: null,
      liveUrl: null,
      demoVideoUrl: video,
      demoPosterUrl: poster,
      transcriptUrl: `${LOCAL}/transcripts/${buildId}/transcript-9c0d1e2f.json`,
      extraClips: [],
      status: "live",
      createdAt: at(0),
      updatedAt: at(26),
      takenDownAt: null,
      takedownReason: null,
      statusBeforeTakedown: null,
      ownerSeenAt: null,
    },
    builds: [
      { ...build, id: buildId, kind: "build", message: null, status: "live", fixRounds: 1, costUsd: 3.75, error: null, startedAt: at(0), finishedAt: at(25) },
      {
        ...build,
        id: refineId,
        inspirationId: refineMuseId,
        kind: "refine",
        message: "Make the boxes green",
        status: "failed",
        fixRounds: 0,
        costUsd: 0.5,
        error: "The change did not pass its checks, so it was not deployed. The live version was kept.",
        startedAt: at(40),
        finishedAt: at(50),
      },
    ],
    events: [
      event(buildId, { type: "status", status: "briefing", step: "brief" }, 1),
      event(buildId, { type: "brief", brief: BRIEF }, 2),
      // The sandbox's own dev server: a localhost mention that isn't the laptop, so it travels as it is.
      event(buildId, { type: "muse", round: 0, lines: [{ kind: "tool", tool: "exec", text: "curl http://localhost:3000/api/health" }] }, 5),
      event(
        buildId,
        {
          type: "verify",
          round: 0,
          summary: { passed: true, steps: [{ name: "smoke", ok: true }], failureOutput: "" },
          screenshots: [{ url: `${LOCAL}/screens/${buildId}/r0/01-home-aa11bb22.png`, caption: "home" }],
        },
        10,
      ),
      event(buildId, { type: "recording", url: video, posterUrl: poster }, 20),
      event(buildId, { type: "cost", totalUsd: 3.75, addedUsd: 3.75, what: "Muse Code build" }, 21),
      event(buildId, { type: "log", text: `Saved the demo. Watch it at ${video}.` }, 22),
      event(buildId, { type: "status", status: "live", message: "Finished as live without publishing to its own link." }, 25),
      event(refineId, { type: "status", status: "failed", message: "The change did not pass its checks." }, 50),
    ],
    inspirations: [
      {
        id: museId,
        userId: ownerId,
        note: "Count the sparrows at my feeder",
        references: [{ url: `${LOCAL}/inspo/0f0e1d2c-feeder-12ab34cd.jpg`, kind: "image", fileName: "feeder.jpg", contentType: "image/jpeg", size: 120_000 }],
        createdAt: at(0),
      },
      { id: refineMuseId, userId: ownerId, note: "Make the boxes green", references: [], createdAt: at(40) },
    ],
  };
}

/** The rows as the script sends them: every local link moved to the live store at the same path. */
export function sampleBundle(over: { slug?: string } = {}): ImportBundle {
  const bundle = toBundle(sampleRows(over));
  return rewriteLocalUrls(bundle, new Map(findLocalFileUrls(bundle).map((url) => [url, `${STORE}/${localFileKeyOf(url)}`])));
}
