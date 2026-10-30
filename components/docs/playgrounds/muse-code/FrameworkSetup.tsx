"use client";

import { useId, useState } from "react";
import { Field, Segmented, Tabs, TextInput } from "@/components/docs/kit";
import { AGENT_MODELS } from "@/components/docs/playgrounds/muse-code/agent-configs";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import { claudeSdkCode, codexCatalog, codexDriver, LEVEL_TEXT, rpcSequence, type CodexLevel, type CodexServerInput, type SdkInput } from "@/components/docs/playgrounds/muse-code/frameworks";
import { MiniAgentLoop } from "@/components/docs/playgrounds/muse-code/MiniAgentLoop";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Check, Chip, Notes, Panel, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The agent-frameworks page's demo: the Claude Agent SDK's query() setup in TypeScript or Python and the Codex
 * app-server's catalog, launch flags and JSON-RPC driver, both generated from the page's own code with your options,
 * and a live mini agent loop on the Messages or Responses API that shows what either framework does under the hood.
 */

export interface FrameworkSetupProps {
  slug: string;
}

type View = "claude" | "codex" | "loop";

const CHEAP = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";
const LEVELS: CodexLevel[] = ["low", "medium", "high", "xhigh"];

export function FrameworkSetup(_props: FrameworkSetupProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("claude");

  const [sdk, setSdk] = useState<SdkInput>({
    lang: "typescript",
    prompt: "Add input validation to the signup handler and run the tests.",
    cwd: "/path/to/workspace",
    systemPrompt: "You are a coding agent. Make minimal, well-tested changes.",
    tools: ["Read", "Edit", "Bash"],
    bypass: true,
    hermetic: true,
    main: WONDER,
    opus: WONDER,
    sonnet: CHEAP,
    haiku: CHEAP,
    subagent: CHEAP,
    production: false,
  });
  const [toolsText, setToolsText] = useState("Read, Edit, Bash");
  const ps = (p: Partial<SdkInput>) => setSdk((s) => ({ ...s, ...p }));

  const [cx, setCx] = useState<CodexServerInput>({
    model: WONDER,
    displayName: "Muse Wonder",
    defaultLevel: "xhigh",
    levels: [...LEVELS],
    baseInstructions:
      "You are a coding agent operating in a terminal. Use the available tools to read and edit files and run shell commands, and complete the user's task with focused, verified changes.",
    prompt: "Summarize this repo.",
    sandbox: "workspace-write",
    optOutDeltas: true,
    images: true,
  });
  const [cxView, setCxView] = useState<"driver" | "catalog" | "rpc">("rpc");
  const pc = (p: Partial<CodexServerInput>) => setCx((c) => ({ ...c, ...p }));
  const rpc = rpcSequence(cx);

  return (
    <div className="pg">
      <Tabs<View>
        label="Agent framework"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "claude", label: "Claude Agent SDK" },
          { id: "codex", label: "Codex app-server" },
          { id: "loop", label: "Run a mini agent loop" },
        ]}
      />

      <Panel idBase={idBase} id="claude" active={view === "claude"}>
        <div className="pg-col">
          <div className={styles.row}>
            <div className="pg-field">
              <span className="pg-label">Language</span>
              <Segmented<SdkInput["lang"]>
                label="Language"
                size="sm"
                value={sdk.lang}
                onChange={(lang) => ps({ lang })}
                options={[
                  { value: "typescript", label: "TypeScript" },
                  { value: "python", label: "Python" },
                ]}
              />
            </div>
            <SelectField id={`${idBase}-main`} label="ANTHROPIC_MODEL (main loop)" value={sdk.main} onChange={(main) => ps({ main })} options={AGENT_MODELS} />
            <SelectField id={`${idBase}-opus`} className="pg-advanced" label="opus tier" value={sdk.opus} onChange={(opus) => ps({ opus })} options={AGENT_MODELS} />
            <SelectField id={`${idBase}-sonnet`} className="pg-advanced" label="sonnet and haiku tiers, subagents" value={sdk.sonnet} onChange={(m) => ps({ sonnet: m, haiku: m, subagent: m })} options={AGENT_MODELS} />
          </div>
          <Field id={`${idBase}-prompt`} label="prompt">
            <TextInput id={`${idBase}-prompt`} value={sdk.prompt} onChange={(e) => ps({ prompt: e.target.value })} />
          </Field>
          <div className={`${styles.row} pg-advanced`}>
            <Field id={`${idBase}-system`} label="systemPrompt" className={styles.grow}>
              <TextInput id={`${idBase}-system`} value={sdk.systemPrompt} onChange={(e) => ps({ systemPrompt: e.target.value })} />
            </Field>
            <Field id={`${idBase}-tools`} label="allowedTools" hint="Comma-separated" className={styles.narrow}>
              <TextInput
                id={`${idBase}-tools`}
                className="pg-code-input"
                value={toolsText}
                spellCheck={false}
                onChange={(e) => {
                  setToolsText(e.target.value);
                  ps({ tools: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) });
                }}
              />
            </Field>
          </div>
          <div className="pg-bar pg-advanced">
            <Check id={`${idBase}-bypass`} label='permissionMode "bypassPermissions" (unattended)' checked={sdk.bypass} onChange={(bypass) => ps({ bypass })} />
            <Check id={`${idBase}-hermetic`} label="settingSources: [] (hermetic)" checked={sdk.hermetic} onChange={(hermetic) => ps({ hermetic })} />
            <Check id={`${idBase}-prod`} label="Add the production patterns" checked={sdk.production} onChange={(production) => ps({ production })} />
          </div>
          <CodeBlock code={claudeSdkCode(sdk)} label={sdk.lang === "typescript" ? "agent.ts" : "agent.py"} syntax={sdk.lang} />
          <CodeBlock className="pg-advanced" code={sdk.lang === "typescript" ? "npm install @anthropic-ai/claude-agent-sdk\nexport MODEL_API_KEY=\"<your-model-api-key>\"" : "pip install claude-agent-sdk\nexport MODEL_API_KEY=\"<your-model-api-key>\""} label="Install and set the key" />
          <Notes
            className="pg-advanced"
            items={[
              "ANTHROPIC_BASE_URL is the bare host: the SDK appends /v1/messages. ANTHROPIC_AUTH_TOKEN sends a Bearer token, which is how Model API authenticates; ANTHROPIC_API_KEY would send x-api-key.",
              "Point every tier and the subagent model at a model Model API serves, or those paths reach for a Claude model it doesn't serve.",
              sdk.bypass ? "bypassPermissions runs without asking for approval: only inside an OS sandbox with a per-run working directory and a scrubbed, allowlisted environment (keep SSL_CERT_FILE and NODE_EXTRA_CA_CERTS)." : "Without bypassPermissions the SDK's own permission handling applies.",
              "The SDK carries the model's reasoning across tool-call turns over Messages.",
            ]}
          />
          {sdk.main.endsWith("-contributor") || sdk.sonnet.endsWith("-contributor") ? (
            <p className="pg-hint">muse-spark-1.3-contributor is Contributor mode: Meta may use what you send to train future models. Drop -contributor for Standard mode.</p>
          ) : null}
        </div>
      </Panel>

      <Panel idBase={idBase} id="codex" active={view === "codex"}>
        <div className="pg-col">
          <div className={styles.row}>
            <SelectField id={`${idBase}-cx-model`} label="model (and the catalog slug)" value={cx.model} onChange={(model) => pc({ model, displayName: model === WONDER ? "Muse Wonder" : model })} options={AGENT_MODELS} />
            <SelectField<CodexLevel> id={`${idBase}-cx-level`} className="pg-advanced" label="default_reasoning_level" value={cx.defaultLevel} onChange={(defaultLevel) => pc({ defaultLevel, levels: cx.levels.includes(defaultLevel) ? cx.levels : [...cx.levels, defaultLevel] })} options={LEVELS.map((l) => ({ value: l, label: l }))} />
            <SelectField<CodexServerInput["sandbox"]>
              id={`${idBase}-cx-sandbox`}
              className="pg-advanced"
              label="thread sandbox"
              value={cx.sandbox}
              onChange={(sandbox) => pc({ sandbox })}
              options={[
                { value: "workspace-write", label: "workspace-write" },
                { value: "read-only", label: "read-only" },
              ]}
            />
          </div>
          <fieldset className={`${styles.fieldset} pg-advanced`}>
            <legend>supported_reasoning_levels</legend>
            <div className="pg-bar">
              {LEVELS.map((l) => (
                <Check
                  key={l}
                  id={`${idBase}-lvl-${l}`}
                  label={`${l}: ${LEVEL_TEXT[l]}`}
                  checked={cx.levels.includes(l)}
                  disabled={l === cx.defaultLevel}
                  onChange={(on) => pc({ levels: on ? LEVELS.filter((x) => x === l || cx.levels.includes(x)) : cx.levels.filter((x) => x !== l) })}
                />
              ))}
            </div>
          </fieldset>
          <Field id={`${idBase}-cx-prompt`} label="The turn's input">
            <TextInput id={`${idBase}-cx-prompt`} value={cx.prompt} onChange={(e) => pc({ prompt: e.target.value })} />
          </Field>
          <div className="pg-bar pg-advanced">
            <Check id={`${idBase}-cx-opt`} label="Opt out of token deltas" checked={cx.optOutDeltas} onChange={(optOutDeltas) => pc({ optOutDeltas })} />
            <Check id={`${idBase}-cx-img`} label="input_modalities includes image" checked={cx.images} onChange={(images) => pc({ images })} />
          </div>
          <div className="pg-bar">
            <Segmented<"rpc" | "driver" | "catalog">
              label="Show"
              size="sm"
              value={cxView}
              onChange={setCxView}
              options={[
                { value: "rpc", label: "The JSON-RPC exchange" },
                { value: "driver", label: "driver.mjs" },
                { value: "catalog", label: "Model catalog" },
              ]}
            />
          </div>
          {cxView === "rpc" ? (
            <ol className="pg-steps" aria-label="JSON-RPC messages, one JSON object per line, in order">
              {rpc.map((r, i) => (
                <li key={i} className="pg-step">
                  <p className="pg-step-title">
                    <span className="pg-step-num">{i + 1}</span>
                    <Chip tone={r.dir === "send" ? "accent" : "ok"}>{r.dir === "send" ? "You write to stdin" : "Codex writes to stdout"}</Chip>
                    <code className={styles.code}>{r.title}</code>
                  </p>
                  <pre className={r.dir === "send" ? "pg-pre" : "pg-pre pg-advanced"}>{JSON.stringify(r.message)}</pre>
                  <p className="pg-hint">{r.note}</p>
                </li>
              ))}
            </ol>
          ) : cxView === "driver" ? (
            <CodeBlock code={codexDriver(cx)} label="driver.mjs" syntax="javascript" />
          ) : (
            <CodeBlock code={JSON.stringify(codexCatalog(cx), null, 2)} label={`${cx.model}-catalog.json`} syntax="json" />
          )}
          <Notes
            className="pg-advanced"
            items={[
              "Codex refreshes its model list from /v1/models at startup and can't decode Model API's OpenAI-standard list (missing field 'models'), so the catalog registers the model instead.",
              "-c model_catalog_json takes the path to the catalog file, not the JSON itself; the driver writes it to a temp path at startup.",
              "requires_openai_auth=false makes Codex authenticate with your key alone. The child inherits MODEL_API_KEY from your environment.",
              "To point an interactive Codex session at Model API instead, run codex with the same -c flags.",
            ]}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="loop" active={view === "loop"}>
        <MiniAgentLoop />
      </Panel>
    </div>
  );
}
