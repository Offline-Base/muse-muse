import Link from "next/link";
import { Icon } from "@/components/icons";
import { TryLiveCard } from "@/components/train/LiveDemo";
import { SparkOpenNote } from "@/components/train/SparkOpenNote";
import type { PublicLiveDemo } from "@/components/train/results";
import { EmptyCard, ExternalLink, PageHeader } from "@/components/ui";
import type { HelloExample } from "@/components/vibe/AppGuide";
import { hubRepoUrl, isRepoId, toPageFiles } from "@/components/vibe/apps";
import { LocalGuide } from "@/components/vibe/LocalGuide";
import { licenseDuties } from "@/lib/train/base";
import type { LocalFiles } from "@/lib/train/local-files";
import { quantBaseOf } from "@/lib/train/quant-targets";
import { GLIMMER_ORIGIN, HUB_SITE } from "@/lib/train/hub-cards";
import { buildMinimum, buildsText, gbText, minimumSpec, needGb, type MinimumSpec } from "@/lib/vibe/device";

/** The base model's Usage Policy, as the cards link it. */
export const USAGE_POLICY_URL = `${HUB_SITE}/${GLIMMER_ORIGIN}/blob/main/USAGE_POLICY.md`;

export interface RunLocallyProps {
  /** The trained glimmer-lora job: the model's own page is /fine-tuning/{jobId}. */
  jobId: string;
  title: string;
  /** localFilesFor's answer, or null when no files are made yet. */
  files: LocalFiles | null;
  /** Admins see the guide for files that aren't public yet, for a private test. Everyone else sees that they aren't. */
  showPrivate: boolean;
  hello: HelloExample | null;
  /** A live demo of the adapter while one is starting or serving (the Try it live box), else null. */
  live: PublicLiveDemo | null;
  /** The flash drive request for this model while drives are on and it can go on one (Feature 6), else null. */
  driveHref: string | null;
  /** Where "Stuck?" says to write for help (DRIVE_CONTACT_EMAIL), or null. */
  help?: string | null;
  serverNow: number;
}

/** Files the guide may use: made, published to a repo, with at least one build, and public unless an admin looks. */
function usableFiles(files: LocalFiles | null, showPrivate: boolean): LocalFiles | null {
  if (!files || !isRepoId(files.repo) || !files.files.length) return null;
  return files.public || showPrivate ? files : null;
}

/** "a Mac with 24 GB, a 16 GB graphics card, or 32 GB of RAM": the least any computer needs for the smallest build. */
function needsAtLeast(min: MinimumSpec): string {
  const parts = [min.macGb ? `a Mac with ${min.macGb} GB` : null, min.vramGb ? `a ${min.vramGb} GB graphics card` : null, min.ramGb ? `${min.ramGb} GB of RAM` : null].filter(Boolean);
  if (!parts.length) return "more memory than most computers have";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}

/** "a Mac with 24 GB, or a 16 GB graphics card": the least one build needs. */
function needsText(file: LocalFiles["files"][number]): string {
  const min = buildMinimum(file);
  const parts = [min.macGb ? `a Mac with ${min.macGb} GB` : null, min.vramGb ? `a ${min.vramGb} GB graphics card` : null];
  return parts.filter(Boolean).join(", or ") || "more than any Mac or card here";
}

/**
 * Which file for my computer: every build with its size, the memory it takes and the least it needs, and checksums. A
 * table on wide screens and the same facts as a list on a phone, where the table's last column would sit off screen.
 */
