import { Icon } from "@/components/icons";
import { docsModelLabel, isContributor, runsAs } from "@/lib/docs/client/models";

/** The notice's words, one string so pages and tests can match it whole. */
export function contributorNoticeText(modelLabel: string): string {
  return `Runs on ${modelLabel}: Meta may use what you send to train future models. Don't send anything private.`;
}

/**
 * The disclosure every demo shows before it sends to a Contributor-mode model (docs/DOCS_MIRROR.md, "Contributor
 * mode is disclosed"): Meta may train on what's sent there. Renders nothing for Standard-mode models. muse-spark-1.3
 * counts as Contributor because the proxy runs it as muse-spark-1.3-contributor.
 */
export function ContributorNotice({ model, standardHint = false }: { model: string; standardHint?: boolean }) {
  if (!isContributor(model)) return null;
  const label = docsModelLabel(runsAs(model));
  return (
    <p className="pg-notice" role="note">
      <Icon name="info" size={16} className="pg-notice-icon" />
      <span>
        {contributorNoticeText(label)}
        {standardHint ? <span className="pg-notice-hint"> For Standard mode, pick Muse Spark 1.2 or Muse Wonder 1.0 in the model menu.</span> : null}
      </span>
    </p>
  );
}
