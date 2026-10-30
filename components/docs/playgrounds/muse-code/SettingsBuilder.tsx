"use client";

import { useId, useState } from "react";
import { Field, JsonEditor, Segmented, Tabs, TextArea, TextInput, Toggle } from "@/components/docs/kit";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import { EffortCompare } from "@/components/docs/playgrounds/muse-code/EffortCompare";
import { McpServerEditor } from "@/components/docs/playgrounds/muse-code/McpServerEditor";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import {
  AGENTS_TEMPLATES,
  buildLaunch,
  buildSettings,
  checkSettings,
  checkSettingsText,
  draftWarnings,
  EFFORT_LEVELS,
  EMPTY_SERVER,
  INSTRUCTION_FILES,
  MEMORY_SCOPES,
  memoryLayout,
  PROFILE_IDS,
  resolveInstructions,
  SETTINGS_PATH,
  type InstructionFile,
  type LaunchDraft,
  type Level,
  type McpServerDraft,
  type MemoryScope,
  type SettingsDraft,
} from "@/components/docs/playgrounds/muse-code/settings";
import { C, Check, Chip, Notes, NumberField, Panel, Problems, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The configuration page's demo: build a user settings file from the keys the Muse Code pages document (and check one
 * you paste, the way startup does), see which instruction files load and in what order, start an AGENTS.md from a
 * template, lay out memory, build launch flags for either surface, and compare reasoning effort levels live.
 */

export interface SettingsBuilderProps {
  slug: string;
}

type View = "settings" | "instructions" | "memory" | "flags" | "effort";

const START: SettingsDraft = {
  schemaVersion: true,
  defaultProfile: ":auto-review",
  retentionDays: 30,
  showReasoning: false,
  terminalBackground: "",
  executionCapacity: null,
  managedHooksPath: "",
  oauthDynamicRegistration: true,
  mcpServers: [],
};

const PASTE_EXAMPLE = `{
  "permissions": { "default_profile": ":ask-me" },
  "mcp_servers": {
    "docs": { "transport": "streamable_http", "url": "https://mcp.example.com/mcp", "framing": "content-length" }
  }
}`;

const START_LEVELS: Level[] = [
  { dir: "/repo", present: ["AGENTS.md", ".claude/CLAUDE.md"] },
  { dir: "/repo/packages", present: [] },
  { dir: "/repo/packages/api", present: ["CLAUDE.md", ".agents/AGENTS.md"] },
];

const START_LAUNCH: LaunchDraft = {
  surface: "interactive",
  model: "",
  effort: "",
  approvalMode: "",
  approvalJudge: "",
  sandboxNetwork: "",
  disableSandbox: false,
  disableApproval: false,
  yolo: false,
  trustWorkspace: false,
  workspace: "",
  noSessionLog: false,
  contributor: "",
  json: false,
  promptFile: "",
  maxSteps: null,
  prompt: "Run the tests and summarize failures.",
  trace: false,
  retentionDays: null,
};

