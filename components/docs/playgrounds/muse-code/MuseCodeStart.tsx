"use client";

import { useEffect, useId, useState } from "react";
import { Field, Segmented, Tabs, TextInput } from "@/components/docs/kit";
import { ChatPlayground, type ChatPreset } from "@/components/docs/playgrounds/common/ChatPlayground";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Panel, SelectField } from "@/components/docs/playgrounds/muse-code/ui";
import { AVAILABILITY, execLine, installSteps, MUSE_MODELS, OS_OPTIONS, TASKS, taskCommand, type Os, type Task } from "@/components/docs/playgrounds/muse-code/start";

/**
 * The Muse Code overview's demo: install and first run per OS with copyable commands, what works differently on each
 * platform, a builder for the commands the page lists (interactive, headless, CI, sign-in, the session protocol), and
 * the same prompt sent straight to the model through the docs proxy, since Muse Code and the Model API run the same
 * model.
 */

export interface MuseCodeStartProps {
  slug: string;
  /** The headless prompt the builder starts with. */
  prompt?: string;
  /** Prompts for the "Ask the model" tab. */
  presets?: ChatPreset[];
  /** Instructions for the "Ask the model" tab. */
  system?: string;
}

type View = "install" | "build" | "live";

/** The reader's OS from the browser, once mounted. Apple silicon vs Intel can't be read reliably, so Macs start on Apple silicon. */
function detectOs(): Os | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent}`;
  if (/win/i.test(platform)) return "windows";
  if (/mac|iphone|ipad/i.test(platform)) return "macos-arm";
  if (/linux|x11|cros/i.test(platform)) return "linux";
  return null;
}

export function MuseCodeStart({ slug, prompt: startPrompt, presets, system }: MuseCodeStartProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("install");
  const [os, setOs] = useState<Os>("macos-arm");
  const [task, setTask] = useState<Task>("session");
  const [prompt, setPrompt] = useState(startPrompt ?? "Run the test suite and summarize failures.");
  const [model, setModel] = useState("");
  const [secret, setSecret] = useState("MUSE_KEY");
  const [live, setLive] = useState<{ key: number; prompt: string } | null>(null);

  useEffect(() => {
    const found = detectOs();
    if (found) setOs(found);
  }, []);

  const steps = installSteps(os);
  const out = taskCommand(task, { os, prompt, model, secret });
  const osLabel = OS_OPTIONS.find((o) => o.value === os)?.label ?? os;

  return (
    <div className="pg">
      <Tabs<View>
        label="Muse Code setup"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "install", label: "Install and first run" },
          { id: "build", label: "Build a command" },
          { id: "live", label: "Ask the model" },
        ]}
      />

      <Panel idBase={idBase} id="install" active={view === "install"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<Os> label="Your operating system" options={OS_OPTIONS} value={os} onChange={setOs} size="sm" />
          </div>
          <ol className={styles.steps} aria-label={`Install steps for ${osLabel}`}>
            {steps.map((s) => (
              <li key={s.title} className={styles.step}>
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>{s.title}</p>
                  <CodeBlock code={s.code} label={s.label} syntax={s.syntax} copyLabel={`Copy: ${s.title}`} />
                  {s.notes.length ? (
                    <ul className={`${styles.notes} pg-advanced`}>
                      {s.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="pg-advanced">
            <p className="pg-section-label">What differs by platform</p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    {OS_OPTIONS.map((o) => (
                      <th key={o.value} scope="col" className={o.value === os ? styles.colActive : undefined}>
                        {o.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {AVAILABILITY.map((a) => (
                    <tr key={a.feature}>
                      <th scope="row">
                        <a href={a.source}>{a.feature}</a>
                      </th>
                      {OS_OPTIONS.map((o) => (
                        <td key={o.value} className={o.value === os ? styles.colActive : undefined}>
                          {a.values[o.value]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      <Panel idBase={idBase} id="build" active={view === "build"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<Task> label="What do you want to do?" options={TASKS} value={task} onChange={setTask} size="sm" />
          </div>
          <div className={styles.row}>
            <SelectField<Os> id={`${idBase}-os`} label="Shell" className={styles.narrow} value={os} options={OS_OPTIONS} onChange={setOs} />
            {task === "session" || task === "headless" || task === "ci" ? (
              <SelectField id={`${idBase}-model`} label="--model" className={`${styles.narrow} pg-advanced`} value={model} options={MUSE_MODELS} onChange={setModel} />
            ) : null}
            {task === "ci" ? (
              <Field id={`${idBase}-secret`} label="CI secret that holds the key" className={`${styles.narrow} pg-advanced`}>
                <TextInput id={`${idBase}-secret`} value={secret} spellCheck={false} onChange={(e) => setSecret(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} />
              </Field>
            ) : null}
          </div>
          {task === "headless" || task === "ci" ? (
            <Field id={`${idBase}-prompt`} label="Prompt">
              <TextInput id={`${idBase}-prompt`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </Field>
          ) : null}
          <CodeBlock code={out.code} label={out.label} syntax={out.syntax} />
          <ul className={`${styles.notes} pg-advanced`} aria-live="polite">
            {out.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {task === "headless" || task === "ci" ? (
            <div className="pg-actions pg-advanced">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setLive((cur) => ({ key: (cur?.key ?? 0) + 1, prompt: prompt.trim() || "Run the test suite and summarize failures." }));
                  setView("live");
                }}
              >
                Send this prompt to the model directly
              </button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel idBase={idBase} id="live" active={view === "live"}>
        <div className="pg-col">
          <p className="pg-hint">
            Muse Code and the Model API run the same model. This sends your prompt straight to the API, with no tools and no
            workspace, so it answers from the prompt alone. In a project, <code className={styles.code}>{execLine(live?.prompt ?? prompt, os, model)}</code>{" "}
            runs it as an agent that reads, edits and runs commands.
          </p>
          <ChatPlayground
            key={live?.key ?? 0}
            slug={slug}
            prompt={live?.prompt ?? presets?.[0]?.prompt}
            presets={presets}
            system={system}
            effort="low"
            maxOutputTokens={900}
            multiTurn
          />
        </div>
      </Panel>
    </div>
  );
}
