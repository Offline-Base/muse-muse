import { Icon } from "@/components/icons";
import { docsModelLabel, isContributor, runsAs } from "@/lib/docs/client/models";

/** The notice's words, one string so pages and tests can match it whole. */
export function contributorNoticeText(modelLabel: string): string {
  return `Runs on ${modelLabel}: Meta may use what you send to train future models. Don't send anything private.`;
}

/** "a", "a or b", "a, b or c". */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}` : (items[0] ?? "");
}

/**
 * The hint after the notice, naming the Standard-mode models a model menu offers (`menu`: its model ids, in menu
 * order), so it never points at one the menu leaves out. Null when the menu offers no Standard model.
 */
export function standardHintText(menu: readonly string[]): string | null {
  const standard = [...new Set(menu.map(runsAs))].filter((m) => !isContributor(m)).map(docsModelLabel);
  return standard.length ? `For Standard mode, pick ${listOf(standard)} in the model menu.` : null;
}

/**
 * The disclosure every demo shows before it sends to a Contributor-mode model (docs/DOCS_MIRROR.md, "Contributor
 * mode is disclosed"): Meta may train on what's sent there. Renders nothing for Standard-mode models. muse-spark-1.3
 * counts as Contributor because the proxy runs it as muse-spark-1.3-contributor. Pass the model menu's ids as `menu`
 * to add the hint that names its Standard-mode choices; without a menu there is no hint.
 */
export function ContributorNotice({ model, menu }: { model: string; menu?: readonly string[] }) {
  if (!isContributor(model)) return null;
  const label = docsModelLabel(runsAs(model));
  const hint = menu ? standardHintText(menu) : null;
  return (
    <p className="pg-notice" role="note">
      <Icon name="info" size={16} className="pg-notice-icon" />
      <span>
        {contributorNoticeText(label)}
        {hint ? <span className="pg-notice-hint"> {hint}</span> : null}
      </span>
    </p>
  );
}
