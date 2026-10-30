"use client";

import { useId, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, TextArea, TextInput, runOnModEnter } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { skillAnswerBody, skillFirstBody } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import {
  decisionMarkdown,
  DECISIONS_MD,
  safeHex,
  skillById,
  SKILLS,
  TASTE_DEFAULTS,
  type QuestionReply,
  type SkillId,
  type TasteReply,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/skills";
import { Chip, Section, ShowCode, Steps, Terminal, type StepState } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The bundled-skills recipe as an explorer: the four built-in skills (/plan, /grilling, /grill-with-docs, /taste),
 * what each does and when to reach for it, the loading contract (summaries at session open, the full SKILL.md only
 * on invocation, for that turn), and a live run of the recipe's own prompt on its sample project in each skill's
 * style: a streamed plan that stops for approval, one structured question at a time, decisions written to
 * docs/DECISIONS.md, or the /taste checklist mapped to choices.
 */

export interface SkillExplorerProps {
  slug: string;
  skill?: SkillId;
}

interface QaTurn {
  reply: QuestionReply;
  answer: string | null;
  /** The response that asked this question, which the answer continues with previous_response_id. */
  responseId: string | null;
}

export function SkillExplorer(props: SkillExplorerProps) {
  const id = useId();
  const [skillId, setSkillId] = useState<SkillId>(props.skill ?? "plan");
  const skill = skillById(skillId);
  const [prompt, setPrompt] = useState(skill.prompt);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [ran, setRan] = useState(false);
  const [custom, setCustom] = useState("");
  const [planDecision, setPlanDecision] = useState<string | null>(null);
  // /plan streams prose; the interviews and /taste come back as strict JSON.
  const stream = useDocsRun();
  const [plan, setPlan] = useState<Collected | null>(null);
  const json = useStrictJson<QuestionReply | TasteReply>();
  const [qa, setQa] = useState<QaTurn[]>([]);
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const running = stream.state === "running" || json.state === "running";

  const pick = (s: SkillId) => {
    setSkillId(s);
    setPrompt(skillById(s).prompt);
    setRan(false);
    setPlan(null);
    setQa([]);
    setPlanDecision(null);
    setLastBody(null);
    stream.reset();
    json.clear();
  };

  const firstBody = () => skillFirstBody(model, skill, prompt);

  const run = async () => {
    if (running || !prompt.trim()) return;
    setRan(true);
    setPlanDecision(null);
    const body = firstBody();
    setLastBody(body);
    if (skill.shape === "plan") {
      const collector = responsesCollector();
      setPlan(null);
      await stream.run("responses", {
        method: "POST",
        body,
        stream: true,
        onEvent: (e: SseEvent) => {
          collector.push(e);
          setPlan(collector.snapshot());
        },
      });
      setPlan(collector.snapshot());
      return;
    }
    setQa([]);
    const { value, reply } = await json.run(body);
    if (value && skill.shape !== "taste") setQa([{ reply: value as QuestionReply, answer: null, responseId: reply?.id ?? null }]);
  };

  /** Answers the open question, continuing the response that asked it. A failed answer can be given again. */
  const answerWith = async (text: string) => {
    const last = qa[qa.length - 1];
    const previous = last?.responseId;
    if (!last || !previous || running || !text) return;
    const body = skillAnswerBody(model, skill, text, previous);
    setLastBody(body);
    setQa((turns) => turns.map((t, i) => (i === turns.length - 1 ? { ...t, answer: text } : t)));
    setCustom("");
    const { value, reply } = await json.run(body);
    if (value) setQa((turns) => [...turns, { reply: value as QuestionReply, answer: null, responseId: reply?.id ?? null }]);
    else {
      setQa((turns) => turns.map((t, i) => (i === turns.length - 1 ? { ...t, answer: null } : t)));
      // A typed answer that didn't go through comes back to its box; a picked option can simply be picked again.
      if (!last.reply.options.some((o) => o.label === text)) setCustom((c) => c || text);
    }
  };

  const records = qa.map((t) => t.reply.decision_record).filter((r): r is NonNullable<QuestionReply["decision_record"]> => !!r && !!r.decision.trim());
  const taste = skill.shape === "taste" && json.value ? (json.value as TasteReply) : null;
  const current = qa[qa.length - 1];

  const stepState = (s: string): StepState => (s === "catalog" ? "done" : !ran ? "idle" : s === "apply" && running ? "active" : "done");
  const steps = [
    { id: "catalog", label: "1. CATALOG", state: stepState("catalog"), detail: "At session open, skills load as summaries only, so they cost no context" },
    { id: "invoke", label: "2. INVOKE", state: stepState("invoke"), detail: `You name it: ${skill.invoke}. Never because a task looks complex` },
    { id: "load", label: "3. LOAD", state: stepState("load"), detail: "read_skill pulls the full SKILL.md for this turn" },
    { id: "apply", label: "4. APPLY", state: stepState("apply"), detail: "The instructions shape the turn you invoked it on, not the session" },
  ];

  return (
    <div className={`pg ${styles.stack}`}>
      <Segmented<SkillId> label="Skill" options={SKILLS.map((s) => ({ value: s.id, label: s.invoke }))} value={skillId} onChange={pick} disabled={running} />
      <div className={styles.split}>
        <div className={styles.tight}>
          <p className={styles.cardTitle}>
            <code>{skill.invoke}</code> <Chip>built-in</Chip> <Chip tone={skill.stopsToAsk === "No" ? undefined : "accent"}>Stops to ask: {skill.stopsToAsk}</Chip>
          </p>
          <p className={styles.cardText}>{skill.does}</p>
          <p className={`${styles.note} pg-advanced`}>
            <strong>Use it when</strong> {skill.whenToUse.charAt(0).toLowerCase() + skill.whenToUse.slice(1)}
          </p>
          <p className={`${styles.note} pg-advanced`}>
            <strong>What comes back:</strong> {skill.output}
          </p>
        </div>
        <div className="pg-advanced">
          <Terminal
            title="muse skills list (simulated)"
            lines={[
              { text: "muse skills list", tone: "cmd" },
              ...SKILLS.map((s) => ({ text: `${s.id.padEnd(16)} built-in   muse-core`, tone: s.id === skillId ? ("ok" as const) : ("plain" as const) })),
              { text: "(the four this recipe drives; all are on by default)", tone: "muted" },
            ]}
          />
        </div>
      </div>
      <Steps label="The bundled-skill contract" steps={steps} />

      <details className="pg-advanced">
        <summary className={styles.note}>The sample project ({skill.files.map((f) => f.path).join(", ")})</summary>
        <pre className={styles.tree}>{skill.files.map((f) => `--- ${f.path} ---\n${f.text}`).join("\n\n")}</pre>
      </details>

      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
      </div>
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          The turn that invokes the skill
        </label>
        <TextArea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={runOnModEnter(() => void run())} disabled={running} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">The live run follows this demo&apos;s summary of the skill, not Muse Code&apos;s own SKILL.md. Under a cent.</span>
          <RunButton running={running} onRun={() => void run()} onStop={() => (skill.shape === "plan" ? stream.abort() : json.abort())} label={`Run ${skill.invoke}`} disabled={!prompt.trim()} />
        </div>
      </div>

      {ran ? <Terminal title="TUI" lines={[{ text: `Loaded skill ${skill.id} · built-in`, tone: "ok" }]} copy={false} /> : null}

      {skill.shape === "plan" && (stream.state === "running" || stream.result) ? (
        <ResponseView result={stream.state === "running" ? null : stream.result} running={stream.state === "running"} elapsedMs={stream.elapsedMs} json={plan?.final ?? undefined} usage={plan?.usage ?? undefined}>
          <StreamView text={plan?.text ?? ""} running={stream.state === "running"} placeholder="The plan appears here." />
          {stream.state !== "running" && plan?.text ? (
            <div className={styles.stack}>
              <p className={styles.note}>Muse Code saves the plan to .agents/plans/ and stops: no code changed.</p>
              <div className={styles.choices}>
                {["Approve", "Request changes", "Cancel"].map((c) => (
                  <button key={c} type="button" className={`btn btn-sm ${c === "Approve" ? "btn-primary" : "btn-outline"} ${styles.choice}`} onClick={() => setPlanDecision(c)} aria-pressed={planDecision === c}>
                    {c}
                  </button>
                ))}
              </div>
              {planDecision ? (
                <p className={styles.note} role="status">
                  {planDecision === "Approve" ? "Approved: the next turn implements the plan (this demo stops here)." : planDecision === "Cancel" ? "Cancelled: nothing was built." : "Edit the prompt with your changes and run /plan again."}
                </p>
              ) : null}
            </div>
          ) : null}
        </ResponseView>
      ) : null}

      {skill.shape !== "plan" && (json.state === "running" || json.result) ? (
        <ResponseView result={json.state === "running" ? null : json.result} running={json.state === "running"} elapsedMs={json.elapsedMs}>
          {taste ? (
            <div className={styles.stack}>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="sr-only">The defaults /taste avoids and what it chose instead</caption>
                  <thead>
                    <tr>
                      <th scope="col">Default it avoids</th>
                      <th scope="col">Instead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taste.avoided.map((a, i) => (
                      <tr key={i}>
                        <td>{a.default}</td>
                        <td>{a.instead}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className={styles.swatches} aria-label="Palette">
                {taste.palette.map((p) => {
                  const hex = safeHex(p.hex);
                  return (
                    <li key={`${p.name}-${p.hex}`} className={styles.swatch}>
                      <span className={styles.swatchColor} style={hex ? { background: hex } : undefined} aria-hidden />
                      {p.name} <code>{p.hex}</code>
                    </li>
                  );
                })}
              </ul>
              <p>
                <strong>Type:</strong> {taste.type_pairing}
              </p>
              <p>
                <strong>Layout:</strong> {taste.layout}
              </p>
              <p className={`${styles.note} pg-advanced`}>
                The checklist: {TASTE_DEFAULTS.join("; ")}. /taste only removes these defaults; an explicit brand or style request overrides it.
              </p>
            </div>
          ) : current ? (
            <div className={styles.stack}>
              {qa.slice(0, -1).map((t, i) => (
                <p key={i} className={styles.note}>
                  Q{i + 1}: {t.reply.question} <strong>Your answer:</strong> {t.answer}
                </p>
              ))}
              {current.reply.acknowledged ? <p className={styles.note}>{current.reply.acknowledged}</p> : null}
              <div className={styles.prompt}>
                <p className={styles.promptHead}>
                  Q{qa.length}: {current.reply.question}
                </p>
                {current.reply.grounded_in ? <p className={styles.note}>Grounded in {current.reply.grounded_in}</p> : null}
                <div className={styles.choices}>
                  {current.reply.options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className={`btn btn-sm ${o.recommended ? "btn-primary" : "btn-outline"} ${styles.choice}`}
                      onClick={() => void answerWith(o.label)}
                      disabled={running}
                      title={o.tradeoff}
                    >
                      {o.label}
                      {o.recommended ? " (recommended)" : ""}
                    </button>
                  ))}
                </div>
                <ul className="pg-list">
                  {current.reply.options.map((o) => (
                    <li key={o.label} className={styles.note}>
                      <strong>{o.label}:</strong> {o.tradeoff}
                    </li>
                  ))}
                </ul>
                <div className={styles.row}>
                  <label className="sr-only" htmlFor={`${id}-custom`}>
                    Answer in your own words
                  </label>
                  <TextInput id={`${id}-custom`} className={styles.grow} placeholder="Or answer in your own words" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) void answerWith(custom.trim()); }} disabled={running} />
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => void answerWith(custom.trim())} disabled={running || !custom.trim()}>
                    Answer
                  </button>
                </div>
              </div>
              {skill.shape === "question-with-record" ? (
                <Terminal title="docs/DECISIONS.md" lines={[DECISIONS_MD, ...records.map(decisionMarkdown)].join("\n\n").split("\n").map((t) => ({ text: t }))} live />
              ) : null}
              <p className={`${styles.note} pg-advanced`}>Each answer continues the same response with previous_response_id. The skill never starts implementing until you leave the interview.</p>
            </div>
          ) : (
            <p className="pg-empty">{running ? "Reading the project and choosing the hardest question..." : "No question in this reply."}</p>
          )}
        </ResponseView>
      ) : null}

      {json.retrying ? <p className={styles.note} role="status">Meta is still storing the last question; sending your answer again in a moment.</p> : null}
      <ErrorBox error={skill.shape === "plan" ? stream.error : json.error} />
      <ShowCode body={lastBody ?? firstBody()} caption={lastBody ? "The last request this skill sent" : "The request Run sends"} />

      <Section title="When a skill doesn't fire" className="pg-advanced">
        <p className={styles.note}>
          Each skill is explicit-invocation only, so &quot;implement transfer&quot; stays an ordinary implementation: ask with the slash command, or &quot;plan this before you build it.&quot; /grilling falls back to a plain question when the answer doesn&apos;t fit two or three short choices. /grill-with-docs asks where decisions live if you don&apos;t name a file.
        </p>
      </Section>
    </div>
  );
}
