import { Icon } from "@/components/icons";

/**
 * The blue Run pill, which becomes Stop (an outline pill) while a request runs and Stop is possible. Without onStop
 * it stays Run, disabled and spinning, until the request ends.
 */
export function RunButton({
  running,
  onRun,
  onStop,
  label = "Run",
  disabled,
}: {
  running: boolean;
  onRun(): void;
  onStop?(): void;
  label?: string;
  disabled?: boolean;
}) {
  if (running && onStop) {
    return (
      <button type="button" className="btn btn-outline pg-run pg-stop" onClick={onStop}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
        </svg>
        <span>Stop</span>
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-primary pg-run" onClick={onRun} disabled={disabled || running} aria-busy={running || undefined}>
      {running ? <span className="spinner" aria-hidden /> : <Icon name="play" size={14} />}
      <span>{running ? "Running" : label}</span>
    </button>
  );
}
