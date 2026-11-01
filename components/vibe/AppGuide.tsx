"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { LongText } from "@/components/train/LongText";
import { ExternalLink } from "@/components/ui";
import {
  INSTALL,
  LLAMA_APP_URL,
  LLAMA_SERVE_URL,
  REQUIREMENTS,
  TUNED_STOPS,
  checksumCommand,
  commandOs,
  downloadCommand,
  folderCommand,
  isRepoId,
  janLink,
  llamaAppLink,
  llamaServeCommands,
  lmStudioLink,
  lmsGetCommand,
  modelfile,
  ollamaCommands,
  writeModelfileCommand,
} from "@/components/vibe/apps";
import { Command, PasteBlock } from "@/components/vibe/Command";
import { Stuck } from "@/components/vibe/Stuck";
import type { LocalFile, LocalFiles } from "@/lib/train/local-files";
import { quantBaseOfFileName } from "@/lib/train/quant-targets";
import { TUNED_TEMPLATE } from "@/lib/train/tuned-template";
import { APP_NAMES, diskNeedGb, gbText, pickApps, type AppId, type DeviceKind } from "@/lib/vibe/device";
import { LLAMACPP_MIN_BUILD, OLLAMA_MIN_VERSION, type DiagnosticsOs, type StepId } from "@/lib/vibe/troubleshoot";

/** Held-out prompt 0 and how the tuned model answered it in its eval, for Say hello. */
export interface HelloExample {
  prompt: string;
  tuned: string;
  /** Its eval index, and how many held-out prompts there are. */
  index: number;
  total: number;
}

/** What the guide reads of the model's local files. */
export type GuideFiles = Pick<LocalFiles, "repo" | "commit" | "slug" | "systemLine" | "needsTunedTemplate">;

export interface AppGuideProps {
  kind: DeviceKind;
  /** The build to set up: the verdict's, or the one the person chose. */
  file: LocalFile;
  files: GuideFiles;
  hello: HelloExample | null;
  /** An NVIDIA card adds nvidia-smi to the diagnostics. */
  nvidia: boolean;
  /** The person ticked "I have at least N GB free". */
  diskOk: boolean;
  /** The app to open first, when it is one this computer is offered; else the computer's first app. */
  initialApp?: AppId;
  /** Where "Stuck?" says to write for help (DRIVE_CONTACT_EMAIL), or null. */
  help?: string | null;
}

interface GuideStep {
  id: string;
  /** Where the step's "Stuck?" opens the troubleshooting tree. */
  stuck: StepId;
  title: string;
  body: (next: () => void) => ReactNode;
}

interface Ctx {
  os: DiagnosticsOs;
  kind: DeviceKind;
  file: LocalFile;
  files: GuideFiles & { repo: string };
  hello: HelloExample | null;
  diskOk: boolean;
}

/** "Did it open?": a web page can't tell whether an app is installed, so the person says. No shows another way. */
function DidItOpen({ onYes, children }: { onYes: () => void; children: ReactNode }) {
  const [no, setNo] = useState(false);
  return (
    <div className="vibe-opened">
      <div className="vibe-actions">
        <span className="vibe-opened-q">Did it open?</span>
        <button type="button" className="btn btn-sm btn-outline" onClick={onYes}>
          Yes
        </button>
        <button type="button" className="btn btn-sm btn-outline" aria-expanded={no} onClick={() => setNo(true)}>
          No
        </button>
      </div>
      <div className="vibe-opened-no" hidden={!no}>
        {children}
      </div>
    </div>
  );
}

function NextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="btn btn-primary" onClick={onClick}>
      {children}
    </button>
  );
}

function DiskNote({ ctx }: { ctx: Ctx }) {
  if (ctx.diskOk) return null;
  return <p className="vibe-callout">Make sure the disk has {diskNeedGb(ctx.file)} GB free first: the file plus 5 GB.</p>;
}

function InstallStep(name: string, body: (next: () => void) => ReactNode): GuideStep {
  return { id: "install", stuck: "install", title: `Install ${name}`, body };
}

