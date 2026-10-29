import Link from "next/link";
import { Icon } from "@/components/icons";
import { isRepoId } from "@/components/vibe/apps";
import type { LocalFiles } from "@/lib/train/local-files";
import { localFilesFor } from "@/lib/train/local-files-server";
import { buildsText, minimumSpec } from "@/lib/vibe/device";

/** The local files a public model page may link to: public on the Hub, with at least one build. Otherwise null. */
export function linkableLocalFiles(files: LocalFiles | null | undefined): LocalFiles | null {
  return files && files.public && isRepoId(files.repo) && files.files.length ? files : null;
}

/**
 * A model's local files when its public page may link them, or null. A GGUF repo goes public only after its adapter's
 * (docs/VIBE_TUNING.md, Feature 3), so the page asks only for a job whose adapter is public on the Hub. Never throws: a
 * problem reading them is logged and only leaves the link out, so it can't take the rest of the page down with it.
 */
export async function linkedLocalFiles(jobId: string): Promise<LocalFiles | null> {
  try {
    const files = await localFilesFor(jobId);
    return files && files.adapterJobId === jobId ? linkableLocalFiles(files) : null;
  } catch (err) {
    console.error("[fine-tuning] local files:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * "Run it on your computer" on a model's public page (docs/VIBE_TUNING.md, Feature 5): a line under the model's title
 * (JobResults' aside) that opens /fine-tuning/{jobId}/run. The model page shows it only once the model has public local
 * files.
 */
export function RunLocallyLink({ jobId, files }: { jobId: string; files: LocalFiles }) {
  const min = minimumSpec(files.files);
  const text = buildsText(files.files);
  const builds = `${text[0].toUpperCase()}${text.slice(1)}`;
  return (
    <Link className="card vibe-run-link" href={`/fine-tuning/${jobId}/run`}>
      <span className="notice-icon" aria-hidden>
        <Icon name="monitor" />
      </span>
      <span className="vibe-run-link-text">
        <strong>Run it on your computer</strong>
        <span className="muted">
          {builds}, for a Mac with {min.macGb} GB or more or a PC with a {min.vramGb} GB graphics card. See which fits
          yours.
        </span>
      </span>
      <Icon name="chevronRight" className="vibe-run-link-go" />
    </Link>
  );
}
