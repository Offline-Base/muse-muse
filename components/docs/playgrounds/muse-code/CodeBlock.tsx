"use client";

import { useMemo } from "react";
import { CopyButton } from "@/components/CopyButton";
import { tintCode, type TintSyntax } from "@/lib/docs/client/tint";

/**
 * A copyable code block drawn like the mirrored ones (app/docs/docs.css .docs-code) and the kit's CodeView: a header
 * with the file name or language and a copy button, then the code with the same --docs-syn-* colors. The builders on
 * the Muse Code pages hand out config files, shell commands and prompts, so this takes any text, not a request.
 */

export type BlockSyntax = TintSyntax | "json" | "toml" | "yaml" | "powershell" | "text" | "markdown" | "javascript";

/** The kit's tokenizer knows bash, Python and TypeScript; the other formats read well enough through the nearest one. */
function tokenizerFor(syntax: BlockSyntax): TintSyntax | null {
  switch (syntax) {
    case "bash":
    case "yaml":
    case "powershell":
      return "bash";
    case "python":
    case "toml":
      return "python";
    case "typescript":
    case "javascript":
    case "json":
      return "typescript";
    default:
      return null;
  }
}

export function CodeBlock({
  code,
  label,
  syntax = "bash",
  copyLabel,
  className,
}: {
  code: string;
  /** The header's text: a file name such as "opencode.json", or the language. */
  label?: string;
  syntax?: BlockSyntax;
  /** The copy button's accessible name. Defaults to "Copy <label>". */
  copyLabel?: string;
  className?: string;
}) {
  const tokenizer = tokenizerFor(syntax);
  const tinted = useMemo(() => (tokenizer ? tintCode(code, tokenizer) : [{ text: code, tone: null }]), [code, tokenizer]);
  const name = label ?? syntax;
  return (
    <div className={`docs-code pg-codeview-block${className ? ` ${className}` : ""}`}>
      <div className="docs-code-head">
        <span className="docs-code-label">{name}</span>
        <span className="docs-code-tools">
          <CopyButton value={code} label={copyLabel ?? `Copy ${name}`} className="icon-btn icon-btn-plain icon-btn-sm pg-code-copy" />
        </span>
      </div>
      <div className="docs-code-body pg-codeview-body" tabIndex={0} role="region" aria-label={name}>
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
  );
}
