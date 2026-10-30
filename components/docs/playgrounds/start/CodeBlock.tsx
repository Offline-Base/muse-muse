"use client";

import { useMemo } from "react";
import { CopyButton } from "@/components/CopyButton";
import { tintCode, type TintSyntax } from "@/lib/docs/client/tint";
import styles from "@/components/docs/playgrounds/start/start.module.css";

/**
 * One block of code or a command to copy, drawn like the mirrored code blocks (app/docs/docs.css .docs-code) with the
 * kit's colors (lib/docs/client/tint). For what the kit's CodeView doesn't make: shell commands, config files and
 * client code that isn't one API request.
 */
export function CodeBlock({
  code,
  label,
  syntax = "bash",
  caption,
  copyLabel,
}: {
  code: string;
  /** The block's header, such as "bash" or "opencode.json". */
  label: string;
  /** How to color it; "text" leaves it plain. JSON reads well colored as TypeScript. */
  syntax?: TintSyntax | "json" | "text";
  caption?: string;
  copyLabel?: string;
}) {
  const tinted = useMemo(
    () => (syntax === "text" ? [{ text: code, tone: null }] : tintCode(code, syntax === "json" ? "typescript" : syntax)),
    [code, syntax],
  );
  return (
    <div>
      {caption ? <p className={styles.codeCaption}>{caption}</p> : null}
      <div className={`docs-code ${styles.code}`}>
        <div className="docs-code-head">
          <span className="docs-code-label">{label}</span>
          <span className="docs-code-tools">
            <CopyButton value={code} label={copyLabel ?? `Copy ${label}`} className="icon-btn icon-btn-plain icon-btn-sm pg-code-copy" />
          </span>
        </div>
        <div className="docs-code-body pg-codeview-body" tabIndex={0} role="region" aria-label={label}>
          <pre>
            <code>
              {tinted.map((t, i) =>
                t.tone ? (
                  <span key={i} className={`pg-tok pg-tok-${t.tone}`}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                ),
              )}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}
