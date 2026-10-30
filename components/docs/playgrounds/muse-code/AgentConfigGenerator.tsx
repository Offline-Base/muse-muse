"use client";

import { useId, useState } from "react";
import { Field, PresetPills, Segmented, Tabs, TextInput } from "@/components/docs/kit";
import {
  AGENT_MODELS,
  BASE_URL,
  baseUrlProblems,
  claudeCheck,
  claudeEnv,
  claudeModels,
  codexCheck,
  codexInline,
  codexToml,
  genericCheck,
  openCodeCheck,
  openCodeConfig,
  openCodePrompt,
  TROUBLESHOOTING,
  type AgentEffort,
  type ClaudeInput,
  type CodexInput,
  type OpenCodeInput,
} from "@/components/docs/playgrounds/muse-code/agent-configs";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import { ConfigCheck } from "@/components/docs/playgrounds/muse-code/ConfigCheck";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { C, Check, Notes, Panel, Problems, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The coding-agents page's demo: a config generator for OpenCode, Codex, Claude Code and any OpenAI-compatible tool,
 * built from the page's own configs (base URL, models, reasoning, environment), each with a live check that sends the
 * request the config would make through the docs proxy and says whether it answers. Configs start on the cheap
 * Contributor model; the page's Wonder-led configs are one click away.
 */

export interface AgentConfigGeneratorProps {
  slug: string;
}

type View = "opencode" | "codex" | "claude" | "generic";

const EFFORTS: ReadonlyArray<{ value: AgentEffort; label: string }> = (["minimal", "low", "medium", "high", "xhigh", "max"] as const).map((e) => ({ value: e, label: e }));
const CHEAP = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";

export function AgentConfigGenerator(_props: AgentConfigGeneratorProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("opencode");

  const [oc, setOc] = useState<OpenCodeInput>({ adapter: "responses", model: CHEAP, effort: "high", summary: true, encrypted: true, modalities: true });
  const ocOut = openCodeConfig(oc);

  const [cx, setCx] = useState<CodexInput>({ model: CHEAP, effort: "high", summary: true, keyEnv: "MODEL_API_KEY" });
  const [cxPreset, setCxPreset] = useState<number | null>(null);
  const [cxStyle, setCxStyle] = useState<"toml" | "inline">("toml");
  const cxOut = codexToml(cx);

  const [cc, setCc] = useState<ClaudeInput>({ main: CHEAP, opus: CHEAP, sonnet: CHEAP, haiku: CHEAP, subagent: CHEAP, toolSearch: true, shell: "posix", keyEnv: "MODEL_API_KEY" });
  const [ccPreset, setCcPreset] = useState<number | null>(1);
  const ccOut = claudeEnv(cc);

  const [genSurface, setGenSurface] = useState<"chat" | "responses">("chat");
  const [genModel, setGenModel] = useState(CHEAP);
  const [url, setUrl] = useState("https://api.meta.ai/v1/");

  const modelSelect = (id: string, label: string, value: string, onChange: (v: string) => void, hint?: string) => (
    <SelectField id={id} label={label} value={value} onChange={onChange} options={AGENT_MODELS} hint={hint} />
  );

  return (
    <div className="pg">
      <Tabs<View>
        label="Coding agent"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "opencode", label: "OpenCode" },
          { id: "codex", label: "Codex" },
          { id: "claude", label: "Claude Code" },
          { id: "generic", label: "Any OpenAI-compatible tool" },
        ]}
      />

      <Panel idBase={idBase} id="opencode" active={view === "opencode"}>
        <div className="pg-col">
          <div className={styles.row}>
            <div className="pg-field">
              <span className="pg-label">Adapter</span>
              <Segmented<OpenCodeInput["adapter"]>
                label="Adapter"
                size="sm"
                value={oc.adapter}
                onChange={(adapter) => setOc((o) => ({ ...o, adapter }))}
                options={[
                  { value: "responses", label: "@ai-sdk/openai (Responses, recommended)" },
                  { value: "chat", label: "@ai-sdk/openai-compatible (fallback)" },
                ]}
              />
            </div>
          </div>
          <div className={styles.row}>
            {modelSelect(`${idBase}-oc-model`, "Model", oc.model, (model) => setOc((o) => ({ ...o, model })))}
            {oc.adapter === "responses" ? <SelectField<AgentEffort> id={`${idBase}-oc-effort`} label="reasoningEffort" value={oc.effort} onChange={(effort) => setOc((o) => ({ ...o, effort }))} options={EFFORTS} /> : null}
          </div>
          {oc.adapter === "responses" ? (
            <div className="pg-bar">
              <Check id={`${idBase}-oc-enc`} label={<>include reasoning.encrypted_content</>} checked={oc.encrypted} onChange={(encrypted) => setOc((o) => ({ ...o, encrypted }))} />
              <Check id={`${idBase}-oc-sum`} label='reasoningSummary "auto"' checked={oc.summary} onChange={(summary) => setOc((o) => ({ ...o, summary }))} />
              <Check id={`${idBase}-oc-mod`} label="Declare modalities" checked={oc.modalities} onChange={(modalities) => setOc((o) => ({ ...o, modalities }))} />
            </div>
          ) : null}
          {/* Stacked: side by side, the narrow content column cut off the base URL and most prompt lines. */}
          <div className="pg-col">
            <CodeBlock code={ocOut.code} label="opencode.json" syntax="json" />
            <div className="pg-col">
              <CodeBlock code={openCodePrompt(oc)} label="Or paste this into OpenCode (self-configuration)" syntax="text" />
              <Notes
                items={[
                  <>
                    Then run <C>/connect</C>, pick the meta provider and give it your key. Keep the key out of opencode.json (<C>options.apiKey</C> only for local tests, never committed).
                  </>,
                  "Restart OpenCode after any config change, then select the model.",
                  <>
                    Local tools: drop TypeScript files in <C>.opencode/tools/</C> and the model finds them.
                  </>,
                ]}
              />
            </div>
          </div>
          <Problems warnings={ocOut.warnings} />
          <ConfigCheck requests={[openCodeCheck(oc)]} />
        </div>
      </Panel>

      <Panel idBase={idBase} id="codex" active={view === "codex"}>
        <div className="pg-col">
          <PresetPills
            label="Start from"
            presets={[{ label: "The page's config (Muse Wonder, high)" }, { label: "Lower cost (Spark 1.3 Contributor)" }]}
            active={cxPreset}
            onPick={(i) => {
              setCxPreset(i);
              setCx((c) => ({ ...c, model: i === 0 ? WONDER : CHEAP, effort: "high" }));
            }}
          />
          <div className={styles.row}>
            {modelSelect(`${idBase}-cx-model`, "model", cx.model, (model) => {
              setCx((c) => ({ ...c, model }));
              setCxPreset(null);
            })}
            <SelectField<AgentEffort> id={`${idBase}-cx-effort`} label="model_reasoning_effort" value={cx.effort} onChange={(effort) => setCx((c) => ({ ...c, effort }))} options={EFFORTS} />
            <Field id={`${idBase}-cx-env`} label="env_key" className={styles.narrow}>
              <TextInput id={`${idBase}-cx-env`} className="pg-code-input" value={cx.keyEnv} spellCheck={false} onChange={(e) => setCx((c) => ({ ...c, keyEnv: e.target.value.replace(/[^A-Za-z0-9_]/g, "") }))} />
            </Field>
          </div>
          <div className="pg-bar">
            <Check id={`${idBase}-cx-sum`} label="Reasoning summaries" checked={cx.summary} onChange={(summary) => setCx((c) => ({ ...c, summary }))} />
            <Segmented<"toml" | "inline">
              label="Config style"
              size="sm"
              value={cxStyle}
              onChange={setCxStyle}
              options={[
                { value: "toml", label: "~/.codex/config.toml" },
                { value: "inline", label: "Self-contained run (CODEX_HOME)" },
              ]}
            />
          </div>
          {cxStyle === "toml" ? <CodeBlock code={cxOut.code} label="~/.codex/config.toml" syntax="toml" /> : <CodeBlock code={codexInline(cx)} label="bash" />}
          <CodeBlock
            label="Then launch"
            code={[`export ${cx.keyEnv || "MODEL_API_KEY"}="<your-model-api-key>"`, "", "codex                                  # interactive", 'codex exec "fix the failing test"      # non-interactive', 'echo "explain this chart" | codex exec -i chart.png   # image input'].join("\n")}
          />
          <Problems warnings={cxOut.warnings} />
          <Notes
            items={[
              "Signed in to Codex with an OpenAI account? Run /logout first so it uses the meta provider.",
              "wire_api = \"responses\" carries reasoning across turns; Codex sends no temperature or top_p, so the API defaults apply.",
              "model_auto_compact_token_limit compacts before you reach the 1M-token window.",
            ]}
          />
          <ConfigCheck requests={[codexCheck(cx)]} />
        </div>
      </Panel>

      <Panel idBase={idBase} id="claude" active={view === "claude"}>
        <div className="pg-col">
          <PresetPills
            label="Start from"
            presets={[{ label: "The page's split (Wonder for the main loop and opus)" }, { label: "One low-cost model everywhere" }]}
            active={ccPreset}
            onPick={(i) => {
              setCcPreset(i);
              setCc((c) => (i === 0 ? { ...c, main: WONDER, opus: WONDER, sonnet: CHEAP, haiku: CHEAP, subagent: CHEAP } : { ...c, main: CHEAP, opus: CHEAP, sonnet: CHEAP, haiku: CHEAP, subagent: CHEAP }));
            }}
          />
          <div className={styles.row}>
            {modelSelect(`${idBase}-cc-main`, "ANTHROPIC_MODEL", cc.main, (main) => { setCc((c) => ({ ...c, main })); setCcPreset(null); })}
            {modelSelect(`${idBase}-cc-opus`, "ANTHROPIC_DEFAULT_OPUS_MODEL", cc.opus, (opus) => { setCc((c) => ({ ...c, opus })); setCcPreset(null); })}
            {modelSelect(`${idBase}-cc-sonnet`, "ANTHROPIC_DEFAULT_SONNET_MODEL", cc.sonnet, (sonnet) => { setCc((c) => ({ ...c, sonnet })); setCcPreset(null); })}
            {modelSelect(`${idBase}-cc-haiku`, "ANTHROPIC_DEFAULT_HAIKU_MODEL", cc.haiku, (haiku) => { setCc((c) => ({ ...c, haiku })); setCcPreset(null); })}
            {modelSelect(`${idBase}-cc-sub`, "CLAUDE_CODE_SUBAGENT_MODEL", cc.subagent, (subagent) => { setCc((c) => ({ ...c, subagent })); setCcPreset(null); })}
          </div>
          <div className="pg-bar">
            <Check id={`${idBase}-cc-ts`} label="ENABLE_TOOL_SEARCH=true" checked={cc.toolSearch} onChange={(toolSearch) => setCc((c) => ({ ...c, toolSearch }))} />
            <Segmented<ClaudeInput["shell"]>
              label="Shell"
              size="sm"
              value={cc.shell}
              onChange={(shell) => setCc((c) => ({ ...c, shell }))}
              options={[
                { value: "posix", label: "bash or zsh" },
                { value: "powershell", label: "PowerShell" },
              ]}
            />
          </div>
          <CodeBlock code={ccOut.code} label={cc.shell === "powershell" ? "PowerShell" : "~/.zshrc or ~/.bashrc"} syntax={cc.shell === "powershell" ? "powershell" : "bash"} />
          <Problems warnings={ccOut.warnings} />
          <Notes
            items={[
              <>
                <C>ANTHROPIC_AUTH_TOKEN</C> sends <C>Authorization: Bearer</C>, which is how Model API authenticates. <C>ANTHROPIC_API_KEY</C> sends <C>x-api-key</C> instead: don&apos;t use it here.
              </>,
              <>
                The base is <C>https://api.meta.ai</C> with no /v1: Claude Code appends /v1/messages itself.
              </>,
              "Pin every alias: Plan Mode and subagents use the opus and sonnet tiers, and haiku runs background tasks such as commit messages. An unpinned alias reaches for a Claude model Model API doesn't serve.",
            ]}
          />
          <ConfigCheck requests={claudeModels(cc).map((m) => claudeCheck(m))} label={claudeModels(cc).length > 1 ? "Check every model in this config" : "Check this config live"} />
        </div>
      </Panel>

      <Panel idBase={idBase} id="generic" active={view === "generic"}>
        <div className="pg-col">
          <div className={styles.row}>
            <div className="pg-field">
              <span className="pg-label">API surface</span>
              <Segmented<"chat" | "responses">
                label="API surface"
                size="sm"
                value={genSurface}
                onChange={setGenSurface}
                options={[
                  { value: "chat", label: "Chat Completions (universal)" },
                  { value: "responses", label: "Responses (if the tool targets it)" },
                ]}
              />
            </div>
            {modelSelect(`${idBase}-gen-model`, "Model ID", genModel, setGenModel)}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">The three settings an OpenAI-compatible tool needs</caption>
              <tbody>
                <tr>
                  <th scope="row">Base URL</th>
                  <td className={styles.mono}>{BASE_URL}</td>
                </tr>
                <tr>
                  <th scope="row">API key</th>
                  <td>Your Model API key, from the tool&apos;s credential store or an environment variable such as MODEL_API_KEY</td>
                </tr>
                <tr>
                  <th scope="row">Model ID</th>
                  <td className={styles.mono}>{genModel}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <CodeBlock code={`# For tools built on the OpenAI SDK, which read these:\nexport OPENAI_BASE_URL="${BASE_URL}"\nexport OPENAI_API_KEY="$MODEL_API_KEY"`} label="bash" />
          <Field id={`${idBase}-url`} label="Check the base URL your tool is set to">
            <TextInput id={`${idBase}-url`} className="pg-code-input" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Problems errors={baseUrlProblems(url)} ok="That base URL is right for OpenAI-compatible tools." />
          <ConfigCheck requests={[genericCheck(genSurface, genModel)]} />
          <details className="pg-system">
            <summary>Troubleshooting</summary>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Symptom</th>
                    <th scope="col">Likely cause</th>
                    <th scope="col">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  {TROUBLESHOOTING.map((t) => (
                    <tr key={t.symptom}>
                      <th scope="row">{t.symptom}</th>
                      <td>{t.cause}</td>
                      <td>{t.fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </Panel>
    </div>
  );
}