/** Say hello: the system message and held-out prompt 0 to paste, and the tuned answer to compare with. */
function helloStep(ctx: Ctx, lead: ReactNode, opts: { systemInModelfile?: boolean; extra?: ReactNode } = {}): GuideStep {
  const { files, hello } = ctx;
  return {
    id: "hello",
    stuck: "hello",
    title: "Say hello",
    body: (next) => (
      <>
        <p>{lead}</p>
        {opts.systemInModelfile ? null : (
          <PasteBlock title="System message, exactly" text={files.systemLine} label="Copy the system message" />
        )}
        {hello ? (
          <>
            <PasteBlock
              title={`Then this prompt, held out from training (${hello.index + 1} of ${hello.total})`}
              text={hello.prompt}
              label="Copy the prompt"
            />
            <div className="vibe-answer">
              <h4>How the tuned model answered it in its eval</h4>
              <LongText text={hello.tuned} />
            </div>
            <p className="train-help">
              Yours won&apos;t match word for word: the eval ran on Muse Muse&apos;s GPU, and this file is a smaller copy
              of the model. It should read the same way.
            </p>
          </>
        ) : null}
        {opts.extra}
        <div className="vibe-actions">
          <NextButton onClick={next}>It answered</NextButton>
        </div>
      </>
    ),
  };
}

function lmStudioSteps(ctx: Ctx): GuideStep[] {
  const { os, file, files } = ctx;
  const link = lmStudioLink(files.repo, file.name);
  const lms = lmsGetCommand(files.repo, file.level);
  const steps: GuideStep[] = [
    InstallStep("LM Studio", (next) => (
      <>
        <p>Download it from its official page and open it once. {REQUIREMENTS.lmstudio[os]}</p>
        <div className="vibe-actions">
          <ExternalLink className="btn btn-outline" href={INSTALL.lmstudio.url}>
            lmstudio.ai/download
          </ExternalLink>
          <NextButton onClick={next}>It&apos;s installed</NextButton>
        </div>
      </>
    )),
    {
      id: "get",
      stuck: "get",
      title: "Get the model",
      body: (next) => (
        <>
          <p>
            This opens LM Studio at the {file.level} build ({gbText(file.bytes)}). Download it there, then load it.
          </p>
          <DiskNote ctx={ctx} />
          {link ? (
            <div className="vibe-actions">
              <a className="btn btn-primary" href={link}>
                <Icon name="download" size={18} />
                Open in LM Studio
              </a>
            </div>
          ) : null}
          <DidItOpen onYes={next}>
            <p>
              Open LM Studio and go to Discover, the magnifying glass. Search for <code>{files.repo}</code>, pick the{" "}
              {file.level} file and download it.
            </p>
            {lms ? (
              <>
                <p className="train-help">If you already use LM Studio&apos;s lms tool in a terminal, this does the same:</p>
                <Command text={lms} label="Copy the lms command" />
              </>
            ) : null}
          </DidItOpen>
        </>
      ),
    },
  ];
  if (files.needsTunedTemplate) {
    steps.push({
      id: "template",
      stuck: "hello",
      title: "Give it the tuned template",
      body: (next) => (
        <>
          <p>
            This model needs one extra settings file, tuned.jinja, to answer in LM Studio. Open My Models, the gear next to
            the model, then Prompt Template. Choose Jinja, and paste all of tuned.jinja there in place of what it shows.
          </p>
          <PasteBlock title="tuned.jinja, the same file as in the model's repo" text={TUNED_TEMPLATE} label="Copy tuned.jinja" folded />
          <div className="vibe-actions">
            <NextButton onClick={next}>Done</NextButton>
          </div>
        </>
      ),
    });
  }
  steps.push(
    helloStep(
      ctx,
      "In a new chat, paste the system message into the System Prompt, and set Temperature to 0 and Reasoning Strength to low. Then send the prompt.",
    ),
  );
  return steps;
}

