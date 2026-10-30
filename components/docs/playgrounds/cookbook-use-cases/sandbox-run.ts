"use client";

import { makeNonce, readLog, runPage, type RunResult } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";

/**
 * Runs JavaScript from a virtual file tree in a throwaway sandboxed iframe (sandbox="allow-scripts", srcdoc, opaque
 * origin), the browser's version of the recipe's throwaway Docker container: it gets the files, runs one entry file
 * with a CommonJS loader, reports its console as stdout and an exit code, and is removed afterwards. A run that takes
 * longer than `timeoutMs` is killed by removing the frame.
 */
export function runInSandbox(files: Record<string, string>, entry: string, argv: string[] = [], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    const nonce = makeNonce();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;";
    const out: string[] = [];
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const data = e.data as { __cuc?: unknown; type?: unknown; code?: unknown } | null;
      if (!data || data.__cuc !== nonce) return;
      const log = readLog(data);
      if (log) {
        if (out.join("\n").length < 60_000) out.push(log.text);
        return;
      }
      if (data.type === "done") {
        finish({ code: typeof data.code === "number" ? data.code : 1, stdout: out.join("\n"), timedOut: false, error: null });
      }
    };
    const timer = setTimeout(
      () => finish({ code: 124, stdout: out.join("\n"), timedOut: true, error: `Killed: the command ran longer than ${Math.round(timeoutMs / 1000)} s.` }),
      timeoutMs,
    );
    window.addEventListener("message", onMessage);
    frame.srcdoc = runPage(files, entry, argv, nonce);
    document.body.appendChild(frame);
  });
}
