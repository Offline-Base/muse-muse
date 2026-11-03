import { Icon } from "@/components/Icon";

const MODEL_NAMES = {
  "muse-wonder-1.0": "Muse Wonder",
  "muse-image-1.0": "Muse Image",
  "sam-3.1": "SAM 3.1",
  "muse-voice-transcribe-1.0": "Muse Voice",
  "muse-glimmer": "Muse Glimmer",
  "jetson-fleet": "Jetson fleet",
  "muse-spark-open": "Muse Spark Open",
} as const;

export type MuseModel = keyof typeof MODEL_NAMES;

/** Models the Muse Muse gateway may serve a muse-wonder-1.0 call on instead. */
const STAND_IN_NAMES: Record<string, string> = {
  "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
};

/**
 * The name to show for a model: the one that really runs. The platform sets NEXT_PUBLIC_MUSE_WONDER_SERVED_BY when the
 * gateway serves this product's muse-wonder-1.0 calls on another model, so the chip names that model instead.
 */
export function modelName(model: MuseModel, servedBy: string | undefined = process.env.NEXT_PUBLIC_MUSE_WONDER_SERVED_BY): string {
  const standIn = servedBy ? STAND_IN_NAMES[servedBy] : undefined;
  return model === "muse-wonder-1.0" && standIn ? standIn : MODEL_NAMES[model];
}

/**
 * Credits the model that made a result, like "Read by Muse Wonder", in a pill outlined with the AI gradient. Put it
 * in the result's header, and only on output that model really made: never on a fallback, a sample or text the app
 * wrote itself. The platform checks every credit against the models the product really called during its tests.
 */
export function ModelChip({ model, verb }: { model: MuseModel; verb: string }) {
  return (
    <span className="chip ai">
      <Icon name="sparkle" size={14} />
      {verb} by {modelName(model)}
    </span>
  );
}
