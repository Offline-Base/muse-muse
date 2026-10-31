import { ChatLink } from "@/components/chat/ChatLink";
import type { SourceItem } from "@/components/chat/types";
import { Icon, type IconName } from "@/components/icons";

const KIND_ICON: Record<NonNullable<SourceItem["kind"]>, IconName> = {
  inspiration: "image",
  file: "file",
  docs: "book",
  model: "sparkle",
  skill: "doc",
  web: "link",
};

/**
 * The steps panel's Sources tab (docs/UI_MUSE_APP.md, "The steps panel", "Sources"): what a turn used, each a row with a
 * 16 px favicon or thumbnail, a title and a secondary line such as its domain or path. A source with a link opens it: in
 * place for a page on this site, in a new tab for any other.
 */
export function SourceList({
  sources,
  label = "Sources",
  empty = "Nothing here yet.",
}: {
  sources: readonly SourceItem[];
  label?: string;
  /** Shown when there are no sources. */
  empty?: string;
}) {
  if (!sources.length) return <p className="chat-sources-empty">{empty}</p>;
  return (
    <ul className="chat-sources" aria-label={label}>
      {sources.map((s) => (
        <li key={s.id} className="chat-source">
          <span className="chat-source-icon">
            {s.icon ? (
              // A favicon or a thumbnail from wherever the source lives.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.icon} alt="" width={16} height={16} loading="lazy" />
            ) : (
              <Icon name={KIND_ICON[s.kind ?? "web"]} size={16} />
            )}
          </span>
          <span className="chat-source-text">
            {s.href ? (
              <ChatLink href={s.href} className="chat-source-title">
                {s.title}
              </ChatLink>
            ) : (
              <span className="chat-source-title">{s.title}</span>
            )}
            {s.detail ? <span className="chat-source-detail">{s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
