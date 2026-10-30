"use client";

import { useId, useMemo, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { ContributorNotice } from "@/components/docs/kit/ContributorNotice";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { runOnModEnter, TextArea } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { messagesBlockTypes, readReply, SDK_CLIENTS, wireRequest } from "@/components/docs/playgrounds/start/clients";
import { CodeBlock } from "@/components/docs/playgrounds/start/CodeBlock";
import { SplitPills } from "@/components/docs/playgrounds/start/SplitPills";
import { SPARK_TEXT_MODELS } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

const PROTOCOL_LABEL = { responses: "Responses API", chat: "Chat Completions", messages: "Messages API" } as const;

/**
 * One request through each client the SDKs page covers: the OpenAI SDK (Python and TypeScript, Responses and Chat
 * Completions), the Anthropic SDK (Messages), and OpenAI-compatible clients (LiteLLM, LangChain, LlamaIndex, the
 * Vercel AI SDK). Each shows its install line and code for the model and prompt picked, and Run sends the request that
 * client puts on the wire, then reads the reply the way it does, so the Anthropic SDK's leading redacted_thinking block
 * and LiteLLM's openai/ prefix are visible rather than surprises. The menu has the Muse Spark models only: each
 * client's code is what a reader writes, without the output cap the docs put on every Muse Wonder run (wonder.ts),
 * and the SDKs page doesn't cover Muse Wonder. So the Contributor notice is drawn without the kit's hint, which
 * points to Muse Wonder in the menu.
 */
export function SdkClients({ client: initialClient = "openai-python", prompt: initialPrompt }: { slug: string; client?: string; prompt?: string }) {
  const id = useId();
  const runner = useDocsRun();
  const [index, setIndex] = useState(() => Math.max(0, SDK_CLIENTS.findIndex((c) => c.id === initialClient)));
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState(initialPrompt ?? "Explain mixture-of-experts in two sentences.");
  const [ranWith, setRanWith] = useState<string | null>(null);
  const client = SDK_CLIENTS[index];
  const text = prompt.trim() || "Explain mixture-of-experts in two sentences.";
  const wire = wireRequest(client.protocol, model, text);
  const code = useMemo(() => client.code(model, text), [client, model, text]);
  const running = runner.state === "running";

  const run = () => {
    if (running) return;
    setRanWith(client.id);
    void runner.run(wire.path, { method: "POST", body: wire.body });
  };

  const ran = SDK_CLIENTS.find((c) => c.id === ranWith) ?? client;
  const result = runner.result;
  const printed = result?.ok ? readReply(ran.protocol, result.json) : null;
  const blocks = result?.ok && ran.protocol === "messages" ? messagesBlockTypes(result.json) : [];

  return (
    <div className="pg">
      <SplitPills label="Client" keep={4} presets={SDK_CLIENTS} active={index} onPick={setIndex} disabled={running} />
      <div className={`${styles.tags} pg-advanced`}>
        <span className={styles.tag}>{client.language === "python" ? "Python" : "TypeScript"}</span>
        <span className={`${styles.tag} ${styles.tagAccent}`}>
          {PROTOCOL_LABEL[client.protocol]}: POST /v1/{wire.path}
        </span>
        <span className={styles.tag}>{client.onPage ? "The page's example" : "Written the page's way"}</span>
      </div>
      <p className="pg-hint">{client.note}</p>
      <div className="pg-bar pg-advanced">
        <span className="pg-inline-field">
          <span className="pg-label">Install</span>
          <code className="docs-code-inline">{client.install}</code>
          <CopyButton value={client.install} label="Copy the install command" className="icon-btn icon-btn-plain icon-btn-sm" />
        </span>
      </div>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} allow={[...SPARK_TEXT_MODELS]} notice={false} disabled={running} />
      </div>
      <ContributorNotice model={model} />
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Prompt
        </label>
        <TextArea id={`${id}-prompt`} rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={runOnModEnter(run)} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">Runs the request this client sends. Fractions of a cent on Contributor.</span>
          <RunButton running={running} onRun={run} onStop={runner.abort} label={`Run with ${client.label}`} />
        </div>
      </div>
      <CodeBlock
        label={client.label}
        code={code}
        syntax={client.language}
        caption={model.endsWith("-contributor") ? "The code. Contributor mode: Meta may use what you send to train future models; drop -contributor for Standard mode." : "The code"}
        copyLabel={`Copy the ${client.label} code`}
      />
      <div className="pg-advanced">
        <CodeBlock label="json" code={JSON.stringify(wire.body, null, 2)} syntax="json" caption={`What it sends: POST https://api.meta.ai/v1/${wire.path}`} copyLabel="Copy the request body" />
      </div>
      <ErrorBox error={runner.error} />
      <ResponseView result={result} running={running} elapsedMs={runner.elapsedMs}>
        {result?.ok ? (
          <div className={styles.stack}>
            <p className="pg-section-label">What {ran.label} prints ({ran.reads})</p>
            <div className="pg-stream-text">{printed ?? "(nothing: the reply has no text where this client reads it)"}</div>
            {blocks.length ? (
              <p className="pg-hint">
                content holds {blocks.length} blocks: {blocks.join(", ")}. The first carries the encrypted reasoning, which is why the code
                joins the text blocks instead of reading content[0].
              </p>
            ) : null}
          </div>
        ) : undefined}
      </ResponseView>
      <p className={`${styles.footnote} pg-advanced`}>
        SAM 3.1 returns its boxes and masks as a token grammar in the output text; Meta&apos;s client libraries
        (<code>@meta-sam/parser</code> for TypeScript, <code>meta_sam_parser</code> for Python) decode it.{" "}
        <a className={styles.link} href="/docs/sam/client-libraries">
          SAM client libraries
        </a>
      </p>
    </div>
  );
}
