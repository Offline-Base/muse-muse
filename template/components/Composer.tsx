"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";

/**
 * The chat input: a rounded pill with a send button. Enter sends, Shift+Enter adds a line. `label` names the box for
 * screen readers and tests (page.getByLabel("Message")); the placeholder says what to ask. The box empties as the
 * message goes; return false from onSend (or a promise of false) when sending failed, and the text comes back for a
 * retry. While `busy` is true the send button shows the AI working state and nothing can be sent. Put the thread above
 * it and give the thread aria-busy="true" while the reply is on its way.
 */
export function Composer(props: {
  label: string;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  placeholder?: string;
  busy?: boolean;
  disabled?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0 && !props.busy && !props.disabled;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    const message = text.trim();
    setText("");
    let sent = false;
    try {
      sent = (await props.onSend(message)) !== false;
    } finally {
      // Put the message back unless the person has started typing a new one.
      if (!sent) setText((now) => now || message);
    }
  };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
  };

  return (
    <form className="composer" onSubmit={(e) => void send(e)}>
      <label className="visually-hidden" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        id={id}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        disabled={props.disabled}
        data-user-text
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keyDown}
      />
      <button type="submit" className="send" aria-label="Send" aria-busy={props.busy ? true : undefined} disabled={!ready}>
        <Icon name="send" size={18} />
      </button>
    </form>
  );
}
