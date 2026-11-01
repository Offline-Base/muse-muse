// Platform file (Muse Muse platform services). Don't edit: products wrap these helpers, never change them.
//
// Browser links to a device the visitor plugged in or paired: Web Serial, WebUSB and Web Bluetooth, all behind one small
// DeviceLink. Browser only, from a click: the browser refuses a device picker any other way. These work in Chrome and Edge
// on a computer or Android, not in Safari or on iPhone, so check linkSupported first or use ConnectDevice, which does.

export type LinkKind = "serial" | "usb" | "bluetooth";
export type HardwareErrorCode = "unsupported" | "cancelled" | "failed" | "framed";

/** What a person sees where the browser can't do it. */
export const UNSUPPORTED_MESSAGE = "This browser can't connect to devices. Use Chrome or Edge on a computer or Android. Safari and iPhone can't do this.";

/** What a person sees where the page around this one doesn't let it use devices. ConnectDevice adds the link. */
export const FRAMED_MESSAGE = "Your browser won't connect a device from inside another page. Open this product in its own tab, then click the button there.";

export class HardwareError extends Error {
  constructor(
    readonly code: HardwareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HardwareError";
  }
}

export interface DeviceLink {
  kind: LinkKind;
  /** The device's name, when it gave one. */
  name: string;
  send(data: string | Uint8Array): Promise<void>;
  /** Every chunk of bytes as it arrives. What came before the first listener is kept for it. Returns how to stop listening. */
  onData(listener: (bytes: Uint8Array) => void): () => void;
  /** The same bytes as lines of text, without their line endings. */
  onLine(listener: (line: string) => void): () => void;
  close(): Promise<void>;
}

// The parts of each browser API used here, since TypeScript's DOM types don't include them.
interface SerialLike {
  requestPort(opts?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPortLike>;
}
interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface UsbLike {
  requestDevice(opts: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<UsbDeviceLike>;
}
interface UsbEndpointLike {
  endpointNumber: number;
  direction: "in" | "out";
  packetSize: number;
}
interface UsbDeviceLike {
  productName?: string;
  configuration: { interfaces: Array<{ interfaceNumber: number; alternate: { endpoints: UsbEndpointLike[] } }> } | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<{ status?: string; data?: DataView }>;
  transferOut(endpoint: number, data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}
interface BluetoothLike {
  requestDevice(opts: { filters: Array<{ services?: string[]; namePrefix?: string }>; optionalServices?: string[] }): Promise<BluetoothDeviceLike>;
}
interface BluetoothDeviceLike {
  name?: string;
  gatt?: {
    connected?: boolean;
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike> }> }>;
    disconnect(): void;
  };
}
interface BluetoothCharacteristicLike extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  writeValue(data: Uint8Array): Promise<void>;
}

const browserApi = <T,>(name: "serial" | "usb" | "bluetooth"): T | undefined => (typeof navigator === "undefined" ? undefined : (navigator as unknown as Record<string, T | undefined>)[name]);

/** Whether this browser has this kind of link. False on the server. */
export function linkSupported(kind: LinkKind): boolean {
  return Boolean(browserApi(kind));
}

function needs<T>(kind: LinkKind): T {
  const api = browserApi<T>(kind);
  if (!api) throw new HardwareError("unsupported", UNSUPPORTED_MESSAGE);
  return api;
}

