"use client";

import { useMemo, useState } from "react";
import { UploadIcon } from "@/components/docs/page/icons";
import { ApiConsole } from "@/components/docs/playgrounds/common/ApiConsole";
import { docsCall } from "@/lib/docs/client/api";
import { rememberReply } from "@/lib/docs/client/recent";
import type { ParsedIdSlot, ParsedRequest } from "@/lib/docs/curl";
import { withoutRetiredSpark } from "@/lib/meta/spark";

/** Sets the value at an RFC 6901 JSON Pointer in a copy of `body`. */
function setPointer(body: unknown, pointer: string, value: string): unknown {
  const copy = structuredClone(body) as Record<string, unknown>;
  const keys = pointer.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) {
    const next = node?.[key];
    if (!next || typeof next !== "object") return body;
    node = next as Record<string, unknown>;
  }
  if (node && keys.length) node[keys[keys.length - 1]] = value;
  return copy;
}

/**
 * The request as the console should send it: uploaded file ids in place of the docs' placeholder ids, and Meta's
 * muse-spark-1.3 shown as the muse-spark-1.3-contributor model the proxy really calls (docs/DOCS_MIRROR.md, rules).
 */
function liveRequest(request: ParsedRequest, ids: Record<string, string>): ParsedRequest {
  let path = request.path;
  let body = request.body;
  for (const slot of request.fileIds) {
    const id = ids[slot.placeholder];
    if (!id) continue;
    if (slot.pointer === null) path = path.split("/").map((s) => (s === slot.placeholder ? id : s)).join("/");
    else body = setPointer(body, slot.pointer, id);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const model = (body as { model?: unknown }).model;
    if (typeof model === "string" && withoutRetiredSpark(model) !== model) {
      body = { ...(body as Record<string, unknown>), model: withoutRetiredSpark(model) };
    }
  }
  return { ...request, path, body };
}

function FileIdUpload({ slot, uploaded, onUploaded }: { slot: ParsedIdSlot; uploaded?: string; onUploaded: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", file);
    const res = await docsCall<{ id?: string }>("files", { method: "POST", form });
    setBusy(false);
    if (res.ok && res.json?.id) {
      // Every console on the page offers it from now on, as it does for uploads the kit's playgrounds make.
      rememberReply(res.json);
      onUploaded(res.json.id);
    } else setError(res.error?.message ?? "The upload didn't go through. Try a smaller file.");
  }

  return (
    <div className="docs-run-id">
      <p>
        This example uses <code>{slot.placeholder}</code>, an id from Meta&apos;s docs that doesn&apos;t exist for you.{" "}
        {uploaded ? (
          <>
            Using your upload, <code>{uploaded}</code>.
          </>
        ) : (
          "Upload a file (under 3 MB) to get a real one, or send it as is to see the error."
        )}
      </p>
      <label className={busy ? "docs-btn docs-btn-secondary is-busy" : "docs-btn docs-btn-secondary"}>
        <UploadIcon size={16} />
        <span>{busy ? "Uploading..." : uploaded ? "Upload another" : "Upload a file"}</span>
        <input
          type="file"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {error ? (
        <p className="docs-run-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The inline panel under a code block's Run button: the parsed request in the kit's API console, sent via the proxy. */
export default function RunPanel({ request, onClose }: { request: ParsedRequest; onClose: () => void }) {
  const [ids, setIds] = useState<Record<string, string>>({});
  const live = useMemo(() => liveRequest(request, ids), [request, ids]);
  const slots = useMemo(() => {
    const seen = new Set<string>();
    return request.fileIds.filter((s) => !seen.has(s.placeholder) && Boolean(seen.add(s.placeholder)));
  }, [request]);

  return (
    <div className="docs-run" role="region" aria-label={`Run ${request.method} /v1/${request.path}`}>
      <div className="docs-run-head">
        <div>
          <p className="docs-run-title">Run it live</p>
          <p className="docs-run-note">Edit the request, then send it. It goes through Muse Muse&apos;s docs proxy on its own key.</p>
        </div>
        <button type="button" className="docs-link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      {slots.map((slot) => (
        <FileIdUpload
          key={slot.placeholder}
          slot={slot}
          uploaded={ids[slot.placeholder]}
          onUploaded={(id) => setIds((prev) => ({ ...prev, [slot.placeholder]: id }))}
        />
      ))}
      <ApiConsole
        // A new upload changes the request, so the console starts over with it.
        key={JSON.stringify(ids)}
        method={live.method}
        path={live.path}
        body={live.body}
        form={live.form}
        fileSlots={live.fileSlots}
        stream={live.stream}
        title={`${live.method} /v1/${live.path}`}
        // The upload above already says what to do about an example file id in the path.
        hideIdHint={slots.some((s) => s.pointer === null)}
      />
    </div>
  );
}
