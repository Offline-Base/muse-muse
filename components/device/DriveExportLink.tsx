import { Icon } from "@/components/icons";
import type { LocalFiles } from "@/lib/train/local-files";
import { gbText } from "@/lib/vibe/device";

/**
 * On a lab model's admin view, with DRIVE_EXPORT_ENABLED: links to the Flash drive card on /device with this model picked,
 * one link per checked build and one for all of them (docs/DRIVE_EXPORT.md, "Manual"). Shown only when it has files.
 */
export function DriveExportLink({ jobId, files }: { jobId: string; files: LocalFiles | null }) {
  if (!files?.files.length || !files.repo || !files.commit) return null;
  const link = (build: string) => `/device?export=${encodeURIComponent(`lab:${jobId}:${build}`)}`;
  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <section className="card section-card" aria-labelledby="drive-export-title">
        <h2 id="drive-export-title">Put it on a drive</h2>
        <p className="muted small">Its checked GGUF files go onto a USB drive plugged into the board, from the Flash drive card on the Device page.</p>
        <div className="row-actions">
          {files.files.length > 1 ? (
            <a className="btn btn-outline btn-sm" href={link("all")}>
              <Icon name="download" size={16} />
              <span>All {files.files.length} builds</span>
            </a>
          ) : null}
          {files.files.map((f) => (
            <a key={f.level} className="btn btn-outline btn-sm" href={link(f.level)}>
              <Icon name="download" size={16} />
              <span>
                {f.level}, {gbText(f.bytes)}
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
