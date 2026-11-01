import { Icon } from "@/components/icons";

/** The words every box that feeds a build shows while BUILDS_ON_CONTRIBUTOR is on. A notice, not a check of what's typed. */
export const CONTRIBUTOR_NOTICE = "This build runs on a model Meta may train on. Don't enter personal, sensitive or confidential information or files.";

export function ContributorNotice() {
  return (
    <p className="note" role="note">
      <Icon name="alert" size={16} />
      <span>{CONTRIBUTOR_NOTICE}</span>
    </p>
  );
}
