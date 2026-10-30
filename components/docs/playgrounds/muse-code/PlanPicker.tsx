"use client";

import { useEffect, useId, useState } from "react";
import { Field, Segmented, Tabs } from "@/components/docs/kit";
import { formatUsd } from "@/lib/docs/client/cost";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import {
  contributorMode,
  dayBefore,
  formatYmd,
  parseYmd,
  PAYG_MODELS,
  paygEstimate,
  PLANS,
  promptRange,
  recommendPlan,
  renewals,
  toIsoYmd,
  type Billing,
  type EnvValue,
  type FlagValue,
  type Saved,
  type Surface,
  type Weight,
  type Ymd,
} from "@/components/docs/playgrounds/muse-code/subscriptions";
import { C, Check, Chip, Notes, NumberField, Panel, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The subscriptions page's demo: pick a plan from expected usage and the features you need (the page's four plans and
 * their multiples of the Everyday plan's 10-50 prompts every 5 hours), a rough pay-as-you-go comparison at the API's
 * token prices, whether a run will be in Contributor mode by the page's rules, and the renewal dates its billing-cycle
 * rule gives. Plan prices are shown at checkout and aren't on the page, so nothing here invents one.
 */

export interface PlanPickerProps {
  slug: string;
  /** Prompts in a busy 5-hour window, to start with. */
  prompts?: number;
  /** The first-subscribed date the billing tab starts with (YYYY-MM-DD). */
  subscribed?: string;
}

type View = "plan" | "contributor" | "billing";

const WEIGHTS: ReadonlyArray<{ value: Weight; label: string }> = [
  { value: "light", label: "Light prompts" },
  { value: "mixed", label: "Mixed" },
  { value: "heavy", label: "Heavy (images, video, long context)" },
];

const FIT_CHIP = {
  fits: { tone: "ok" as const, text: "Covers it" },
  short: { tone: "warn" as const, text: "Too little usage" },
  missing: { tone: "plain" as const, text: "Missing a feature you need" },
};

export function PlanPicker({ prompts: startPrompts, subscribed }: PlanPickerProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("plan");

  const [prompts, setPrompts] = useState<number | null>(startPrompts ?? 30);
  const [weight, setWeight] = useState<Weight>("mixed");
  const [wonderFull, setWonderFull] = useState(false);
  const [earlyAccess, setEarlyAccess] = useState(false);
  const [higherUploads, setHigherUploads] = useState(false);

  const [model, setModel] = useState<string>("muse-spark-1.2");
  const [perDay, setPerDay] = useState<number | null>(40);
  const [days, setDays] = useState<number | null>(21);
  const [inputTokens, setInputTokens] = useState<number | null>(200_000);
  const [cachedPct, setCachedPct] = useState<number | null>(80);
  const [outputTokens, setOutputTokens] = useState<number | null>(4_000);

  const [billing, setBilling] = useState<Billing>("subscription");
  const [surface, setSurface] = useState<Surface>("headless");
  const [flag, setFlag] = useState<FlagValue>("none");
  const [env, setEnv] = useState<EnvValue>("unset");
  const [saved, setSaved] = useState<Saved>("never");

  const [start, setStart] = useState(subscribed ?? "2026-01-31");
  // The table lists the charges still to come, so it counts from today: read once mounted, so the server render and
  // the first client render agree (until then it counts from the first-subscribed date).
  const [today, setToday] = useState<Ymd | null>(null);
  useEffect(() => {
    const now = new Date();
    setToday({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
  }, []);

  const rec = recommendPlan({ prompts: prompts ?? 0, weight, wonderFull, earlyAccess, higherUploads });
  const payg = paygEstimate({
    model,
    promptsPerDay: perDay ?? 0,
    daysPerMonth: days ?? 0,
    inputTokens: inputTokens ?? 0,
    cachedShare: (cachedPct ?? 0) / 100,
    outputTokens: outputTokens ?? 0,
  });
  const contributor = contributorMode({ billing, surface, flag, env, saved });
  const startDate = parseYmd(start);
  const dates = startDate ? renewals(startDate, today ?? startDate, 12) : [];

  return (
    <div className="pg">
      <Tabs<View>
        label="Subscriptions"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "plan", label: "Pick a plan" },
          { id: "contributor", label: "Contributor mode for a run" },
          { id: "billing", label: "Billing dates" },
        ]}
      />

      <Panel idBase={idBase} id="plan" active={view === "plan"}>
        <div className="pg-col">
          <div className={styles.row}>
            <NumberField id={`${idBase}-prompts`} label="Prompts in a busy 5-hour window" value={prompts} min={0} onChange={setPrompts} />
            <div className="pg-field">
              <span className="pg-label">Your prompts are</span>
              <Segmented<Weight> label="Prompt size" size="sm" value={weight} onChange={setWeight} options={WEIGHTS} />
            </div>
          </div>
          <fieldset className={`${styles.fieldset} pg-advanced`}>
            <legend>You need</legend>
            <div className={styles.checkGrid}>
              <Check id={`${idBase}-wf`} label="Muse Wonder Full" checked={wonderFull} onChange={setWonderFull} />
              <Check id={`${idBase}-ea`} label="Early access to new features" checked={earlyAccess} onChange={setEarlyAccess} />
              <Check id={`${idBase}-hu`} label="Higher file uploads" checked={higherUploads} onChange={setHigherUploads} />
            </div>
          </fieldset>

          <div className={`${styles.card} ${styles.cardMuted}`} role="status" aria-live="polite">
            <p className={styles.big}>{rec.overMax ? "Maximum Usage, and it may still run out" : `${rec.plan.name} fits`}</p>
            <Notes items={rec.reasons} />
          </div>

          <ul className={`${styles.gridPairs} ${styles.plainList}`} aria-label="Plans">
            {PLANS.map((p) => {
              const fit = FIT_CHIP[rec.fits[p.id]];
              const range = promptRange(p);
              const picked = p.id === rec.plan.id;
              return (
                <li key={p.id} className={`${styles.card}${picked ? ` ${styles.cardPicked}` : ""}`}>
                  <div className={styles.cardHead}>
                    <p className={styles.cardTitle}>{p.name}</p>
                    {picked ? <Chip tone="accent">Suggested</Chip> : null}
                  </div>
                  <div className="pg-small pg-muted">
                    About {range.low.toLocaleString("en-US")}-{range.high.toLocaleString("en-US")} prompts every 5 hours ({p.multiplier}x Everyday)
                  </div>
                  <Chip tone={fit.tone}>{fit.text}</Chip>
                  <ul className={`${styles.notes} pg-advanced`}>
                    {p.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <p className="pg-hint">
            The ranges multiply the Everyday plan&apos;s 10-50 prompts by each plan&apos;s multiple. Meta counts usage, not prompts, and
            Contributor mode (the default) gives more usage than these figures by an amount the page doesn&apos;t state. Benefits can vary by region;
            onboarding shows yours before you subscribe.
          </p>

          <details className="pg-system">
            <summary>Compare with pay-as-you-go</summary>
            <div className="pg-col">
              <div className={styles.row}>
                <SelectField id={`${idBase}-model`} label="Price at" className={styles.grow} value={model} onChange={setModel} options={PAYG_MODELS.map((m) => ({ value: m.value, label: m.label }))} />
                <NumberField id={`${idBase}-perday`} label="Prompts a day" value={perDay} min={0} onChange={setPerDay} />
                <NumberField id={`${idBase}-days`} label="Days a month" value={days} min={0} max={31} onChange={setDays} />
              </div>
              <div className={styles.row}>
                <NumberField id={`${idBase}-in`} label="Input tokens per prompt" value={inputTokens} min={0} step={1000} onChange={setInputTokens} hint="All model steps of one prompt, which each resend the context." />
                <NumberField id={`${idBase}-cached`} label="Cached share (%)" value={cachedPct} min={0} max={100} onChange={setCachedPct} />
                <NumberField id={`${idBase}-out`} label="Output tokens per prompt" value={outputTokens} min={0} step={500} onChange={setOutputTokens} />
              </div>
              <p className={styles.big} role="status">
                About {formatUsd(payg.perPrompt)} a prompt, {formatUsd(payg.perMonth)} a month for {payg.promptsPerMonth.toLocaleString("en-US")} prompts
              </p>
              <p className="pg-hint">
                Pay-as-you-go bills each request&apos;s input and output tokens to your Meta Model API key, at the rates on the pricing page. This is a rough
                estimate from your assumptions: compare it with the plan price Accounts Center shows at checkout.
              </p>
            </div>
          </details>
        </div>
      </Panel>

      <Panel idBase={idBase} id="contributor" active={view === "contributor"}>
        <div className="pg-col">
          <div className={styles.row}>
            <SelectField<Billing>
              id={`${idBase}-billing`}
              label="Billing"
              value={billing}
              onChange={setBilling}
              options={[
                { value: "subscription", label: "Muse Code subscription" },
                { value: "payg", label: "Pay-as-you-go" },
                { value: "zdr", label: "Zero Data Retention account" },
                { value: "managed", label: "Managed by my organization" },
              ]}
            />
            <div className="pg-field">
              <span className="pg-label">Run</span>
              <Segmented<Surface>
                label="Run kind"
                size="sm"
                value={surface}
                onChange={setSurface}
                options={[
                  { value: "interactive", label: "muse" },
                  { value: "headless", label: "muse exec" },
                ]}
              />
            </div>
          </div>
          <div className={`${styles.row} pg-advanced`}>
            <SelectField<FlagValue>
              id={`${idBase}-flag`}
              label="--contributor-mode"
              className={styles.narrow}
              value={flag}
              onChange={setFlag}
              options={[
                { value: "none", label: "Not passed" },
                { value: "on", label: "on" },
                { value: "off", label: "off" },
              ]}
            />
            <SelectField<EnvValue>
              id={`${idBase}-env`}
              label="MUSE_CONTRIBUTOR_MODE"
              className={styles.narrow}
              value={env}
              onChange={setEnv}
              options={[
                { value: "unset", label: "Not set" },
                { value: "1", label: "1 (on)" },
                { value: "0", label: "0 (off)" },
              ]}
            />
            <SelectField<Saved>
              id={`${idBase}-saved`}
              label="Saved setting on this computer"
              className={styles.grow}
              value={saved}
              onChange={setSaved}
              options={[
                { value: "on", label: "Saved on" },
                { value: "off", label: "Saved off" },
                { value: "never", label: "Settings file exists, never saved" },
                { value: "nofile", label: "No settings file (new computer)" },
              ]}
            />
          </div>
          <div
            className={`${styles.verdict} ${contributor.state === "on" ? styles.verdictWarn : contributor.state === "off" ? styles.verdictOk : contributor.state === "maybe" ? styles.verdictWarn : ""}`}
            role="status"
            aria-live="polite"
          >
            <p className={styles.big}>{contributor.headline}</p>
            <Notes items={contributor.reasons} />
            {contributor.row ? (
              <p className="pg-small">
                /settings, Model, Contributor mode row shows: <strong>{contributor.row}</strong>
              </p>
            ) : null}
          </div>
          {contributor.state === "on" || contributor.state === "maybe" ? (
            <p className="pg-hint">In Contributor mode you get more usage from your plan in exchange for letting Meta use your content to train future Meta models.</p>
          ) : null}
          {contributor.pin ? <CodeBlock code={contributor.pin} label="Pin it for runs like this" /> : null}
          <p className="pg-hint">
            To switch it in a session: type <C>/settings</C>, select the <strong>Contributor mode</strong> row under <strong>Model</strong>, and press Enter. It
            applies from your next request and is saved on this computer only.
          </p>
        </div>
      </Panel>

      <Panel idBase={idBase} id="billing" active={view === "billing"}>
        <div className="pg-col">
          <Field id={`${idBase}-start`} label="First subscribed on" hint="Try the 31st to see the last-day rule.">
            <input id={`${idBase}-start`} type="date" className={`pg-input ${styles.inlineInput}`} value={start} onChange={(e) => setStart(e.target.value)} aria-describedby={`${idBase}-start-hint`} />
          </Field>
          {startDate ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">
                  The next 12 charges{today ? ` after today, ${formatYmd(today)},` : ""} for a subscription started {formatYmd(startDate)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{today ? "Next renewals, from today" : "Renews and charges on"}</th>
                    <th scope="col">To avoid it, cancel by</th>
                  </tr>
                </thead>
                <tbody>
                  {dates.map((d) => (
                    <tr key={toIsoYmd(d)}>
                      <td>
                        {formatYmd(d)}
                        {d.d !== startDate.d ? <span className="pg-muted pg-small"> (last day of the month)</span> : null}
                      </td>
                      <td>{formatYmd(dayBefore(d))}, 24 hours before</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="pg-hint pg-bad" role="status">
              Enter a date as YYYY-MM-DD.
            </div>
          )}
          <div className={`${styles.gridPairs} pg-advanced`}>
            <div className={styles.card}>
              <p className={styles.cardTitle}>Upgrade</p>
              <p className="pg-small">Takes effect immediately. You&apos;re charged a prorated amount for the rest of the current billing cycle.</p>
            </div>
            <div className={styles.card}>
              <p className={styles.cardTitle}>Downgrade</p>
              <p className="pg-small">Takes effect at the start of your next billing cycle. You keep your current plan&apos;s usage limit until then.</p>
            </div>
            <div className={styles.card}>
              <p className={styles.cardTitle}>Cancel</p>
              <p className="pg-small">Stays active until the end of the current cycle, then all benefits end. No credit or refund unless the law requires one.</p>
            </div>
            <div className={styles.card}>
              <p className={styles.cardTitle}>Revoked</p>
              <p className="pg-small">Access ends immediately, not at the end of the cycle: payment failure, a policy violation, account deletion, or lost eligibility.</p>
            </div>
          </div>
          <p className="pg-hint">
            Manage the plan from <strong>Manage your subscription</strong> in Accounts Center, or type <C>/upgrade</C> in a session to open it.
          </p>
        </div>
      </Panel>
    </div>
  );
}
