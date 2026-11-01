"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { writeMakeDraft } from "@/components/composer/Composer";
import { Icon } from "@/components/icons";

/** The box that floats over Gallery, Media and Demos. It carries the idea to the Make page, which has the attachments and starts the build. */
export function ComposerDock({ placeholder = "Create anything..." }: { placeholder?: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const ready = note.trim().length > 0;
  function send(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    writeMakeDraft(note.trim());
    router.push("/");
  }
  return (
    <form className="gx-dock" onSubmit={send}>
      <textarea
        aria-label={placeholder}
        placeholder={placeholder}
        rows={1}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) send(event);
        }}
      />
      <button type="submit" className="gx-dock-send" disabled={!ready} aria-label="Continue on Make">
        <Icon name="arrowUp" size={20} />
      </button>
    </form>
  );
}
