"use client";

import { Field, Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import type { McpServerDraft, Transport } from "@/components/docs/playgrounds/muse-code/settings";
import { NumberField, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * One MCP server entry for settings.json, as the extending page describes it: a transport, stdio (command, args, env)
 * or streamable_http (url, headers), plus enabled, mode (required or optional) and the per-server timeouts the
 * changelog adds. Shared by the configuration and extending builders.
 */
export function McpServerEditor({
  idBase,
  value,
  onChange,
  onRemove,
}: {
  idBase: string;
  value: McpServerDraft;
  onChange(patch: Partial<McpServerDraft>): void;
  onRemove?(): void;
}) {
  const s = value;
  return (
    <div className={`${styles.card} ${styles.cardMuted}`}>
      <div className={styles.row}>
        <Field id={`${idBase}-name`} label="Server name" className={styles.narrow}>
          <TextInput id={`${idBase}-name`} className="pg-code-input" value={s.name} spellCheck={false} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <div className="pg-field">
          <span className="pg-label">transport</span>
          <Segmented<Transport>
            label="Transport"
            size="sm"
            value={s.transport}
            onChange={(transport) => onChange({ transport })}
            options={[
              { value: "stdio", label: "stdio" },
              { value: "streamable_http", label: "streamable_http" },
            ]}
          />
        </div>
        <SelectField
          id={`${idBase}-mode`}
          label="mode"
          value={s.mode}
          onChange={(mode) => onChange({ mode: mode as McpServerDraft["mode"] })}
          options={[
            { value: "required", label: "required (default)" },
            { value: "optional", label: "optional" },
          ]}
        />
      </div>
      {s.transport === "stdio" ? (
        <div className={styles.row}>
          <Field id={`${idBase}-cmd`} label="command" className={styles.narrow}>
            <TextInput id={`${idBase}-cmd`} className="pg-code-input" value={s.command} spellCheck={false} onChange={(e) => onChange({ command: e.target.value })} />
          </Field>
          <Field id={`${idBase}-args`} label="args (space-separated)" className={styles.grow}>
            <TextInput id={`${idBase}-args`} className="pg-code-input" value={s.args} spellCheck={false} onChange={(e) => onChange({ args: e.target.value })} />
          </Field>
          <Field id={`${idBase}-env`} label="env (KEY=value per line)" className={styles.grow}>
            <TextArea id={`${idBase}-env`} className="pg-code-input" rows={2} value={s.env} spellCheck={false} placeholder="API_TOKEN=${DOCS_TOKEN}" onChange={(e) => onChange({ env: e.target.value })} />
          </Field>
        </div>
      ) : (
        <div className={styles.row}>
          <Field id={`${idBase}-url`} label="url" className={styles.grow}>
            <TextInput id={`${idBase}-url`} className="pg-code-input" value={s.url} spellCheck={false} onChange={(e) => onChange({ url: e.target.value })} />
          </Field>
          <Field id={`${idBase}-headers`} label="headers (Name: value per line)" className={styles.grow}>
            <TextArea id={`${idBase}-headers`} className="pg-code-input" rows={2} value={s.headers} spellCheck={false} onChange={(e) => onChange({ headers: e.target.value })} />
          </Field>
        </div>
      )}
      <div className={styles.row}>
        <NumberField id={`${idBase}-tt`} label="tool_timeout_sec" value={s.toolTimeoutSec} min={1} onChange={(toolTimeoutSec) => onChange({ toolTimeoutSec })} />
        <NumberField id={`${idBase}-st`} label="startup_timeout_sec" value={s.startupTimeoutSec} min={1} onChange={(startupTimeoutSec) => onChange({ startupTimeoutSec })} />
        <Toggle id={`${idBase}-on`} label="enabled" checked={s.enabled} onChange={(enabled) => onChange({ enabled })} />
        {onRemove ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
