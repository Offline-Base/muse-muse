import { MarkdownText } from "@/components/markdown/MarkdownText";
import { truncate } from "@/lib/format";

/** Text longer than this folds behind a preview. */
const FOLD_AT = 320;
/** Characters the folded preview shows. */
const PREVIEW = 200;

/**
 * Model text as Markdown, with no links (a tuned model's raw output on public pages). Long text shows a preview that
 * opens to the whole text, so a table of answers stays easy to scan. Works without JavaScript (details and summary).
 */
export function LongText({
  text,
  foldAt = FOLD_AT,
  preview = PREVIEW,
  empty = "(empty)",
}: {
  text: string;
  foldAt?: number;
  preview?: number;
  /** Shown, muted, when the text is blank. */
  empty?: string;
}) {
  const t = (text ?? "").trim();
  if (!t) return <p className="train-text muted">{empty}</p>;
  if (t.length <= foldAt) return <MarkdownText className="train-text" text={t} links={false} />;
  return (
    <details className="train-long">
      <summary>
        <span className="train-long-preview">{truncate(t, preview)}</span>
        <span className="train-long-more">Show all</span>
        <span className="train-long-less">Show less</span>
      </summary>
      <MarkdownText className="train-text" text={t} links={false} />
    </details>
  );
}