/** True inside another page's frame, where the outer page decides whether devices are allowed. */
function inFrame(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** A person closing the picker isn't a failure, and a browser's own words aren't for people. */
function plainError(err: unknown, what: string): HardwareError {
  if (err instanceof HardwareError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotFoundError") return new HardwareError("cancelled", "No device was picked.");
  if (name === "SecurityError" && inFrame()) return new HardwareError("framed", FRAMED_MESSAGE);
  if (name === "SecurityError" || name === "NotAllowedError") return new HardwareError("failed", `The browser didn't allow the ${what}. Click the button again, on a page opened over https.`);
  if (name === "InvalidStateError" || name === "NetworkError") return new HardwareError("failed", `The ${what} is busy or was unplugged. Close anything else using it, then try again.`);
  return new HardwareError("failed", `The ${what} didn't connect. Check that it's plugged in or nearby, then try again.`);
}

/** The shared half of a link: listeners, what arrived before the first one, and lines. */
function makeLink(kind: LinkKind, name: string, write: (bytes: Uint8Array) => Promise<void>, end: () => Promise<void>): { link: DeviceLink; deliver(bytes: Uint8Array): void } {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const early: Uint8Array[] = [];
  let closed = false;
  const onData = (listener: (bytes: Uint8Array) => void) => {
    listeners.add(listener);
    const pending = early.splice(0);
    // After this call returns, so the listener can use what onData gave back.
    if (pending.length) queueMicrotask(() => pending.forEach((bytes) => listeners.has(listener) && listener(bytes)));
    return () => void listeners.delete(listener);
  };
  return {
    deliver(bytes) {
      if (!listeners.size) early.push(bytes);
      for (const listener of listeners) listener(bytes);
    },
    link: {
      kind,
      name,
      onData,
      onLine(listener) {
        const decoder = new TextDecoder();
        let rest = "";
        return onData((bytes) => {
          rest += decoder.decode(bytes, { stream: true });
          const lines = rest.split(/\r\n|\n|\r/);
          rest = lines.pop() ?? "";
          for (const line of lines) listener(line);
        });
      },
      async send(data) {
        if (closed) throw new HardwareError("failed", "This device isn't connected any more.");
        try {
          await write(typeof data === "string" ? new TextEncoder().encode(data) : data);
        } catch (err) {
          throw plainError(err, "device");
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        listeners.clear();
        await end().catch(() => undefined);
      },
    },
  };
}

/** Opens a serial port the person picks: most microcontrollers on a USB cable. */
export async function connectSerial(opts: { baudRate?: number; filters?: Array<{ usbVendorId?: number; usbProductId?: number }> } = {}): Promise<DeviceLink> {
  const serial = needs<SerialLike>("serial");
  try {
    const port = await serial.requestPort(opts.filters ? { filters: opts.filters } : {});
    await port.open({ baudRate: opts.baudRate ?? 9600 });
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const { link, deliver } = makeLink(
      "serial",
      "Serial device",
      async (bytes) => {
        const writer = port.writable?.getWriter();
        if (!writer) throw new HardwareError("failed", "This device can't be written to.");
        try {
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
      },
      async () => {
        await reader?.cancel().catch(() => undefined);
        await port.close();
      },
    );
    void (async () => {
      reader = port.readable?.getReader() ?? null;
      try {
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) deliver(value);
        }
      } catch {
        // Unplugged or closed: the reads just end.
      } finally {
        reader?.releaseLock();
      }
    })();
    return link;
  } catch (err) {
    throw plainError(err, "serial port");
  }
}

/** Opens a USB device the person picks, on its first interface with an in and an out endpoint, unless told which. */
export async function connectUsb(opts: { filters: Array<{ vendorId?: number; productId?: number }>; configuration?: number; interfaceNumber?: number }): Promise<DeviceLink> {
  const usb = needs<UsbLike>("usb");
  try {
    const device = await usb.requestDevice({ filters: opts.filters });
    await device.open();
    await device.selectConfiguration(opts.configuration ?? 1);
    const found = device.configuration?.interfaces.find((i) => {
      if (opts.interfaceNumber !== undefined && i.interfaceNumber !== opts.interfaceNumber) return false;
      return i.alternate.endpoints.some((e) => e.direction === "in") && i.alternate.endpoints.some((e) => e.direction === "out");
    });
    if (!found) throw new HardwareError("failed", "This USB device has no way to send and receive that this page can use.");
    await device.claimInterface(found.interfaceNumber);
    const input = found.alternate.endpoints.find((e) => e.direction === "in")!;
    const output = found.alternate.endpoints.find((e) => e.direction === "out")!;
    let open = true;
    const { link, deliver } = makeLink(
      "usb",
      device.productName || "USB device",
      async (bytes) => void (await device.transferOut(output.endpointNumber, bytes)),
      async () => {
        open = false;
        await device.close();
      },
    );
    void (async () => {
      try {
        while (open) {
          const { status, data } = await device.transferIn(input.endpointNumber, input.packetSize);
          if (status === "ok" && data?.byteLength) deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
      } catch {
        // Unplugged or closed: the reads just end.
      }
    })();
    return link;
  } catch (err) {
    throw plainError(err, "USB device");
  }
}

/** Connects to a Bluetooth Low Energy device the person picks. Name the service and the characteristics to use. */
export async function connectBluetooth(opts: { service: string; notify?: string; write?: string; namePrefix?: string }): Promise<DeviceLink> {
  const bluetooth = needs<BluetoothLike>("bluetooth");
  try {
    const device = await bluetooth.requestDevice({ filters: [{ services: [opts.service], ...(opts.namePrefix ? { namePrefix: opts.namePrefix } : {}) }], optionalServices: [opts.service] });
    if (!device.gatt) throw new HardwareError("failed", "This Bluetooth device can't be connected to from a page.");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(opts.service);
    const writer = opts.write ? await service.getCharacteristic(opts.write) : null;
    const { link, deliver } = makeLink(
      "bluetooth",
      device.name || "Bluetooth device",
      async (bytes) => {
        if (!writer) throw new HardwareError("failed", "This device can't be written to.");
        await writer.writeValue(bytes);
      },
      async () => device.gatt?.disconnect(),
    );
    if (opts.notify) {
      const notify = await service.getCharacteristic(opts.notify);
      notify.addEventListener("characteristicvaluechanged", () => {
        const value = notify.value;
        if (value) deliver(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
      });
      await notify.startNotifications();
    }
    return link;
  } catch (err) {
    throw plainError(err, "Bluetooth device");
  }
}
