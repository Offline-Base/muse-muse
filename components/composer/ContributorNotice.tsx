import { Icon } from "@/components/icons";

/** The words every box that feeds a build shows while BUILDS_ON_CONTRIBUTOR is on. A notice, not a check of what's typed. */
export const CONTRIBUTOR_NOTICE = "This build runs on a model Meta may train on. Don't enter personal, sensitive or confidential information or files.";

/** The same words for a fine-tune's boxes, where nothing is being built. */
export const CONTRIBUTOR_TUNE_NOTICE = "This runs on a model Meta may train on. Don't enter personal, sensitive or confidential information or files.";

export function ContributorNotice({ text = CONTRIBUTOR_NOTICE }: { text?: string } = {}) {
  return (
    <p className="note" role="note">
      <Icon name="alert" size={16} />
      <span>{text}</span>
    </p>
  );
}
