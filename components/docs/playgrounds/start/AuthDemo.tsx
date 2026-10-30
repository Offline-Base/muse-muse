"use client";

import { Fragment, useId, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import {
  AUTH_CLIENTS,
  authSnippet,
  envSetup,
  KEY_SAFETY,
  RECORDED_401,
  SHELLS,
  type AuthClient,
  type Shell,
} from "@/components/docs/playgrounds/start/auth";
import { CodeBlock } from "@/components/docs/playgrounds/start/CodeBlock";
import { SectionTabs } from "@/components/docs/playgrounds/start/SectionTabs";
import { capWonder, WONDER_MODEL, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

type Call = "models" | "chat";

/**
 * The authentication page without ever asking for a key. "Call through a server" runs a real request the way the
 * page's safety rules want it: the browser sends no key, Muse Muse's server adds its own, and Meta answers. "Header
 * and environment" builds the Authorization header and the environment setup for each client and shell. "Missing or
 * bad key" shows the 401 the docs record, since the live demos can't send a keyless request to Meta.
 */
export function AuthDemo({ initial }: { slug: string; initial?: "server" | "builder" | "missing" }) {
  return (
    <SectionTabs
      label="Authentication"
      initial={initial}
      sections={[
        { id: "server", label: "Call through a server", content: <ServerCall /> },
        { id: "builder", label: "Header and environment", content: <HeaderBuilder /> },
        { id: "missing", label: "Missing or bad key", content: <MissingKey /> },
      ]}
    />
  );
}

function ServerCall() {
  const id = useId();
  const runner = useDocsRun();
  const [call, setCall] = useState<Call>("models");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";
  const path = call === "models" ? "models" : "chat/completions";
  const body = call === "chat" ? capWonder({ model, messages: [{ role: "user", content: "Hello" }] }, "max_completion_tokens") : undefined;
  const method = call === "models" ? "GET" : "POST";

  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        The page&apos;s rule: keep keys out of client code and send requests through a server you control. These docs work that way.
        Run a request and look at your browser&apos;s network tab: it carries no <code>Authorization</code> header.
      </p>
      <div className={styles.flow} role="group" aria-label="Where the key is added">
        <div className={styles.flowBox}>
          <span className={styles.flowName}>Your browser</span>
          <code>
            {method} <Breakable path={`/api/docs/v1/${path}`} />
          </code>
          <span className={`${styles.small} pg-advanced`}>No key, no Authorization header.</span>
        </div>
        <span className={styles.flowArrow} aria-hidden>
          →
        </span>
        <div className={styles.flowBox}>
          <span className={styles.flowName}>Muse Muse&apos;s server</span>
          <code>Authorization: Bearer ••••••••</code>
          <span className={`${styles.small} pg-advanced`}>Adds its own key from its environment, checks limits.</span>
        </div>
        <span className={styles.flowArrow} aria-hidden>
          →
        </span>
        <div className={styles.flowBox}>
          <span className={styles.flowName}>api.meta.ai</span>
          <code>
            {method} <Breakable path={`/v1/${path}`} />
          </code>
          <span className={`${styles.small} pg-advanced`}>Checks the bearer token, then answers.</span>
        </div>
      </div>
      <div className="pg-bar">
        <Segmented<Call>
          label="Request"
          options={[
            { value: "models", label: "List models (free)" },
            { value: "chat", label: "The page's chat request" },
          ]}
          value={call}
          onChange={setCall}
          disabled={running}
        />
        {call === "chat" ? <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} /> : null}
      </div>
      <div className="pg-actions">
        <RunButton running={running} onRun={() => void runner.run(path, { method, body })} onStop={runner.abort} />
        <span className="pg-hint">
          {method} /v1/{path}
          {call !== "chat"
            ? ", which costs nothing"
            : model === WONDER_MODEL
              ? `, "Hello" on Chat Completions: about a cent on Muse Wonder, capped at ${WONDER_OUTPUT_CAP} output tokens`
              : ', "Hello" on Chat Completions: fractions of a cent'}
        </span>
      </div>
      <ErrorBox error={runner.error} />
      <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} />
      {runner.result?.ok ? (
        <p className="pg-hint" role="status">
          Meta accepted the request with Muse Muse&apos;s key{runner.result.headers["x-request-id"] ? ` (request id ${runner.result.headers["x-request-id"]})` : ""}. Your
          own app does the same with its key on its server: the browser never holds it.
        </p>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method={method} path={path} body={body} caption="The same request with your own key, from your server" /> : null}
    </div>
  );
}

