// Platform file (Muse Muse platform services). Don't edit: the product's tile route calls samBoxes.
//
// One tile to SAM 3.1, on the server, as the meta-sam skill says: one short noun phrase, the tile as a data URL, the
// stream parsed with Meta's parser. It answers the tile's boxes in the tile's own pixels, for findAll in
// lib/platform/sam-tiles.ts to merge. Each call is one SAM photo on the product's budget (about $0.0025). Server only.
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { metaClient, type RequestLike } from "@/lib/meta/client";
import { imagePart } from "@/lib/meta/parts";
import type { Box } from "./sam-tiles";

/** A tile data URL is at most this long (a 1024 px JPEG is far smaller), so a route can't be used to send big files. */
export const SAM_TILE_DATA_URL_MAX = 3_000_000;

export class SamTileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SamTileError";
    this.status = status;
  }
}

/** Boxes SAM found for `phrase` in one tile. Throws SamTileError with a status a route can answer. */
export async function samBoxes(request: RequestLike, tile: string, phrase: string): Promise<Box[]> {
  const words = String(phrase ?? "").trim();
  if (!words || words.length > 60 || /[,;]/.test(words)) throw new SamTileError(400, "Say one short thing to look for, like \"bird\" or \"red car\".");
  if (typeof tile !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(tile) || tile.length > SAM_TILE_DATA_URL_MAX) {
    throw new SamTileError(400, "The photo piece wasn't a picture this can read.");
  }
  const meta = metaClient(request);
  const events = await meta.responses.create({
    model: "sam-3.1",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: words }, imagePart(tile)] }],
    stream: true,
    metadata: { include_confidence: "true" },
  } as never);
  const result = await parseImageStream(events as never).finalResult;
  if (result.outcome.status !== "completed") throw new SamTileError(502, "Looking at the photo ended early. Try again.");
  const boxes = recordsOfKind(result.records, "box").map((b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom, ...(b.confidence !== undefined ? { confidence: b.confidence } : {}) }));
  if (boxes.length) return boxes;
  // Some answers carry masks only: their bounds are the boxes.
  return recordsOfKind(result.records, "mask").map((m) => ({ ...m.bounds, ...(m.confidence !== undefined ? { confidence: m.confidence } : {}) }));
}
