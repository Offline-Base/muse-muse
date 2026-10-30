"use client";

import { contributorNoticeText } from "@/components/docs/kit/ContributorNotice";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { Icon } from "@/components/icons";
import { docsModelLabel, isContributor, modelsFor, runsAs } from "@/lib/docs/client/models";

/**
 * The kit's text model menu with the Contributor notice under it, where the notice's Standard-mode hint names only
 * the Standard models this menu offers. The kit's hint names Muse Spark 1.2 and Muse Wonder 1.0 whatever the menu
 * holds, which reads wrong on the Spark-only menus of background runs (Muse Wonder can't run in the background in the
 * live docs). The notice's own words are the kit's (contributorNoticeText), so every page discloses the same way.
 */

/** "a", "a or b", "a, b or c". */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}` : (items[0] ?? "");
}

export function ModelMenu({
  value,
  onChange,
  allow,
  disabled,
}: {
  value: string;
  onChange(model: string): void;
  /** Limit the menu to these ids, as ModelSelect's allow does. */
  allow?: string[];
  disabled?: boolean;
}) {
  const current = runsAs(value);
  const standard = modelsFor("text", allow)
    .filter((m) => m.mode === "standard")
    .map((m) => m.label);
  return (
    <div className="pg-model">
      <ModelSelect kind="text" value={value} onChange={onChange} allow={allow} disabled={disabled} notice={false} />
      {isContributor(current) ? (
        <p className="pg-notice" role="note">
          <Icon name="info" size={16} className="pg-notice-icon" />
          <span>
            {contributorNoticeText(docsModelLabel(current))}
            {standard.length ? <span className="pg-notice-hint"> For Standard mode, pick {listOf(standard)} in the model menu.</span> : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}
