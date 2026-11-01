import { ExternalLink } from "@/components/ui";
import { BUILT_WITH_SPARK_OPEN, R30B_URL, USAGE_POINTS } from "@/lib/train/base";

/*
 * What the Muse Model License asks wherever a Derivative of Muse Spark Open is shown or shipped (lib/train/base.ts): a
 * lab model trained from r30b. "Built with Muse Spark Open", prominently, and the Usage Policy's points. No client
 * code, so server and client components both use it. Pages decide with isSparkOpenDerivative, never on their own.
 */

/**
 * The note under a model's title: the line, why it applies, and the Usage Policy's points. `what` names the model
 * ("This model", "These files"); `compact` leaves the reason out, for a card that already says what the model is.
 */
export function SparkOpenNote({ what = "This model", compact = false }: { what?: string; compact?: boolean }) {
  return (
    <aside className="card section-card spark-open-note" aria-label={BUILT_WITH_SPARK_OPEN}>
      <p>
        <strong>{BUILT_WITH_SPARK_OPEN}.</strong>{" "}
        {compact ? (
          <>The Muse Model License and its Usage Policy apply.</>
        ) : (
          <>
            {what} was trained from{" "}
            <ExternalLink href={R30B_URL}>Muse Muse&apos;s 2026-knowledge Glimmer</ExternalLink>, and Muse Spark Open wrote
            part of that model&apos;s training data, so the Muse Model License and its Usage Policy apply.
          </>
        )}
      </p>
      <ul className="muted small">
        {USAGE_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </aside>
  );
}

/** The line as a chip, for a table row or a list of models. */
export function SparkOpenChip() {
  return <span className="chip">{BUILT_WITH_SPARK_OPEN}</span>;
}
