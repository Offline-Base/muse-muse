"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Segmented } from "@/components/docs/kit/Field";
import { codeSamples, displayBody, standardModelBody, type CodeFlavor, type CodeLang } from "@/lib/docs/client/codegen";
import type { FormSpec } from "@/lib/docs/client/form";
import { tintCode } from "@/lib/docs/client/tint";
import { SPARK_STANDIN, RETIRED_SPARK } from "@/lib/meta/spark";

/**
 * The request a demo sends, as code to copy: curl, Python and TypeScript, each with the SDK flavor (OpenAI's, or
 * Anthropic's for Messages) and the plain HTTP one where both exist. It is drawn like the mirrored code blocks beside
 * it (app/docs/docs.css): the language tabs inside the block's frame, the syntax and the copy button in its header,
 * and the same --docs-syn-* colors. Keys come from MODEL_API_KEY. The docs run Meta's muse-spark-1.3 as its
 * Contributor stand-in; the code names muse-spark-1.3, which is what the reader's own key should call.
 */

const LANG_LABEL: Record<CodeLang, string> = { curl: "curl", python: "Python", typescript: "TypeScript" };

function flavorName(label: string): string {
  return /\(([^)]+)\)/.exec(label)?.[1] ?? label;
}

export function CodeView({
  method,
  path,
  body,
  form,
  stream,
  caption,
}: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  form?: FormSpec[];
  /** Read the reply as server-sent events. Defaults to body.stream === true. */
  stream?: boolean;
  /** A line above the code, such as "The request Run sends next". */
  caption?: string;
}) {
  const idBase = useId();
  const own = useMemo(() => (body === undefined ? undefined : standardModelBody(body)), [body]);
  const swapped = own !== body;
  const shownBody = useMemo(() => (own === undefined ? undefined : displayBody(own)), [own]);
  const shortened = useMemo(() => own !== undefined && JSON.stringify(shownBody) !== JSON.stringify(own), [own, shownBody]);
  const samples = useMemo(() => codeSamples({ method, path, body: shownBody, form, stream }), [method, path, shownBody, form, stream]);
  const [lang, setLang] = useState<CodeLang>("curl");
  const [flavors, setFlavors] = useState<Record<CodeLang, CodeFlavor>>({ curl: "http", python: "sdk", typescript: "sdk" });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const langs = (["curl", "python", "typescript"] as const).filter((l) => samples.some((s) => s.lang === l));
  const options = samples.filter((s) => s.lang === lang);
  const sample = options.find((s) => s.flavor === flavors[lang]) ?? options[0];
  const tinted = useMemo(() => (sample ? tintCode(sample.code, sample.syntax) : []), [sample]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = langs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setLang(langs[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="pg-codeview">
      {caption ? <p className="pg-codeview-caption">{caption}</p> : null}
      <div className="docs-code docs-code-grouped pg-codeview-block">
        <div className="docs-tabs" role="tablist" aria-label="Language">
          {langs.map((l, i) => (
            <button
              key={l}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${l}`}
              aria-selected={l === lang}
              aria-controls={`${idBase}-panel`}
              tabIndex={l === lang ? 0 : -1}
              className="docs-tab"
              onClick={() => setLang(l)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="docs-tab-text" data-label={LANG_LABEL[l]}>
                {LANG_LABEL[l]}
              </span>
            </button>
          ))}
        </div>
        {sample ? (
          <>
            <div className="docs-code-head">
              <span className="docs-code-label">{sample.syntax}</span>
              <span className="docs-code-tools">
                {options.length > 1 ? (
                  <Segmented
                    size="sm"
                    label={`${LANG_LABEL[lang]} client`}
                    options={options.map((o) => ({ value: o.flavor, label: flavorName(o.label) }))}
                    value={sample.flavor}
                    onChange={(f) => setFlavors((cur) => ({ ...cur, [lang]: f }))}
                  />
                ) : null}
                <CopyButton value={sample.code} label={`Copy the ${sample.label} code`} className="icon-btn icon-btn-plain icon-btn-sm pg-code-copy" />
              </span>
            </div>
            <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${lang}`} className="docs-code-body pg-codeview-body" tabIndex={0}>
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
          </>
        ) : null}
      </div>
      <p className="pg-codeview-note">
        Set <code>MODEL_API_KEY</code> to your own Model API key before you run it.
        {swapped ? ` The demo runs on ${SPARK_STANDIN} (Contributor mode); this code calls ${RETIRED_SPARK}, the Standard model.` : ""}
        {shortened ? " Long base64 values are shortened to <BASE64> here: put your file's base64 there." : ""}
      </p>
    </div>
  );
}
