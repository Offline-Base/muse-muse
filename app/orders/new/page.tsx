import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { RequestForm } from "@/components/drive/RequestForm";
import { Icon } from "@/components/icons";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { toPageFiles } from "@/components/vibe/apps";
import { LocalGuide } from "@/components/vibe/LocalGuide";
import { driveProblem, gb, minimumSpecText, priceLine } from "@/lib/drive/logic";
import { DRIVE_TERMS } from "@/lib/drive/terms";
import { env } from "@/lib/env";
import { isUuid, safeQuery } from "@/lib/queries";
import { localFilesFor } from "@/lib/train/local-files-server";
import { getResultJob } from "@/lib/train/store";
import { minimumSpec } from "@/lib/vibe/device";

export const metadata: Metadata = { title: "Get it on a flash drive", robots: { index: false } };

function Unavailable({ title, text, back }: { title: string; text: string; back: string | null }) {
  return (
    <div className="page">
      <EmptyCard icon="download" title={title} action={{ href: back ?? "/fine-tuning#results", label: back ? "Back to the model" : "See the models" }}>
        <p>{text}</p>
      </EmptyCard>
    </div>
  );
}

/**
 * The order request for one model, /orders/new?model=<training job id> (docs/VIBE_TUNING.md, Feature 6): what goes on
 * the drive and what it runs on, the price line, the device picker's verdict for the buyer's own computer (so nobody
 * orders a drive their computer can't run), and the one-screen form. Only while DRIVE_ENABLED is on and the model can
 * go on a drive: a judged model with a public GGUF repo and at least one build that passed its checks.
 */
export default async function NewDriveOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { model } = await searchParams;
  const jobId = typeof model === "string" && isUuid(model) ? model.toLowerCase() : null;
  const back = jobId ? `/fine-tuning/${jobId}` : null;
  if (!env.driveEnabled) {
    return <Unavailable title="Flash drive orders are off" text="We aren't taking drive requests right now. The model's files are still on Hugging Face." back={back} />;
  }
  if (!jobId) return <Unavailable title="Pick a model first" text="Open a model's results page and press Request a drive there." back={null} />;

  const result = await safeQuery(async () => {
    const [judged, files] = await Promise.all([getResultJob(jobId), localFilesFor(jobId)]);
    return { judged: judged !== null, files };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this model" />
      </div>
    );
  }
  const files = result.data.files;
  const problem = driveProblem({ enabled: true, judged: result.data.judged, files });
  if (problem || !files) return <Unavailable title="This model can't go on a drive" text={problem ?? ""} back={back} />;

  const spec = minimumSpecText(minimumSpec(files.files));
  return (
    <div className="page">
      <PageHeader
        title="Get it on a flash drive"
        subtitle={
          <>
            {files.title} · <Link href={`/fine-tuning/${files.adapterJobId}`}>the model&apos;s results</Link>
          </>
        }
      />

      <div className="two-col">
        <section className="card section-card" aria-labelledby="drive-what">
          <h2 id="drive-what">What&apos;s on it</h2>
          <p>
            {files.title} in {files.files.length === 1 ? "its one size" : `${files.files.length} sizes`}, a llama.cpp runtime,
            and a launcher for Mac and Windows. It runs offline: nothing you type leaves your computer.
          </p>
          <ul className="chips" aria-label="Sizes">
            {files.files.map((f) => (
              <li key={f.level} className="chip">
                {f.level} · {gb(f.bytes)}
              </li>
            ))}
          </ul>
          <p>It runs on {spec}.</p>
          <p className="muted small">
            Windows PCs with Smart App Control on aren&apos;t supported yet.{" "}
            <Link href={`/fine-tuning/${files.adapterJobId}/run`}>Check your computer first</Link>
          </p>
        </section>

        <section className="card section-card" aria-labelledby="drive-price">
          <h2 id="drive-price">Price and shipping</h2>
          <p>
            <strong>{priceLine(env.drivePriceText)}</strong>
          </p>
          <ul className="drive-facts">
            <li>Nothing is charged on this site. We email you an invoice with the price within 2 business days.</li>
            <li>We write the drive, check every file on it, and ship it within 2 business days after you pay.</li>
            <li>US addresses only for now.</li>
            <li>Fine-tuned from Meta&apos;s Muse Glimmer 30B (Apache 2.0). Not made, reviewed or endorsed by Meta.</li>
            {env.driveContactEmail ? (
              <li>
                Questions? Write to <a href={`mailto:${env.driveContactEmail}`}>{env.driveContactEmail}</a>.
              </li>
            ) : null}
          </ul>
          <p className="muted small">
            <Icon name="info" size={14} /> Prefer to download it? The files are free on{" "}
            <a href={`https://huggingface.co/${files.repo}`} target="_blank" rel="noopener noreferrer">
              Hugging Face
            </a>
            .
          </p>
        </section>
      </div>

      {/* The picker and its verdict, without the download or the app guide: the drive brings the files and the runtime. */}
      <LocalGuide files={toPageFiles(files)} hello={null} live={{ open: false, modelHref: `/fine-tuning/${files.adapterJobId}` }} guide={false} />

      <RequestForm
        jobId={files.adapterJobId}
        title={files.title}
        files={files.files.map((f) => ({ level: f.level, bytes: f.bytes }))}
        termsVersion={env.driveTermsVersion}
        terms={DRIVE_TERMS}
        contact={env.driveContactEmail}
      />
    </div>
  );
}