export function SettingsBuilder(_props: SettingsBuilderProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("settings");

  const [mode, setMode] = useState<"build" | "check">("build");
  const [draft, setDraft] = useState<SettingsDraft>(START);
  const [pasted, setPasted] = useState(PASTE_EXAMPLE);
  const built = buildSettings(draft);
  const builtText = JSON.stringify(built, null, 2);
  const builtCheck = checkSettings(built);
  const pastedCheck = checkSettingsText(pasted);
  const patch = (p: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchServer = (i: number, p: Partial<McpServerDraft>) => setDraft((d) => ({ ...d, mcpServers: d.mcpServers.map((s, j) => (j === i ? { ...s, ...p } : s)) }));

  const [levels, setLevels] = useState<Level[]>(START_LEVELS);
  const [trusted, setTrusted] = useState(true);
  const [userRules, setUserRules] = useState(true);
  const [template, setTemplate] = useState(AGENTS_TEMPLATES[0].id);
  const resolved = resolveInstructions(levels, trusted, userRules);
  const toggleFile = (i: number, f: InstructionFile, on: boolean) =>
    setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, present: on ? [...l.present, f] : l.present.filter((x) => x !== f) } : l)));

  const [scope, setScope] = useState<MemoryScope>("project");
  const [topics, setTopics] = useState("Deploy: how we ship to production and roll back\nFlaky tests: why test/sync.spec.ts retries twice\nBilling service: it rejects requests without an idempotency key");
  const memory = memoryLayout(topics.split("\n"), scope);

  const [launch, setLaunch] = useState<LaunchDraft>(START_LAUNCH);
  const lp = (p: Partial<LaunchDraft>) => setLaunch((l) => ({ ...l, ...p }));
  const launchOut = buildLaunch(launch);

  return (
    <div className="pg">
      <Tabs<View>
        label="Configuration"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "settings", label: "settings.json" },
          { id: "instructions", label: "Instruction files" },
          { id: "memory", label: "Memory" },
          { id: "flags", label: "Launch flags" },
          { id: "effort", label: "Reasoning effort, live" },
        ]}
      />

      <Panel idBase={idBase} id="settings" active={view === "settings"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<"build" | "check">
              label="Settings file"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "build", label: "Build one" },
                { value: "check", label: "Check yours" },
              ]}
            />
          </div>
          {mode === "build" ? (
            <>
              <div className={styles.row}>
                <SelectField
                  id={`${idBase}-profile`}
                  label="permissions.default_profile"
                  value={draft.defaultProfile}
                  onChange={(v) => patch({ defaultProfile: v as SettingsDraft["defaultProfile"] })}
                  options={[{ value: "", label: "Not set (Auto-review)" }, ...PROFILE_IDS.map((p) => ({ value: p, label: p }))]}
                />
                <NumberField id={`${idBase}-ret`} label="session_retention_days" value={draft.retentionDays} min={1} onChange={(retentionDays) => patch({ retentionDays })} hint="Empty keeps sessions forever." />
                <NumberField id={`${idBase}-cap`} label="agents.execution_capacity" value={draft.executionCapacity} min={1} max={64} onChange={(executionCapacity) => patch({ executionCapacity })} hint="1-64; 8 by default." />
                <SelectField
                  id={`${idBase}-bg`}
                  label="tui.terminal_background"
                  value={draft.terminalBackground}
                  onChange={(v) => patch({ terminalBackground: v as SettingsDraft["terminalBackground"] })}
                  options={[
                    { value: "", label: "Not set" },
                    { value: "auto", label: "auto" },
                    { value: "light", label: "light" },
                    { value: "dark", label: "dark" },
                  ]}
                />
              </div>
              <div className="pg-bar">
                <Check id={`${idBase}-schema`} label={<>Include &quot;schema_version&quot;: 1 (required)</>} checked={draft.schemaVersion} onChange={(schemaVersion) => patch({ schemaVersion })} />
                <Check id={`${idBase}-reason`} label="show_reasoning" checked={draft.showReasoning} onChange={(showReasoning) => patch({ showReasoning })} />
                <Check id={`${idBase}-oauth`} label="Turn off MCP OAuth client registration" checked={!draft.oauthDynamicRegistration} onChange={(off) => patch({ oauthDynamicRegistration: !off })} />
              </div>
              <Field id={`${idBase}-managed`} label="managed_hooks_path (centrally administered hooks)">
                <TextInput id={`${idBase}-managed`} className="pg-code-input" value={draft.managedHooksPath} placeholder="/etc/muse/hooks.json" spellCheck={false} onChange={(e) => patch({ managedHooksPath: e.target.value })} />
              </Field>

              <div className="pg-col">
                <p className="pg-section-label">MCP servers</p>
                {draft.mcpServers.map((s, i) => (
                  <McpServerEditor
                    key={i}
                    idBase={`${idBase}-mcp-${i}`}
                    value={s}
                    onChange={(p) => patchServer(i, p)}
                    onRemove={() => setDraft((d) => ({ ...d, mcpServers: d.mcpServers.filter((_, j) => j !== i) }))}
                  />
                ))}
                <div className="pg-actions">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setDraft((d) => ({ ...d, mcpServers: [...d.mcpServers, { ...EMPTY_SERVER, name: d.mcpServers.length ? `server-${d.mcpServers.length + 1}` : EMPTY_SERVER.name }] }))}>
                    Add an MCP server
                  </button>
                </div>
              </div>

              <CodeBlock code={builtText} label={SETTINGS_PATH} syntax="json" />
              <Problems errors={builtCheck.errors} warnings={[...builtCheck.warnings, ...draftWarnings(draft)]} ok="Valid for startup. A missing file is fine too: create it only when you have something to set." />
              <p className="pg-hint">
                Not built here: model defaults (use <C>--model</C> or <C>/models</C>), <C>hooks</C> and <C>runtime_capabilities</C>, whose shapes these pages
                don&apos;t spell out. Values in MCP <C>url</C> and headers expand <C>{"${VAR}"}</C> and <C>{"${VAR:-default}"}</C>, so the file can keep secrets out.
              </p>
            </>
          ) : (
            <>
              <JsonEditor id={`${idBase}-paste`} label="Paste your settings.json" value={pasted} onChange={setPasted} rows={10} resetTo={PASTE_EXAMPLE} />
              <Problems errors={pastedCheck.errors} warnings={pastedCheck.warnings} ok="Nothing on these pages would reject it." />
              <p className="pg-hint">
                Enterprise administrators check managed configuration with <C>muse config validate --plane &lt;defaults|policy&gt; --file &lt;path&gt;</C> and the active one with{" "}
                <C>muse config status</C>.
              </p>
            </>
          )}
        </div>
      </Panel>

      <Panel idBase={idBase} id="instructions" active={view === "instructions"}>
        <div className="pg-col">
          <p className="pg-hint">From the workspace root, Muse Code walks up to the nearest .git boundary. Tick the files that exist at each level.</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Directory</th>
                  {INSTRUCTION_FILES.map((f) => (
                    <th key={f} scope="col">
                      {f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {levels.map((l, i) => (
                  <tr key={l.dir}>
                    <th scope="row" className={styles.mono}>
                      {l.dir}
                      <span className="pg-muted pg-small">{i === 0 ? " (.git boundary)" : i === levels.length - 1 ? " (workspace root)" : ""}</span>
                    </th>
                    {INSTRUCTION_FILES.map((f) => (
                      <td key={f}>
                        <input type="checkbox" aria-label={`${l.dir}/${f} exists`} checked={l.present.includes(f)} onChange={(e) => toggleFile(i, f, e.target.checked)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pg-bar">
            <Toggle id={`${idBase}-trust`} label="Workspace trusted" checked={trusted} onChange={setTrusted} />
            <Toggle id={`${idBase}-user`} label="I have user rules" checked={userRules} onChange={setUserRules} />
          </div>
          <div className={styles.grid2} aria-live="polite">
            <div className={styles.card}>
              <p className={styles.cardTitle}>Loads, strongest first</p>
              {resolved.loaded.length ? (
                <ol className={styles.notes}>
                  {resolved.loaded.map((x) => (
                    <li key={x.path}>
                      <span className={styles.mono}>{x.path}</span>: {x.why}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="pg-empty">No instruction files load.</p>
              )}
            </div>
            <div className={styles.card}>
              <p className={styles.cardTitle}>Doesn&apos;t load</p>
              {resolved.ignored.length ? (
                <ul className={styles.notes}>
                  {resolved.ignored.map((x) => (
                    <li key={x.path}>
                      <span className={styles.mono}>{x.path}</span>: {x.why}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pg-empty">Nothing is skipped.</p>
              )}
            </div>
          </div>
          <div className="pg-bar">
            <div className="pg-field">
              <span className="pg-label">Start an AGENTS.md</span>
              <Segmented label="Template" size="sm" value={template} onChange={setTemplate} options={AGENTS_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))} />
            </div>
          </div>
          <CodeBlock code={AGENTS_TEMPLATES.find((t) => t.id === template)?.body ?? ""} label="AGENTS.md" syntax="markdown" />
          <CodeBlock code={"muse init            # write AGENTS.md in the current directory\nmuse init --dry-run  # show what it would write, change nothing"} label="Or let Muse Code seed it" />
          <Notes
            items={[
              "muse init writes a single AGENTS.md and nothing else, and doesn't touch settings.json. It stops if AGENTS.md exists; --force overwrites it completely.",
              "Conservative by default: it won't commit, amend or push unless you ask in the session, keeps scratch files outside your checkout, and reverts incidental edits.",
            ]}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="memory" active={view === "memory"}>
        <div className="pg-col">
          <SelectField<MemoryScope> id={`${idBase}-scope`} label="Scope" value={scope} onChange={setScope} options={MEMORY_SCOPES.map((m) => ({ value: m.value, label: m.label }))} hint={MEMORY_SCOPES.find((m) => m.value === scope)?.where} />
          <Field id={`${idBase}-topics`} label="Topics (Name: what the note says, one per line)">
            <TextArea id={`${idBase}-topics`} rows={4} value={topics} onChange={(e) => setTopics(e.target.value)} />
          </Field>
          <div className={styles.grid2}>
            <pre className={styles.tree} aria-label="Memory files">
              {memory.tree}
            </pre>
            <CodeBlock code={memory.index} label="MEMORY.md" syntax="markdown" />
          </div>
          <Problems warnings={memory.warnings} />
          <Notes
            items={[
              "Record durable, project-specific facts the agent could get wrong from general knowledge: deploy steps, why a workaround exists, a service's unusual behavior.",
              "At session start Muse Code injects MEMORY.md and the other files' paths (not their contents); the agent reads files on demand, and a background observer can surface a relevant note.",
            ]}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="flags" active={view === "flags"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<LaunchDraft["surface"]>
              label="Launch surface"
              size="sm"
              value={launch.surface}
              onChange={(surface) => lp({ surface })}
              options={[
                { value: "interactive", label: "muse (interactive)" },
                { value: "headless", label: "muse exec (headless)" },
              ]}
            />
          </div>
          <div className={styles.row}>
            <Field id={`${idBase}-model`} label="--model" className={styles.narrow}>
              <TextInput id={`${idBase}-model`} className="pg-code-input" value={launch.model} placeholder="muse-spark-1.2" spellCheck={false} onChange={(e) => lp({ model: e.target.value })} />
            </Field>
            <SelectField id={`${idBase}-effort`} label="--reasoning-effort" value={launch.effort} onChange={(v) => lp({ effort: v as LaunchDraft["effort"] })} options={[{ value: "", label: "Default (high)" }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))]} />
            <SelectField id={`${idBase}-amode`} label="--approval-mode" value={launch.approvalMode} onChange={(v) => lp({ approvalMode: v as LaunchDraft["approvalMode"] })} options={[{ value: "", label: "Default (on-request)" }, { value: "on-request", label: "on-request" }, { value: "untrusted", label: "untrusted" }, { value: "never", label: "never" }]} />
            <SelectField id={`${idBase}-judge`} label="--approval-judge" value={launch.approvalJudge} onChange={(v) => lp({ approvalJudge: v as LaunchDraft["approvalJudge"] })} options={[{ value: "", label: "Default" }, { value: "on", label: "on" }, { value: "off", label: "off" }]} />
            <SelectField id={`${idBase}-net`} label="--sandbox-network" value={launch.sandboxNetwork} onChange={(v) => lp({ sandboxNetwork: v as LaunchDraft["sandboxNetwork"] })} options={[{ value: "", label: "Default (proxy-only)" }, { value: "proxy-only", label: "proxy-only" }, { value: "restricted", label: "restricted" }, { value: "unrestricted", label: "unrestricted" }]} />
            <SelectField id={`${idBase}-contrib`} label="--contributor-mode" value={launch.contributor} onChange={(v) => lp({ contributor: v as LaunchDraft["contributor"] })} options={[{ value: "", label: "Saved setting" }, { value: "on", label: "on" }, { value: "off", label: "off" }]} />
          </div>
          <div className={styles.checkGrid}>
            <Check id={`${idBase}-yolo`} label="--yolo" checked={launch.yolo} onChange={(yolo) => lp({ yolo })} />
            <Check id={`${idBase}-da`} label="--disable-approval" checked={launch.disableApproval} onChange={(disableApproval) => lp({ disableApproval })} />
            <Check id={`${idBase}-ds`} label="--disable-sandbox" checked={launch.disableSandbox} onChange={(disableSandbox) => lp({ disableSandbox })} />
            <Check id={`${idBase}-tw`} label="--trust-workspace" checked={launch.trustWorkspace} onChange={(trustWorkspace) => lp({ trustWorkspace })} />
            <Check id={`${idBase}-nsl`} label="--no-session-log" checked={launch.noSessionLog} onChange={(noSessionLog) => lp({ noSessionLog })} />
            <Check id={`${idBase}-trace`} label="MUSE_TRANSPORT_TRACE=1 (debug provider calls)" checked={launch.trace} onChange={(trace) => lp({ trace })} />
          </div>
          <div className={styles.row}>
            <Field id={`${idBase}-ws`} label="--workspace" className={styles.narrow}>
              <TextInput id={`${idBase}-ws`} className="pg-code-input" value={launch.workspace} placeholder="./packages/api" spellCheck={false} onChange={(e) => lp({ workspace: e.target.value })} />
            </Field>
            <NumberField id={`${idBase}-retention`} label="-c session_retention_days" value={launch.retentionDays} min={1} onChange={(retentionDays) => lp({ retentionDays })} />
          </div>
          {launch.surface === "headless" ? (
            <div className={styles.row}>
              <Field id={`${idBase}-prompt`} label="Prompt" className={styles.grow}>
                <TextInput id={`${idBase}-prompt`} value={launch.prompt} onChange={(e) => lp({ prompt: e.target.value })} disabled={!!launch.promptFile.trim()} />
              </Field>
              <Field id={`${idBase}-pf`} label="--prompt-file" className={styles.narrow}>
                <TextInput id={`${idBase}-pf`} className="pg-code-input" value={launch.promptFile} placeholder="./task.txt" spellCheck={false} onChange={(e) => lp({ promptFile: e.target.value })} />
              </Field>
              <NumberField id={`${idBase}-steps`} label="--max-model-steps" value={launch.maxSteps} min={1} onChange={(maxSteps) => lp({ maxSteps })} />
              <Toggle id={`${idBase}-json`} label="--json" checked={launch.json} onChange={(json) => lp({ json })} />
            </div>
          ) : (
            <p className="pg-hint">
              <C>--json</C>, <C>--prompt-file</C> and <C>--max-model-steps</C> exist only on <C>muse exec</C>.
            </p>
          )}
          <CodeBlock code={launchOut.command} label="bash" />
          <Problems errors={launchOut.errors} warnings={launchOut.warnings} />
          <p className="pg-hint">
            <Chip>Common to both</Chip> --model, --reasoning-effort, the sandbox and approval flags, --trust-workspace, --workspace, --no-session-log, --contributor-mode,
            and the compatibility flag --subagent-worktree-isolation (isolation is still chosen per subagent).
          </p>
        </div>
      </Panel>

      <Panel idBase={idBase} id="effort" active={view === "effort"}>
        <EffortCompare />
      </Panel>
    </div>
  );
}