function llamaAppSteps(ctx: Ctx): GuideStep[] {
  const { file, files } = ctx;
  const link = llamaAppLink(files.repo, file.level);
  return [
    InstallStep("the Llama app", (next) => (
      <>
        <p>Install it with Homebrew, or download the .dmg from its releases page. It runs from the menu bar.</p>
        <Command text={INSTALL["llama-app"].command} label="Copy the install command" />
        <div className="vibe-actions">
          <ExternalLink className="btn btn-outline" href={INSTALL["llama-app"].url}>
            The .dmg on GitHub
          </ExternalLink>
          <NextButton onClick={next}>It&apos;s installed</NextButton>
        </div>
      </>
    )),
    {
      id: "get",
      stuck: "get",
      title: "Get the model",
      body: (next) => (
        <>
          <p>
            This asks the Llama app to install the {file.level} build ({gbText(file.bytes)}).
          </p>
          <DiskNote ctx={ctx} />
          {link ? (
            <div className="vibe-actions">
              <a className="btn btn-primary" href={link}>
                <Icon name="download" size={18} />
                Open in the Llama app
              </a>
            </div>
          ) : null}
          <DidItOpen onYes={next}>
            <p>Check that the Llama app is running: its icon is in the menu bar. Then press the button again.</p>
          </DidItOpen>
        </>
      ),
    },
    helloStep(
      ctx,
      <>
        Open <ExternalLink href={LLAMA_APP_URL}>{LLAMA_APP_URL}</ExternalLink>, the Llama app&apos;s chat. In its settings,
        paste the system message and set the temperature to 0, then send the prompt.
      </>,
    ),
  ];
}

function llamaCppSteps(ctx: Ctx): GuideStep[] {
  const { os, file, files } = ctx;
  const serve = llamaServeCommands(os, files, file.level) ?? [];
  return [
    InstallStep("llama.cpp", (next) => (
      <>
        <p>
          It needs build {LLAMACPP_MIN_BUILD} or later, which <code>llama --version</code> shows.
          {os === "linux" ? " Without Homebrew, take a build from its releases page." : ""}
        </p>
        <Command text={INSTALL.llamacpp.command[os]} label="Copy the install command" />
        <div className="vibe-actions">
          <ExternalLink className="btn btn-outline" href={INSTALL.llamacpp.url}>
            Release builds
          </ExternalLink>
          <NextButton onClick={next}>It&apos;s installed</NextButton>
        </div>
      </>
    )),
    {
      id: "get",
      stuck: "get",
      title: "Get the model and start it",
      body: (next) => (
        <>
          <p>
            Open {os === "windows" ? "PowerShell" : "Terminal"}.{" "}
            {files.needsTunedTemplate
              ? "Make a folder for it and go into it, then run the other two there. The first gets tuned.jinja, the extra settings file this model needs; the second downloads"
              : "This downloads"}{" "}
            the {file.level} build ({gbText(file.bytes)}) into the Hugging Face cache, then serves it at {LLAMA_SERVE_URL}.
            The first start takes a while.
          </p>
          <DiskNote ctx={ctx} />
          {files.needsTunedTemplate ? <Command text={folderCommand(files.slug)} label="Copy the folder command" /> : null}
          {serve.map((c) => (
            <Command key={c} text={c} label="Copy the command" />
          ))}
          <div className="vibe-actions">
            <NextButton onClick={next}>It&apos;s running</NextButton>
          </div>
        </>
      ),
    },
    helloStep(
      ctx,
      <>
        Open <ExternalLink href={LLAMA_SERVE_URL}>{LLAMA_SERVE_URL}</ExternalLink>, the chat that llama serve starts. In
        Settings, paste the system message and set the temperature to 0, then send the prompt.
      </>,
      files.needsTunedTemplate
        ? { extra: <p className="train-help">From its API, send {TUNED_STOPS} with each request too.</p> }
        : {},
    ),
  ];
}