/** A path that wraps after its slashes rather than in the middle of a word. */
function Breakable({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i ? "/" : ""}
          {i ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function HeaderBuilder() {
  const id = useId();
  const [shell, setShell] = useState<Shell>("unix");
  const [client, setClient] = useState<AuthClient>("curl");
  const env = envSetup(shell);
  const syntax = AUTH_CLIENTS.find((c) => c.id === client)?.syntax ?? "bash";
  const code = authSnippet(client, shell, DEFAULT_TEXT_MODEL);
  return (
    <div className="pg">
      <div className="pg-advanced">
        <p className="pg-section-label">The key&apos;s shape</p>
        <p className={styles.keyAnatomy} role="img" aria-label="LLM_, then the numeric id, an underscore, and the secret">
          <span className={styles.keyPart}>
            LLM_<small>prefix</small>
          </span>
          <span className={styles.keyPart}>
            {"{id}"}
            <small>numeric id</small>
          </span>
          <span className={styles.keyPart}>
            _<small> </small>
          </span>
          <span className={styles.keyPart}>
            {"{secret}"}
            <small>shown once</small>
          </span>
        </p>
        <p className="pg-hint">
          Create keys in the Model API dashboard under API keys. You see a key once, so copy it right away. Never paste it into a
          web page, this one included.
        </p>
      </div>
      <div className="pg-bar">
        <Segmented<Shell> label="Shell" options={SHELLS.map((s) => ({ value: s.id, label: s.label }))} value={shell} onChange={setShell} size="sm" />
      </div>
      <CodeBlock label={shell === "unix" ? "bash" : shell === "powershell" ? "powershell" : "cmd"} code={env.code} syntax={env.syntax} caption="1. Put the key in the environment" copyLabel="Copy the environment setup" />
      <p className="pg-hint">{env.persist}</p>
      <div className="pg-bar">
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-client`}>
            Client
          </label>
          <span className="select-wrap">
            <select id={`${id}-client`} className="select pg-select" value={client} onChange={(e) => setClient(e.target.value as AuthClient)}>
              {AUTH_CLIENTS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </span>
        </span>
      </div>
      <CodeBlock
        label={AUTH_CLIENTS.find((c) => c.id === client)?.label ?? client}
        code={code}
        syntax={syntax}
        caption="2. Send it as a bearer token: Authorization: Bearer $MODEL_API_KEY"
        copyLabel="Copy the code"
      />
      <p className="pg-hint">
        None of the SDKs reads MODEL_API_KEY on its own (the OpenAI SDK looks for OPENAI_API_KEY, the Anthropic SDK for
        ANTHROPIC_API_KEY), so the code passes it explicitly. The model here is Muse Spark 1.3 Contributor: Meta may use what you send
        to train future models; drop -contributor for Standard mode.
      </p>
      <div className="pg-advanced">
        <p className="pg-section-label">Before you ship</p>
        <ol className={styles.items}>
          {KEY_SAFETY.map((k) => (
            <li key={k.title} className={styles.item}>
              <strong>{k.title}</strong>
              <span>{k.detail}</span>
            </li>
          ))}
        </ol>
        <p className="pg-hint">
          Keys on the same team share rate limits. To rotate one: create a new key, move your apps to it, then delete the old one.
        </p>
      </div>
    </div>
  );
}

function MissingKey() {
  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        Recorded from the error-handling page. The live docs can&apos;t send Meta a request without a key: the server always adds
        Muse Muse&apos;s, and if Meta ever refused it, the docs say so in their own words rather than pass the 401 on.
      </p>
      <CodeBlock label="bash" code={RECORDED_401.request} caption="A request with no Authorization header" copyLabel="Copy the request" />
      <section className="pg-response" aria-label="Recorded response">
        <div className="pg-response-head">
          <span className="pg-status pg-status-bad">
            <span className="pg-dot pg-dot-bad" aria-hidden />
            401 Unauthorized
          </span>
          <span className="pg-meta">Recorded example</span>
        </div>
        <JsonTree value={RECORDED_401.body} />
      </section>
      <ul className={`${styles.items} pg-advanced`}>
        <li className={styles.item}>
          <strong>Same answer for every key problem</strong>
          <span>
            A missing header, a malformed key (not <code>LLM_{"{id}"}_{"{secret}"}</code>), a typo, or a revoked or deleted key all return{" "}
            <code>type: authentication_error</code> with <code>code: invalid_api_key</code>.
          </span>
        </li>
        <li className={styles.item}>
          <strong>Fix</strong>
          <span>
            Send <code>Authorization: Bearer $MODEL_API_KEY</code>, check <code>echo $MODEL_API_KEY</code> matches a key in the
            dashboard, with no extra spaces or quotes. Don&apos;t retry a 401 unchanged.
          </span>
        </li>
        <li className={styles.item}>
          <strong>Watch the rate</strong>
          <span>A rising share of 401s can mean a leaked or revoked key is still in use somewhere: revoke and rotate.</span>
        </li>
      </ul>
    </div>
  );
}
