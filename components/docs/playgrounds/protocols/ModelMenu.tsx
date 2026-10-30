"use client";

import { ModelSelect } from "@/components/docs/kit/ModelSelect";

/**
 * The text model menu the protocols demos share: the kit's ModelSelect with the Contributor notice under it, whose
 * Standard-mode hint names only the Standard models this menu offers (the Spark-only menus of background runs leave
 * Muse Wonder out, since it can't run in the background in the live docs). The notice's words are the kit's, so every
 * page discloses the same way.
 */
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
  return <ModelSelect kind="text" value={value} onChange={onChange} allow={allow} disabled={disabled} />;
}