function ollamaSteps(ctx: Ctx): GuideStep[] {
  const { os, file, files } = ctx;
  const download = downloadCommand(os, files, file.name);
  const check = checksumCommand(os, file.name);
  const text = modelfile(file, files.systemLine, files.needsTunedTemplate);
  const { create, run } = ollamaCommands(files.slug);
  return [
    InstallStep("Ollama", (next) => (
      <>
        <p>It needs version {OLLAMA_MIN_VERSION} or later, which <code>ollama --version</code> shows.</p>
        {os === "linux" ? <Command text={INSTALL.ollama.command.linux} label="Copy the install command" /> : null}
        <div className="vibe-actions">
          <ExternalLink className="btn btn-outline" href={INSTALL.ollama.url}>
            ollama.com/download
          </ExternalLink>
          <NextButton onClick={next}>It&apos;s installed</NextButton>
        </div>
      </>
    )),
    {
      id: "get",
      stuck: "get",
      title: "Get the model and make it",
      body: (next) => (
        <>
          <p>
            Open {os === "windows" ? "PowerShell" : "Terminal"}, make a folder for the model and go into it, then download
            the {file.level} build ({gbText(file.bytes)}) there. Don&apos;t use <code>ollama run hf.co/...</code> for this
            model: that import gives empty answers.
          </p>
          <DiskNote ctx={ctx} />
          <Command text={folderCommand(files.slug)} label="Copy the folder command" />
          {download ? <Command text={download} label="Copy the download command" /> : null}
          {check ? (
            <>
              <p>Check it: the sha256 should be <code className="vibe-sha">{file.sha256}</code>.</p>
              <Command text={check} label="Copy the check command" />
            </>
          ) : null}
          {text ? (
            os === "windows" ? (
              <>
                <p>
                  Open Notepad, paste this, and save it as Modelfile in the same folder, with Save as type set to All
                  files:
                </p>
                <Command text={text} label="Copy the Modelfile" />
              </>
            ) : (
              <>
                <p>Write its Modelfile next to it{files.needsTunedTemplate ? ", with the template this model needs" : ""}:</p>
                <Command text={writeModelfileCommand(text)} label="Copy the Modelfile command" />
              </>
            )
          ) : null}
          <p>Then make the model:</p>
          <Command text={create} label="Copy the create command" />
          <div className="vibe-actions">
            <NextButton onClick={next}>Done</NextButton>
          </div>
        </>
      ),
    },
    helloStep(
      ctx,
      "Run it, then paste the prompt. The Modelfile already holds the system message and a temperature of 0.",
      { systemInModelfile: true, extra: <Command text={run} label="Copy the run command" /> },
    ),
  ];
}

function janSteps(ctx: Ctx): GuideStep[] {
  const { os, file, files } = ctx;
  const link = janLink(files.repo);
  return [
    InstallStep("Jan", (next) => (
      <>
        <p>Download it from its official page. {REQUIREMENTS.jan[os] ?? ""}</p>
        <div className="vibe-actions">
          <ExternalLink className="btn btn-outline" href={INSTALL.jan.url}>
            jan.ai/download
          </ExternalLink>
          <NextButton onClick={next}>It&apos;s installed</NextButton>
        </div>
      </>
    )),
    {
      id: "get",
      stuck: "get",
      title: "Get the model",
      body: (next) => (
        <>
          <p>This opens the repo in Jan. Download the {file.level} file ({gbText(file.bytes)}) there.</p>
          <DiskNote ctx={ctx} />
          {link ? (
            <div className="vibe-actions">
              <a className="btn btn-primary" href={link}>
                <Icon name="download" size={18} />
                Open in Jan
              </a>
            </div>
          ) : null}
          <DidItOpen onYes={next}>
            <p>
              In Jan&apos;s Hub, search for <code>{files.repo}</code> and pick the {file.level} file.
            </p>
          </DidItOpen>
        </>
      ),
    },
    helloStep(ctx, "Start a thread with the model. Paste the system message into its instructions, set the temperature to 0, then send the prompt."),
  ];
}

const STEPS: Record<AppId, (ctx: Ctx) => GuideStep[]> = {
  lmstudio: lmStudioSteps,
  "llama-app": llamaAppSteps,
  llamacpp: llamaCppSteps,
  ollama: ollamaSteps,
  jan: janSteps,
};

/** A note above an app's steps: what isn't checked, or why another app suits this model better. */
function noteFor(app: AppId, ctx: Ctx): ReactNode {
  const small = quantBaseOfFileName(ctx.file.name);
  if (small) return <p className="vibe-callout">These steps haven&apos;t been tried with a {small.label} file yet. It has only run in llama.cpp on a test machine.</p>;
  if (app === "ollama" && ctx.kind === "mac-intel") {
    return <p className="vibe-callout">On an Intel Mac, Ollama runs only on the processor: expect a token a second or two, with 32 GB of memory or more.</p>;
  }
  if (app === "jan") {
    return (
      <p className="vibe-callout">
        Jan hasn&apos;t been checked with Muse Glimmer yet.
        {ctx.files.needsTunedTemplate ? " This model also needs tuned.jinja: LM Studio or llama.cpp is the tested way." : ""}
      </p>
    );
  }
  return null;
}

/** The Llama app takes no template from a link, and this model needs one: it sends people to the apps that do. */
function cantUse(app: AppId, ctx: Ctx): string | null {
  if (app === "llama-app" && ctx.files.needsTunedTemplate) {
    return "This model needs its tuned template, tuned.jinja, and the Llama app can't take one from a link yet. LM Studio, or llama.cpp on Other ways, runs it with the template.";
  }
  return null;
}

