"use client";

import { useId, useState } from "react";
import { Field, Segmented, Tabs, TextInput, Toggle } from "@/components/docs/kit";
import { resolveCredential, logout, type Account, type CredentialState } from "@/components/docs/playgrounds/muse-code/auth";
import { CI_PLATFORMS, ciConfig, cleanSecretName, POSTURES, type CiPlatform, type ContributorPin, type Posture, type Trigger } from "@/components/docs/playgrounds/muse-code/ci";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { C, Check, Chip, Notes, NumberField, Panel, Problems, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The auth page's demo: which credential Muse Code picks from what's set (META_API_KEY, then a stored key, then a
 * browser session), what `muse logout` leaves behind, and a CI setup that reads the key from the pipeline's secret
 * store. It never asks for a key: the builder only names the secret that holds one.
 */

export interface AuthSetupProps {
  slug: string;
  /** The CI secret name the builder starts with (the page's example uses MUSE_KEY). */
  secret?: string;
  prompt?: string;
}

type View = "resolve" | "ci";

const START: CredentialState = { account: "personal", envKey: false, storedKey: false, browserSession: true };

export function AuthSetup({ secret: startSecret, prompt: startPrompt }: AuthSetupProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("resolve");
  const [cred, setCred] = useState<CredentialState>(START);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);

  const [platform, setPlatform] = useState<CiPlatform>("github");
  const [trigger, setTrigger] = useState<Trigger>("manual");
  const [secret, setSecret] = useState(startSecret ?? "MUSE_KEY");
  const [prompt, setPrompt] = useState(startPrompt ?? "Run the test suite and summarize failures.");
  const [posture, setPosture] = useState<Posture>("disable-approval");
  const [maxSteps, setMaxSteps] = useState<number | null>(40);
  const [json, setJson] = useState(false);
  const [contributor, setContributor] = useState<ContributorPin>("off");
  const [verify, setVerify] = useState("npm test");

  const res = resolveCredential(cred);
  const set = (patch: Partial<CredentialState>) => {
    setCred((c) => ({ ...c, ...patch }));
    setLogoutMessage(null);
  };
  const ci = ciConfig({ platform, secret, prompt, posture, maxSteps, json, contributor, verify, trigger });

  return (
    <div className="pg">
      <Tabs<View>
        label="Authentication"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "resolve", label: "Which credential wins" },
          { id: "ci", label: "Set up CI" },
        ]}
      />

      <Panel idBase={idBase} id="resolve" active={view === "resolve"}>
        <div className="pg-col">
          <div className="pg-bar pg-advanced">
            <Segmented<Account>
              label="Account type"
              size="sm"
              value={cred.account}
              onChange={(account) => set({ account })}
              options={[
                { value: "personal", label: "Meta account" },
                { value: "mma", label: "Meta Managed Account (MMA)" },
              ]}
            />
          </div>
          <fieldset className={styles.fieldset}>
            <legend>What's set on this machine</legend>
            <div className={styles.checkGrid}>
              <Check id={`${idBase}-env`} label={<>META_API_KEY is exported</>} checked={cred.envKey} onChange={(envKey) => set({ envKey })} />
              <Check id={`${idBase}-stored`} label={<>A key stored with muse auth set</>} checked={cred.storedKey} onChange={(storedKey) => set({ storedKey })} />
              <Check
                id={`${idBase}-browser`}
                label={<>A browser sign-in{cred.account === "mma" ? " (not for MMA)" : ""}</>}
                checked={cred.account === "mma" ? false : cred.browserSession}
                disabled={cred.account === "mma"}
                onChange={(browserSession) => set({ browserSession })}
              />
            </div>
          </fieldset>

          <div className={`${styles.card} ${styles.cardMuted}`}>
            <p className={styles.big} role="status" aria-live="polite">
              {res.summary}
            </p>
            <ol className={styles.list} aria-label="Lookup order">
              {res.order.map((o, i) => (
                <li key={o.id}>
                  <div className={styles.itemHead}>
                    <span className="pg-muted pg-small">{i + 1}.</span>
                    <span>{o.label}</span>
                    {o.used ? <Chip tone="ok">Used</Chip> : o.present ? <Chip tone="plain">Set, but outranked</Chip> : <Chip tone="plain">Not set</Chip>}
                    {o.note ? <span className="pg-hint">{o.note}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
            <Notes items={res.notes} />
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                const out = logout(cred);
                setCred(out.state);
                setLogoutMessage(out.message);
              }}
            >
              Run muse logout
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm pg-advanced"
              onClick={() => {
                setCred(START);
                setLogoutMessage(null);
              }}
            >
              Reset
            </button>
          </div>
          {logoutMessage ? (
            <div className="pg-hint" role="status">
              {logoutMessage}
            </div>
          ) : null}

          <CodeBlock
            className="pg-advanced"
            label="bash"
            code={[
              '# Use an API key instead of the browser flow (an API key always wins):',
              'export META_API_KEY="<your-key>"',
              "# Or store one for Muse Code:",
              "muse auth set",
              "# Inside a session, reopen the sign-in options:",
              "/login",
              "# Remove what Muse Code stored (an exported META_API_KEY stays):",
              "muse logout",
            ].join("\n")}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="ci" active={view === "ci"}>
        <div className="pg-col">
          <div className="pg-bar">
            <Segmented<CiPlatform> label="CI system" size="sm" value={platform} onChange={setPlatform} options={CI_PLATFORMS} />
          </div>
          <div className={styles.row}>
            <Field id={`${idBase}-secret`} label="Secret that holds the key" className={styles.narrow} hint="Its name only. Store the key in your CI's secret settings.">
              <TextInput id={`${idBase}-secret`} value={secret} spellCheck={false} onChange={(e) => setSecret(e.target.value)} onBlur={() => setSecret(cleanSecretName(secret))} aria-describedby={`${idBase}-secret-hint`} />
            </Field>
            {platform !== "shell" ? (
              <SelectField<Trigger>
                id={`${idBase}-trigger`}
                label="Runs on"
                className={`${styles.narrow} pg-advanced`}
                value={trigger}
                onChange={setTrigger}
                options={[
                  { value: "manual", label: "Manual runs" },
                  { value: "pull_request", label: platform === "gitlab" ? "Merge requests" : "Pull requests" },
                ]}
              />
            ) : null}
            <SelectField<Posture> id={`${idBase}-posture`} label="Approvals" className={`${styles.grow} pg-advanced`} value={posture} onChange={setPosture} options={POSTURES} />
          </div>
          <Field id={`${idBase}-prompt`} label="Prompt">
            <TextInput id={`${idBase}-prompt`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          <div className={`${styles.row} pg-advanced`}>
            <NumberField id={`${idBase}-steps`} label="--max-model-steps" value={maxSteps} min={1} onChange={setMaxSteps} />
            <SelectField<ContributorPin>
              id={`${idBase}-contrib`}
              label="--contributor-mode"
              value={contributor}
              onChange={setContributor}
              options={[
                { value: "off", label: "off" },
                { value: "on", label: "on" },
                { value: "saved", label: "Saved setting" },
              ]}
            />
            <Field id={`${idBase}-verify`} label="Then check with" className={styles.narrow}>
              <TextInput id={`${idBase}-verify`} value={verify} spellCheck={false} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" />
            </Field>
          </div>
          <div className="pg-advanced">
            <Toggle id={`${idBase}-json`} label="--json (JSONL events on stdout)" checked={json} onChange={setJson} />
          </div>
          <CodeBlock code={ci.code} label={ci.label} syntax={ci.syntax} />
          <Problems warnings={ci.warnings} ok="This run can finish unattended." />
          <p className="pg-hint">
            Contributor mode is a subscription setting: pin it on every headless run with <C>--contributor-mode</C> (or{" "}
            <C>MUSE_CONTRIBUTOR_MODE=0</C>), since saved settings differ from machine to machine.
          </p>
        </div>
      </Panel>
    </div>
  );
}
