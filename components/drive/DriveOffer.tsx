import Link from "next/link";
import { buildLabel, driveProblem, gb, minimumSpecText, priceLine } from "@/lib/drive/logic";
import { env } from "@/lib/env";
import type { LocalFiles } from "@/lib/train/local-files";
import { minimumSpec } from "@/lib/vibe/device";

/**
 * "Get it on a flash drive" on a model's public page (docs/VIBE_TUNING.md, Feature 6): what goes on the stick, the least
 * a computer needs to run it (the device picker's own numbers), the price line, and the way to the request form. Shown
 * only while DRIVE_ENABLED is on and the model can go on a drive (driveProblem): its GGUF repo is public at a commit and
 * at least one build passed its file checks. The page hands it the local files it already read, and only shows judged
 * models, so this reads nothing itself.
 */
export function DriveOffer({ files }: { files: LocalFiles | null }) {
  if (!env.driveEnabled || !files || driveProblem({ enabled: true, judged: true, files })) return null;
  const spec = minimumSpecText(minimumSpec(files.files));
  const what = files.files.length === 1 ? "This model in its one size" : `${buildLabel("all", files.files.length)} of this model`;
  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <section className="card section-card" aria-labelledby="drive-offer-title">
        <h2 id="drive-offer-title">Get it on a flash drive</h2>
        <p>
          {what} and a llama.cpp runtime on one USB stick, with a launcher for Mac and Windows. It runs offline on {spec}.
        </p>
        <ul className="chips" aria-label="Sizes on the drive">
          {files.files.map((f) => (
            <li key={f.level} className="chip">
              {f.level} · {gb(f.bytes)}
            </li>
          ))}
        </ul>
        <p className="muted small">
          {priceLine(env.drivePriceText)} We ship to US addresses. Windows PCs with Smart App Control on aren&apos;t
          supported yet.
        </p>
        <div className="row-actions">
          <Link className="btn btn-primary" href={`/orders/new?model=${files.adapterJobId}`}>
            Request a drive
          </Link>
          <Link className="btn btn-outline" href={`/fine-tuning/${files.adapterJobId}/run`}>
            Check your computer first
          </Link>
        </div>
      </section>
    </div>
  );
}
