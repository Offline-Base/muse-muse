import type { ReactNode } from "react";
import { ChatLink } from "@/components/chat/ChatLink";
import type { BubbleAttachment } from "@/components/chat/types";
import { Icon } from "@/components/icons";

/**
 * The person's message (docs/UI_MUSE_APP.md, "The person's message"): a gray bubble at the column's right edge, as wide
 * as its text up to 75% of the column, with what they attached as 40 px thumbnails in a row inside its right end.
 */
export function UserBubble({ text, attachments = [] }: { text?: ReactNode; attachments?: readonly BubbleAttachment[] }) {
  return (
    <div className={`chat-bubble${attachments.length ? " has-files" : ""}`}>
      {text ? <p className="chat-bubble-text">{text}</p> : null}
      {attachments.length ? (
        <ul className="chat-bubble-files" aria-label="Attached files">
          {attachments.map((a, i) => (
            <li key={`${i}-${a.src ?? a.alt}`}>
              <ChatLink href={a.href} className="chat-bubble-file">
                {a.src ? (
                  // Blob, data or stored URLs of any size: next/image would need each host configured.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.src} alt={a.alt} width={40} height={40} loading="lazy" />
                ) : (
                  <Icon name={a.icon ?? "file"} size={16} title={a.alt} />
                )}
              </ChatLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
