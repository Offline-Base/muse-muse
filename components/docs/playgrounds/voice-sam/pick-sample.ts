import { loadSample } from "@/components/docs/media/hooks";
import { prepareFile, type PickedMedia } from "@/lib/docs/media/prepare";
import { sampleById } from "@/lib/docs/media/samples";

/**
 * A docs sample by id, prepared the way FilePicker prepares a pick (lib/docs/media/prepare.ts), so a preset can swap
 * the file a playground sends without the reader clicking the sample chip. Null for an unknown id.
 */
export async function pickSample(
  id: string,
  opts: { forSam?: boolean; maxAudioSeconds?: number; signal?: AbortSignal } = {},
): Promise<PickedMedia | null> {
  const sample = sampleById(id);
  if (!sample) return null;
  const file = await loadSample(sample, opts.signal);
  return prepareFile(file, { sample, forSam: opts.forSam, maxAudioSeconds: opts.maxAudioSeconds });
}
