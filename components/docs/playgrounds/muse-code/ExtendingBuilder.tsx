"use client";

import { useId, useState } from "react";
import { Field, Segmented, Tabs, TextArea, TextInput, Toggle } from "@/components/docs/kit";
import { CI_PLATFORMS, ciConfig, EXIT_CODES, POSTURES, type CiPlatform, type Posture } from "@/components/docs/playgrounds/muse-code/ci";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import {
  HOOK_EVENTS,
  HOOK_SOURCES,
  hookRisk,
  leadPrompt,
  resumeCommands,
  sessionIdProblem,
  SKILL_SOURCES,
  skillFiles,
  skillId,
  subagentCapacity,
  toolsetMatch,
  type HookSource,
  type RootEffort,
  type SkillScope,
} from "@/components/docs/playgrounds/muse-code/extending";
import { McpServerEditor } from "@/components/docs/playgrounds/muse-code/McpServerEditor";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { classifyStage, parseCommand } from "@/components/docs/playgrounds/muse-code/permissions";
import { buildSettings, checkSettings, EMPTY_SERVER, type McpServerDraft, type SettingsDraft } from "@/components/docs/playgrounds/muse-code/settings";
import { C, Check, Chip, Notes, NumberField, Panel, Problems, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The extending page's demo: plan subagents against the tree's capacity and write the lead's prompt, package a skill,
 * pick a hook event and source and review the command it would run outside the sandbox, declare an MCP server and test
 * a named toolset's patterns, and build a headless CI run with the exit codes and the resume and export commands.
 */

export interface ExtendingBuilderProps {
  slug: string;
}

type View = "subagents" | "skills" | "hooks" | "mcp" | "headless";

const SETTINGS_BASE: SettingsDraft = {
  schemaVersion: true,
  defaultProfile: "",
  retentionDays: null,
  showReasoning: false,
  terminalBackground: "",
  executionCapacity: null,
  managedHooksPath: "",
  oauthDynamicRegistration: true,
  mcpServers: [],
};

const OBSERVERS = [
  ["Memory recall", "Surfaces a note from local project memory relevant to the next reply."],
  ["Skill recall", "Surfaces a project skill the task should load first."],
  ["Goal tracking", "Holds the agent to a declared goal and declines to close the turn until the work is done."],
  ["Verification", "Checks that the agent ran the work it claims it finished."],
] as const;

export function ExtendingBuilder(_props: ExtendingBuilderProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("subagents");

  const [capacitySetting, setCapacitySetting] = useState<number | null>(null);
  const [effort, setEffort] = useState<RootEffort>("default");
  const [wanted, setWanted] = useState<number | null>(10);
  const [leadTask, setLeadTask] = useState("Upgrade the logging library across the monorepo");
  const [kids, setKids] = useState([
    { task: "updates packages/api and runs its tests", writes: true },
    { task: "updates packages/web and runs its tests", writes: true },
    { task: "reviews the changelog of the new version for breaking changes", writes: false },
  ]);
  const plan = subagentCapacity(capacitySetting, effort, wanted ?? 0);

  const [skillName, setSkillName] = useState("release-notes");
  const [displayName, setDisplayName] = useState("");
  const [skillScope, setSkillScope] = useState<SkillScope>("project");
  const [skillDesc, setSkillDesc] = useState("Draft release notes from merged changes. Use when asked for release notes or a changelog entry.");
  const [skillBody, setSkillBody] = useState("# Release notes\n\n1. List merged changes since the last tag with git log.\n2. Group them as New, Improvements and Fixes.\n3. Write one line per change, user-facing, no internal ticket ids.\n4. Show the draft and stop for review.");
  const sid = skillId(skillName);
  const skill = skillFiles(sid, skillScope, skillDesc, skillBody, displayName);

  const [event, setEvent] = useState("PreToolUse");
  const [hookSource, setHookSource] = useState<HookSource>("project");
  const [hookCmd, setHookCmd] = useState("npx prettier --check . && curl -fsS https://hooks.example.com/notify");
  const ev = HOOK_EVENTS.find((e) => e.name === event) ?? HOOK_EVENTS[0];
  const src = HOOK_SOURCES[hookSource];
  const hookParse = parseCommand(hookCmd);
  const hookReview = hookParse.stages.map((s) => ({ text: s.text, info: classifyStage(s) }));

  const [server, setServer] = useState<McpServerDraft>({ ...EMPTY_SERVER, transport: "streamable_http" });
  const mcpSettings = buildSettings({ ...SETTINGS_BASE, mcpServers: [server] });
  const mcpCheck = checkSettings(mcpSettings);
  const [patterns, setPatterns] = useState("mcp__docs__search*\nmcp__github__create_issue");
  const [tools, setTools] = useState("mcp__docs__search\nmcp__docs__search_pages\nmcp__docs__fetch\nmcp__github__list_issues");
  const toolset = toolsetMatch(patterns.split("\n"), tools.split("\n"));

  const [platform, setPlatform] = useState<CiPlatform>("github");
  const [prompt, setPrompt] = useState("Update the changelog for the latest release and run the tests.");
  const [posture, setPosture] = useState<Posture>("disable-approval");
  const [maxSteps, setMaxSteps] = useState<number | null>(60);
  const [json, setJson] = useState(true);
  const [verify, setVerify] = useState("npm test");
  const [sessionId, setSessionId] = useState("");
  const [switchWs, setSwitchWs] = useState(false);
  const ci = ciConfig({ platform, secret: "MUSE_KEY", prompt, posture, maxSteps, json, contributor: "off", verify });

  return (
    <div className="pg">
      <Tabs<View>
        label="Extending and automating"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "subagents", label: "Subagents" },
          { id: "skills", label: "Skills" },
          { id: "hooks", label: "Hooks" },
          { id: "mcp", label: "MCP servers" },
          { id: "headless", label: "Headless and CI" },
        ]}
      />

      <Panel idBase={idBase} id="subagents" active={view === "subagents"}>
        <div className="pg-col">
          <div className={styles.row}>
            <NumberField id={`${idBase}-cap`} label="agents.execution_capacity" value={capacitySetting} min={1} max={64} onChange={setCapacitySetting} hint="Empty for the default." />
            <SelectField<RootEffort>
              id={`${idBase}-effort`}
              className="pg-advanced"
              label="Root's reasoning effort"
              value={effort}
              onChange={setEffort}
              options={[
                { value: "default", label: "Anything below max" },
                { value: "max", label: "max" },
                { value: "ultra", label: "ultra" },
              ]}
            />
            <NumberField id={`${idBase}-wanted`} label="Children and grandchildren at once" value={wanted} min={0} onChange={setWanted} />
          </div>
          <div className={`${styles.card} ${styles.cardMuted}`} role="status" aria-live="polite">
            <p className={styles.big}>
              {plan.capacity} agents at once, root included: {plan.running} running{plan.rejected ? `, ${plan.rejected} rejected` : ""}
            </p>
            <Notes
              className="pg-advanced"
              items={[
                `Capacity: ${plan.source}.`,
                plan.rejected ? "A spawn attempted when the tree is full is rejected, not queued. Raise agents.execution_capacity in user settings and start a new session." : "An accepted child can still wait for a host scheduler slot before it starts.",
                "Children can spawn grandchildren, and every descendant shares the root tree's capacity.",
              ]}
            />
          </div>
          <Field id={`${idBase}-lead`} label="The lead's job">
            <TextInput id={`${idBase}-lead`} value={leadTask} onChange={(e) => setLeadTask(e.target.value)} />
          </Field>
          {kids.map((k, i) => (
            <div key={i} className={`${styles.row} pg-advanced`}>
              <Field id={`${idBase}-kid-${i}`} label={`Subagent ${i + 1}`} className={styles.grow}>
                <TextInput id={`${idBase}-kid-${i}`} value={k.task} onChange={(e) => setKids((ks) => ks.map((x, j) => (j === i ? { ...x, task: e.target.value } : x)))} />
              </Field>
              <Check id={`${idBase}-kid-${i}-w`} label="Writes files (isolated worktree)" checked={k.writes} onChange={(writes) => setKids((ks) => ks.map((x, j) => (j === i ? { ...x, writes } : x)))} />
            </div>
          ))}
          <div className="pg-actions pg-advanced">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setKids((ks) => [...ks, { task: "", writes: false }])} disabled={kids.length >= 6}>
              Add a subagent
            </button>
          </div>
          <CodeBlock code={leadPrompt({ task: leadTask, children: kids })} label="Ask the lead session" syntax="text" />
          {capacitySetting !== null ? <CodeBlock code={JSON.stringify({ schema_version: 1, agents: { execution_capacity: plan.capacity } }, null, 2)} label="~/.config/muse/settings.json" syntax="json" /> : null}
          <Notes
            className="pg-advanced"
            items={[
              "Isolation is chosen per child and needs a Git repository. It can be rejected when the profile, workspace, provider or Git state can't support it, and it never silently falls back to the shared checkout.",
              "Cancellation is cooperative: a cancelled child that never reaches a checkpoint keeps running, and one mid-write finishes that write.",
              "Steer them with /subagents and /tasks. The runtime journals every spawn, status change and control action.",
            ]}
          />
          <div className="pg-advanced">
            <p className="pg-section-label">Background observers (on by default, each with its own model calls)</p>
            <ul className={styles.notes}>
              {OBSERVERS.map(([name, text]) => (
                <li key={name}>
                  <strong>{name}</strong>: {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      <Panel idBase={idBase} id="skills" active={view === "skills"}>
        <div className="pg-col">
          <div className={styles.row}>
            <Field id={`${idBase}-sname`} label="Skill id" className={styles.narrow} hint={sid !== skillName ? `Saved as ${sid}` : undefined}>
              <TextInput id={`${idBase}-sname`} className="pg-code-input" value={skillName} spellCheck={false} onChange={(e) => setSkillName(e.target.value)} />
            </Field>
            <Field id={`${idBase}-sdisplay`} label="metadata.display-name (optional)" className={`${styles.narrow} pg-advanced`}>
              <TextInput id={`${idBase}-sdisplay`} value={displayName} placeholder="Release notes" onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <div className="pg-field pg-advanced">
              <span className="pg-label">Scope</span>
              <Segmented<SkillScope>
                label="Skill scope"
                size="sm"
                value={skillScope}
                onChange={setSkillScope}
                options={[
                  { value: "project", label: "Project" },
                  { value: "user", label: "User" },
                ]}
              />
            </div>
          </div>
          <Field id={`${idBase}-sdesc`} label="Description: what it does and when to load it">
            <TextInput id={`${idBase}-sdesc`} value={skillDesc} onChange={(e) => setSkillDesc(e.target.value)} />
          </Field>
          <Field id={`${idBase}-sbody`} label="Instructions">
            <TextArea id={`${idBase}-sbody`} rows={5} value={skillBody} onChange={(e) => setSkillBody(e.target.value)} />
          </Field>
          {/* Stacked: side by side, the narrow column cut off the commands and their comments. */}
          <div className="pg-col">
            <CodeBlock code={skill.skillMd} label={`${skill.dir}/SKILL.md`} syntax="markdown" />
            <CodeBlock code={skill.commands} label="bash" />
          </div>
          <p className="pg-hint">
            {skillScope === "project" ? (
              <>
                Write it at <C>{skill.dir}/SKILL.md</C> in the repo, where project skills load from.
              </>
            ) : (
              <>
                Write it in a working folder, <C>{skill.dir}/SKILL.md</C>; <C>muse skills install</C> with <C>--scope user</C> adds it to your user skills for every project.
              </>
            )}{" "}
            The front matter follows the shape Claude Code and Codex skills use, which Muse Code discovers and imports. <C>muse skills validate</C> checks it against
            your version first.
          </p>
          <div className={`${styles.tableWrap} pg-advanced`}>
            <table className={styles.table}>
              <caption className="sr-only">Where skills load from</caption>
              <tbody>
                {SKILL_SOURCES.map((s) => (
                  <tr key={s.source}>
                    <th scope="row">{s.source}</th>
                    <td>{s.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock className="pg-advanced" code={"muse skills import --from claude   # or: --from codex\n/migrate                           # memory notes and MCP servers from Claude Code or Codex"} label="Bring skills from another agent" />
        </div>
      </Panel>

      <Panel idBase={idBase} id="hooks" active={view === "hooks"}>
        <div className="pg-col">
          <div className={styles.row}>
            <SelectField id={`${idBase}-event`} label="Lifecycle event" value={event} onChange={setEvent} options={HOOK_EVENTS.map((e) => ({ value: e.name, label: e.name }))} />
            <div className="pg-field">
              <span className="pg-label">Source</span>
              <Segmented<HookSource>
                label="Hook source"
                size="sm"
                value={hookSource}
                onChange={setHookSource}
                options={[
                  { value: "project", label: "Project" },
                  { value: "user", label: "User" },
                  { value: "managed", label: "Managed" },
                ]}
              />
            </div>
          </div>
          <div className={styles.grid2} aria-live="polite">
            <div className={styles.card}>
              <p className={styles.cardTitle}>{ev.name}</p>
              <p className="pg-small">{ev.when}</p>
              {ev.power ? <p className="pg-small">{ev.power}</p> : null}
              <p className="pg-small pg-muted">A hook binds to exactly one event.</p>
            </div>
            <div className={styles.card}>
              <p className={styles.cardTitle}>{hookSource === "project" ? "Project hooks" : hookSource === "user" ? "User hooks" : "Managed hooks"}</p>
              <ul className={styles.notes}>
                <li>{src.where}</li>
                <li>{src.trust}</li>
                <li>{src.malformed}</li>
              </ul>
            </div>
          </div>
          <Field id={`${idBase}-hookcmd`} label="The shell command the hook runs">
            <TextInput id={`${idBase}-hookcmd`} className="pg-code-input" value={hookCmd} spellCheck={false} onChange={(e) => setHookCmd(e.target.value)} />
          </Field>
          <div className="pg-warn" role="status">
            <p className="pg-warn-title">Hooks run outside the sandbox</p>
            <p>
              A hook&apos;s command runs directly through your shell, outside the sandbox and approval that govern the agent&apos;s tools. The only hardening is a cleared
              environment with a small allowlist. Only add hooks whose commands you&apos;ve read.
            </p>
            {hookParse.problem ? <p>{hookParse.problem}</p> : null}
            {hookReview.length ? (
              <ul>
                {hookReview.map((r, i) => (
                  <li key={i}>
                    <C>{r.text}</C>: {hookRisk(r.info)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Notes
            className="pg-advanced"
            items={[
              "Muse Code discovers and validates hooks at session startup. Unsupported events, matchers or handlers skip that entry with a warning.",
              "There is no muse hooks command or per-hook trust command: fix the reported configuration and start a new session to reload it.",
              "Hook commands see the top-level chat's session id in MUSE_SESSION_ID and the running chat or subagent's in MUSE_THREAD_ID (changelog).",
            ]}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="mcp" active={view === "mcp"}>
        <div className="pg-col">
          <McpServerEditor idBase={`${idBase}-server`} value={server} onChange={(p) => setServer((s) => ({ ...s, ...p }))} />
          <CodeBlock code={JSON.stringify(mcpSettings, null, 2)} label="~/.config/muse/settings.json" syntax="json" />
          <Problems errors={mcpCheck.errors} warnings={mcpCheck.warnings} ok="The server entry passes the checks on these pages." />
          {server.transport === "streamable_http" ? (
            <CodeBlock className="pg-advanced" code={`muse mcp login ${server.name || "<server>"}    # OAuth 2.1 sign-in; tokens are kept and refreshed\nmuse mcp logout ${server.name || "<server>"}`} label="If the server needs a sign-in" />
          ) : null}
          <Notes
            className="pg-advanced"
            items={[
              "mode defaults to required: if a required server fails to start, the whole run aborts. optional skips it with a warning.",
              "Configs support ${VAR} interpolation, and Muse Code passes MUSE_SESSION_ID to stdio servers.",
              "A tool its server declares read-only runs without an approval prompt under on-request approvals. Run /mcp for a live inventory.",
              "MCP tools aren't sandboxed: a stdio server is an ordinary child process and an HTTP server a direct connection. Approval still applies; containment doesn't.",
            ]}
          />
          <div className="pg-col pg-advanced">
            <p className="pg-section-label">Test a named toolset (run.toolset)</p>
            <div className={styles.grid2}>
              <Field id={`${idBase}-pat`} label="Selected tool names (full names, or a trailing *)">
                <TextArea id={`${idBase}-pat`} className="pg-code-input" rows={4} value={patterns} spellCheck={false} onChange={(e) => setPatterns(e.target.value)} />
              </Field>
              <Field id={`${idBase}-tools`} label="Tools the connected servers offer">
                <TextArea id={`${idBase}-tools`} className="pg-code-input" rows={4} value={tools} spellCheck={false} onChange={(e) => setTools(e.target.value)} />
              </Field>
          </div>
          <ul className={styles.list} aria-live="polite" aria-label="Toolset matches">
            {toolset.tools.map((t) => (
              <li key={t.tool}>
                <div className={styles.itemHead}>
                  <span className={styles.itemName}>{t.tool}</span>
                  {t.matchedBy ? <Chip tone="ok">Selected by {t.matchedBy}</Chip> : <Chip>Not in the toolset</Chip>}
                </div>
              </li>
            ))}
          </ul>
          <Problems
            errors={[
              ...toolset.missing.map((m) => `${m} is selected but no server offers it: the run stops before contacting the model and lists every missing name.`),
              ...toolset.invalid.map((m) => `${m} isn't an MCP tool name: use mcp__<server>__<tool>, optionally ending in *.`),
            ]}
          />
          </div>
        </div>
      </Panel>

      <Panel idBase={idBase} id="headless" active={view === "headless"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<CiPlatform> label="Where it runs" size="sm" value={platform} onChange={setPlatform} options={CI_PLATFORMS} />
          </div>
          <Field id={`${idBase}-prompt`} label="Prompt">
            <TextInput id={`${idBase}-prompt`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          <div className={`${styles.row} pg-advanced`}>
            <SelectField<Posture> id={`${idBase}-posture`} label="Approvals" className={styles.grow} value={posture} onChange={setPosture} options={POSTURES} />
            <NumberField id={`${idBase}-steps`} label="--max-model-steps" value={maxSteps} min={1} onChange={setMaxSteps} />
            <Field id={`${idBase}-verify`} label="Your own check after the run" className={styles.narrow}>
              <TextInput id={`${idBase}-verify`} className="pg-code-input" value={verify} spellCheck={false} onChange={(e) => setVerify(e.target.value)} />
            </Field>
          </div>
          <div className="pg-advanced">
            <Toggle id={`${idBase}-json`} label="--json (JSONL events on stdout)" checked={json} onChange={setJson} />
          </div>
          <CodeBlock code={ci.code} label={ci.label} syntax={ci.syntax} />
          <Problems warnings={ci.warnings} ok="This run can finish unattended and is gated on your own check." />
          <div className={`${styles.tableWrap} pg-advanced`}>
            <table className={styles.table}>
              <caption className="sr-only">muse exec exit codes</caption>
              <thead>
                <tr>
                  <th scope="col">Exit code</th>
                  <th scope="col">How the run ended</th>
                </tr>
              </thead>
              <tbody>
                {EXIT_CODES.map((e) => (
                  <tr key={e.code}>
                    <th scope="row" className={styles.mono}>
                      {e.code}
                    </th>
                    <td>{e.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pg-col pg-advanced">
            <p className="pg-section-label">Resume and audit without the UI</p>
            <div className={styles.row}>
              <Field id={`${idBase}-sid`} label="Session id" className={styles.grow}>
                <TextInput id={`${idBase}-sid`} className="pg-code-input" value={sessionId} placeholder="6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24" spellCheck={false} onChange={(e) => setSessionId(e.target.value)} />
              </Field>
              <Check id={`${idBase}-switch`} label="--allow-workspace-switch" checked={switchWs} onChange={setSwitchWs} />
          </div>
          <Problems errors={sessionIdProblem(sessionId) ? [sessionIdProblem(sessionId)!] : []} />
          <CodeBlock code={resumeCommands(sessionId, "run.json", switchWs)} label="bash" />
          <Notes
            items={[
              "muse resume opens the interactive UI; muse exec --session-id is the headless way to continue.",
              "Muse Code refuses a workspace mismatch unless you pass --allow-workspace-switch.",
              "The export embeds the CLI version that produced it, so pin the version if you gate on its hash.",
            ]}
          />
          </div>
        </div>
      </Panel>
    </div>
  );
}
