"use client";

import { useEffect, useState } from "react";
import { Segmented } from "@/components/docs/kit/Field";
import { CodeBlock } from "@/components/docs/playgrounds/start/CodeBlock";
import styles from "@/components/docs/playgrounds/start/start.module.css";

type Os = "unix" | "windows";

/** The install commands from the overview and the quickstart, word for word. */
export const MUSE_CODE_INSTALL: Record<Os, { label: string; shell: string; command: string }> = {
  unix: { label: "macOS or Linux", shell: "bash", command: "curl -fsSL https://dev.meta.ai/install.sh | sh" },
  windows: { label: "Windows (PowerShell)", shell: "powershell", command: "irm https://dev.meta.ai/install.ps1 | iex" },
};

export const MUSE_CODE_START = "muse   # start Muse Code; on first run, choose a browser sign-in or paste an API key";

/**
 * Muse Code's install and first run, ready to copy. Muse Code is a terminal app, so a browser can't run it: this is
 * the two commands the pages give, for the reader's platform (picked from the browser, switchable).
 */
export function InstallCommands({ note = true }: { note?: boolean }) {
  const [os, setOs] = useState<Os>("unix");
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.userAgent;
    if (/windows|win32|win64/i.test(platform)) setOs("windows");
  }, []);
  const install = MUSE_CODE_INSTALL[os];
  return (
    <div className={styles.stack}>
      <p className={`${styles.lead} pg-advanced`}>
        Muse Code is Meta&apos;s coding agent for the terminal and CI, built on Muse Spark. It runs in your terminal, so copy these
        there: install it, then start it in a project.
      </p>
      <div className="pg-bar">
        <Segmented<Os>
          label="Platform"
          options={(Object.keys(MUSE_CODE_INSTALL) as Os[]).map((value) => ({ value, label: MUSE_CODE_INSTALL[value].label }))}
          value={os}
          onChange={setOs}
        />
      </div>
      <CodeBlock label={install.shell} code={install.command} syntax="bash" caption="1. Install the CLI" copyLabel="Copy the install command" />
      <CodeBlock label="bash" code={MUSE_CODE_START} syntax="bash" caption="2. Start building" copyLabel="Copy the start command" />
      {note ? (
        <p className={`${styles.small} pg-advanced`}>
          On first run, <code>muse</code> asks you to sign in through your browser or paste an API key, so there&apos;s no key or provider
          config to wire up. Muse Code and the API are two ways to use the same models: Muse Code for a ready-made agent, the API when
          you build your own. Approvals and an OS sandbox are on from the first run.{" "}
          <a className={styles.link} href="/docs/muse-code">
            Muse Code overview
          </a>
        </p>
      ) : null}
    </div>
  );
}