/**
 * The steps one at a time: only the current one is open, the ones before it are ticked and can be opened again. Every
 * step's body is in the page, hidden until it is current, so a step's links and commands are there the moment it opens.
 */
function Checklist({ steps, app, os, level, nvidia, help }: { steps: GuideStep[]; app: AppId; os: DiagnosticsOs; level: string; nvidia: boolean; help: string | null }) {
  const [current, setCurrent] = useState(0);
  return (
    <>
      <ol className="vibe-steps">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={s.id} className={`vibe-step vibe-step-${state}`}>
              <button type="button" className="vibe-step-head" aria-expanded={i === current} onClick={() => setCurrent(i)}>
                <span className="vibe-step-num" aria-hidden>
                  {state === "done" ? <Icon name="check" size={16} /> : i + 1}
                </span>
                <span className="vibe-step-title">{s.title}</span>
                {state === "done" ? <span className="sr-only"> (done)</span> : null}
              </button>
              <div className="vibe-step-body" hidden={i !== current}>
                {s.body(() => setCurrent(i + 1))}
                <Stuck step={s.stuck} app={app} os={os} level={level} nvidia={nvidia} help={help} />
              </div>
            </li>
          );
        })}
      </ol>
      {current >= steps.length ? (
        <p className="vibe-done" role="status">
          <Icon name="check" size={18} />
          It runs on your computer now. Check what it writes before you rely on it.
        </p>
      ) : null}
    </>
  );
}

/**
 * Get it running (docs/VIBE_TUNING.md, Feature 5): the app pre-picked for the computer as a tab, the rest on "Other
 * ways", and a checklist one step at a time (install, get the model, say hello), each with "Stuck?". Every link and
 * command is built from the repo and file names in components/vibe/apps.ts; a repo name the Hub wouldn't allow gets
 * no guide at all.
 */
export function AppGuide({ kind, file, files, hello, nvidia, diskOk, initialApp, help = null }: AppGuideProps) {
  const id = useId();
  const apps = pickApps(kind, files.needsTunedTemplate);
  const start = initialApp && apps.other.includes(initialApp) ? "other" : initialApp && apps.first.includes(initialApp) ? initialApp : null;
  const [tab, setTab] = useState<AppId | "other">(start ?? apps.first[0] ?? "other");
  const [other, setOther] = useState<AppId | null>(start === "other" ? initialApp! : (apps.other[0] ?? null));
  if (!isRepoId(files.repo) || (!apps.first.length && !apps.other.length)) return null;
  const app = tab === "other" ? other : tab;
  const ctx: Ctx = { os: commandOs(kind), kind, file, files: { ...files, repo: files.repo }, hello, diskOk };
  const blocked = app ? cantUse(app, ctx) : null;

  const tabButton = (key: AppId | "other", label: string) => (
    <button
      key={key}
      type="button"
      role="tab"
      className="tab"
      aria-selected={tab === key}
      aria-controls={`${id}-panel`}
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  );

  return (
    <section className="card section-card vibe-guide" aria-labelledby={`${id}-title`}>
      <div className="vibe-card-head">
        <h2 id={`${id}-title`}>Get it running</h2>
        <div className="tabs" role="tablist" aria-label="App">
          {apps.first.map((a) => tabButton(a, APP_NAMES[a]))}
          {apps.other.length ? tabButton("other", "Other ways") : null}
        </div>
      </div>
      <div className="vibe-guide-panel" id={`${id}-panel`} role="tabpanel">
        {tab === "other" && apps.other.length > 1 ? (
          <div className="tabs" role="tablist" aria-label="Other ways">
            {apps.other.map((a) => (
              <button key={a} type="button" role="tab" className="tab" aria-selected={other === a} onClick={() => setOther(a)}>
                {APP_NAMES[a]}
              </button>
            ))}
          </div>
        ) : null}
        {app ? noteFor(app, ctx) : null}
        {blocked ? <p className="vibe-callout">{blocked}</p> : null}
        {app && !blocked ? (
          <Checklist key={`${app}:${file.level}`} steps={STEPS[app](ctx)} app={app} os={ctx.os} level={file.level} nvidia={nvidia} help={help} />
        ) : null}
      </div>
    </section>
  );
}