function BuildsTable({ files }: { files: LocalFiles }) {
  return (
    <section className="card section-card vibe-files" aria-labelledby="vibe-files-title">
      <div className="vibe-card-head">
        <h2 id="vibe-files-title">Which file for my computer</h2>
        {files.public && files.repo ? <ExternalLink href={hubRepoUrl(files.repo)}>All files on Hugging Face</ExternalLink> : null}
      </div>
      <dl className="kv vibe-files-list">
        {files.files.map((f) => (
          <div key={f.level}>
            <dt>{f.level}</dt>
            <dd>
              {gbText(f.bytes)} file, about {Math.round(needGb(f))} GB to run. Needs at least {needsText(f)}.
            </dd>
          </div>
        ))}
      </dl>
      <div className="table-wrap vibe-files-table">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Build</th>
              <th scope="col" className="num">
                File
              </th>
              <th scope="col" className="num">
                Memory to run
              </th>
              <th scope="col">Needs at least</th>
            </tr>
          </thead>
          <tbody>
            {files.files.map((f) => (
              <tr key={f.level}>
                <th scope="row">{f.level}</th>
                <td className="num">{gbText(f.bytes)}</td>
                <td className="num">about {Math.round(needGb(f))} GB</td>
                <td>{needsText(f)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="train-help">
        Memory to run is at an 8K context: the file, its cache and its buffers. A Mac lets its GPU use about two thirds of
        its memory up to 36 GB, and three quarters above that.
      </p>
      <details className="vibe-sums">
        <summary>Files and checksums (sha256)</summary>
        <ul>
          {files.files.map((f) => (
            <li key={f.level}>
              <code>{f.name}</code>
              <code className="vibe-sha">{f.sha256}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * Run it on your computer (docs/VIBE_TUNING.md, Feature 5), the page at /fine-tuning/{jobId}/run. The header gives the
 * file sizes, the least memory and the under-18 notice; Try it live comes first while a live demo runs; then the picker,
 * the verdict and the guide (LocalGuide, in the browser), and the table of builds. Until localFilesFor finds files it
 * says plainly that they aren't made yet. A server component: it sends the browser only the file list, the system
 * message and one held-out example.
 */
export function RunLocally({ jobId, title, files, showPrivate, hello, live, driveHref, help = null, serverNow }: RunLocallyProps) {
  const modelHref = `/fine-tuning/${jobId}`;
  const usable = usableFiles(files, showPrivate);
  const min = usable ? minimumSpec(usable.files) : null;
  const notPublic = Boolean(files && files.repo && files.files.length && !files.public);
  // A small base's files (QUANT_TARGETS) aren't Muse Glimmer, and its license and policy are Llama's.
  const small = quantBaseOf({ quantBase: files?.quantBase ?? undefined });
  const duties = small ? licenseDuties({ adapterBase: small.model }) : null;
  const modelWords = small ? `the tuned ${small.label}` : `the tuned Muse Glimmer 30B${files?.sparkOpen ? " with 2026 knowledge" : ""}`;

  return (
    <div className="page vibe-run">
      <PageHeader
        title="Run it on your computer"
        subtitle={
          usable && min
            ? `${title}, ${modelWords}, in ${buildsText(usable.files)}. It needs ${needsAtLeast(min)}.`
            : `${title}, ${modelWords}.`
        }
        actions={
          <Link className="btn btn-outline" href={modelHref}>
            <Icon name="chevronLeft" size={18} />
            The model
          </Link>
        }
      />

      {/* The Muse Model License's line, for files merged into r30b (lib/train/base.ts). Its repo and drives carry the files. */}
      {files?.sparkOpen ? <SparkOpenNote /> : null}

      <div className="vibe-note">
        {usable && min ? (
          <p>
            <Icon name="monitor" size={16} />
            <span>
              It runs on a Mac with Apple silicon and {min.macGb} GB or more, or on a PC with a {min.vramGb} GB graphics
              card{min.ramGb ? `, or slowly with ${min.ramGb} GB of RAM` : ""}. {small ? "It hasn't been run on a phone or tablet yet." : "Phones, tablets and Chromebooks can't run it."}
            </span>
          </p>
        ) : null}
        <p>
          <Icon name="info" size={16} />
          {duties ? (
            <span>
              <strong>{duties.line}.</strong> {duties.license} Its repo carries both.
            </span>
          ) : (
            <span>
              Meta&apos;s Usage Policy says Muse Glimmer 30B &quot;is not intended for individuals under the age of 18&quot;.{" "}
              <ExternalLink href={USAGE_POLICY_URL}>The Usage Policy</ExternalLink>
            </span>
          )}
        </p>
      </div>

      {live ? <TryLiveCard adapterJobId={jobId} demo={live} serverNow={serverNow} /> : null}

      {usable ? (
        <>
          {!usable.public ? (
            <section className="card notice" role="status">
              <span className="notice-icon" aria-hidden>
                <Icon name="alert" />
              </span>
              <div>
                <h2>Private: only admins see this guide</h2>
                <p className="muted">
                  The GGUF repo isn&apos;t public yet, so its links work only for Hugging Face accounts that can see it.
                  Everyone else sees that the files aren&apos;t public yet.
                </p>
              </div>
            </section>
          ) : null}
          <LocalGuide
            files={toPageFiles(usable)}
            hello={hello}
            live={{ open: Boolean(live), modelHref }}
            driveHref={usable.public ? driveHref : null}
            help={help}
          />
          <BuildsTable files={usable} />
        </>
      ) : (
        <EmptyCard
          icon="monitor"
          title={notPublic ? "Not public yet" : "No local files yet"}
          action={{ href: modelHref, label: "Back to the model" }}
        >
          <p>
            {notPublic
              ? "This model's local files aren't public yet."
              : "Local files aren't made yet for this model."}{" "}
            Once they are, this page shows which build fits your computer, about how fast it runs, and how to start it in
            LM Studio, Ollama or llama.cpp.
          </p>
        </EmptyCard>
      )}
    </div>
  );
}
