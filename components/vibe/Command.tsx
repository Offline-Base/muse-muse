import { CopyButton } from "@/components/CopyButton";

/** A command or file to paste, as it should be typed, with a copy button. Lines are kept, and long ones wrap. */
export function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="code-block vibe-code">
      <code>{text}</code>
      <CopyButton value={text} label={label} className="icon-btn icon-btn-plain" />
    </div>
  );
}

/**
 * Text to paste into an app, such as the system message, under a small heading and with a copy button. A long one
 * (tuned.jinja) is `folded`: the copy button copies all of it, and the text itself opens on request.
 */
export function PasteBlock({ title, text, label, folded = false }: { title: string; text: string; label: string; folded?: boolean }) {
  return (
    <div className="vibe-paste">
      <div className="vibe-paste-head">
        <h4>{title}</h4>
        <CopyButton value={text} label={label} text="Copy" className="btn btn-sm btn-outline" />
      </div>
      {folded ? (
        <details className="vibe-sums">
          <summary>Show it</summary>
          <pre className="vibe-pre vibe-pre-long">{text}</pre>
        </details>
      ) : (
        <pre className="vibe-pre">{text}</pre>
      )}
    </div>
  );
}
