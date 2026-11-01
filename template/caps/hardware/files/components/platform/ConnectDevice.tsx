// Platform file (Muse Muse platform services). Don't edit: products wrap this component, never change it.
"use client";

import { useEffect, useState } from "react";
import { connectBluetooth, connectSerial, connectUsb, HardwareError, linkSupported, UNSUPPORTED_MESSAGE, type DeviceLink, type LinkKind } from "@/lib/platform/hardware";

export type ConnectOptions = { link: "serial"; options?: Parameters<typeof connectSerial>[0] } | { link: "usb"; options: Parameters<typeof connectUsb>[0] } | { link: "bluetooth"; options: Parameters<typeof connectBluetooth>[0] };

function connect(props: ConnectOptions): Promise<DeviceLink> {
  if (props.link === "serial") return connectSerial(props.options);
  if (props.link === "usb") return connectUsb(props.options);
  return connectBluetooth(props.options);
}

/**
 * The button that connects a device: it opens the browser's picker from the click, shows why when it can't, and offers
 * Disconnect once connected. `onConnect` gets the link; use its send, onData and onLine.
 */
export function ConnectDevice(props: ConnectOptions & { label?: string; onConnect(link: DeviceLink): void; onDisconnect?(): void }) {
  const kind: LinkKind = props.link;
  const [supported, setSupported] = useState(true);
  const [link, setLink] = useState<DeviceLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server can't know the browser, so this is read after the first paint.
    setSupported(linkSupported(kind));
  }, [kind]);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const next = await connect(props);
      setLink(next);
      props.onConnect(next);
    } catch (err) {
      setMessage(err instanceof HardwareError ? err.message : "The device didn't connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await link?.close();
    setLink(null);
    props.onDisconnect?.();
  }

  if (!supported) return <p role="status">{UNSUPPORTED_MESSAGE}</p>;
  return (
    <div>
      {link ? (
        <button type="button" className="secondary" onClick={() => void stop()}>
          Disconnect {link.name}
        </button>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
          {props.label ?? "Connect a device"}
        </button>
      )}
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
