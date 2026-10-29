import { Icon } from "@/components/Icon";

const MODEL_NAMES = {
  "muse-wonder-1.0": "Muse Wonder",
  "muse-image-1.0": "Muse Image",
  "sam-3.1": "SAM 3.1",
  "muse-voice-transcribe-1.0": "Muse Voice",
  "muse-glimmer": "Muse Glimmer",
} as const;

export type MuseModel = keyof typeof MODEL_NAMES;

/**
 * Credits the model that made a result, like "Read by Muse Wonder", in a pill outlined with the AI gradient. Put it
 * in the result's header, and only on output that model really made: never on a fallback, a sample or text the app
 * wrote itself.
 */
export function ModelChip({ model, verb }: { model: MuseModel; verb: string }) {
  return (
    <span className="chip ai">
      <Icon name="sparkle" size={14} />
      {verb} by {MODEL_NAMES[model]}
    </span>
  );
}
