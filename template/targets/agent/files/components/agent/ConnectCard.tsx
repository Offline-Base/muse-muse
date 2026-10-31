import { useId } from "react";
import { Icon } from "@/components/Icon";
import type { AgentConnect } from "@/lib/agent/events";

/**
 * Asks for an account the agent needs, or says only the owner can connect it. With `connected`, it says so and offers
 * Disconnect. Composio handles the sign-in and may keep what passes through it, so the card always says that.
 */
export function ConnectCard({
  connect,
  connected = false,
  busy = false,
  onConnect,
  onDisconnect,
}: {
  connect: AgentConnect;
  connected?: boolean;
  busy?: boolean;
  onConnect: (toolkit: string) => void;
  onDisconnect?: (toolkit: string) => void;
}) {
  const id = useId();
  const { label, toolkit, canConnect } = connect;
  return (
    <section className="card" aria-labelledby={id} data-connect>
      <div className="card-head">
        <h2 id={id}>{connected ? `${label} connected` : canConnect ? `Connect your ${label}` : `${label} isn't connected`}</h2>
      </div>
      {canConnect || connected ? (
        <p className="hint">Composio links your account for this app. It may keep what this app reads or sends for up to a year.</p>
      ) : (
        <p className="note">
          <Icon name="info" />
          Only this app's owner can connect {label} for now.
        </p>
      )}
      {connected && onDisconnect ? (
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => onDisconnect(toolkit)}>
            Disconnect
          </button>
        </div>
      ) : !connected && canConnect ? (
        <div className="actions">
          <button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={() => onConnect(toolkit)}>
            {busy ? `Connecting ${label}…` : `Connect ${label}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
