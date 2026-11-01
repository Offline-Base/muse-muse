// Platform file (Muse Muse platform services). Don't edit.
//
// A simulated serial port, USB device and Bluetooth device, put on navigator before the page's own code runs. It has no
// imports, since Playwright sends this one function to the browser as text. Whatever the page sends is kept in
// window.__musemuseFakeDevices.sent, by link, and every send gets `reply` back the way the real API delivers bytes.

export interface FakeDevicesConfig {
  /** What the device answers to each thing it receives. */
  reply: string;
  /** What it sends right after connecting, like a thermometer that talks first. */
  greeting?: string;
}

export interface FakeDevicesRecord {
  sent: Array<{ link: string; bytes: number[] }>;
  connected: string[];
}

export function installFakeDevices(config: FakeDevicesConfig): void {
  const record: FakeDevicesRecord = { sent: [], connected: [] };
  (globalThis as unknown as { __musemuseFakeDevices: FakeDevicesRecord }).__musemuseFakeDevices = record;
  const encode = (text: string) => new TextEncoder().encode(text);
  const put = (name: string, value: unknown) => Object.defineProperty(navigator, name, { value, configurable: true });

  put("serial", {
    async requestPort() {
      let push: ReadableStreamDefaultController<Uint8Array> | null = null;
      return {
        readable: null as ReadableStream<Uint8Array> | null,
        writable: null as WritableStream<Uint8Array> | null,
        async open() {
          record.connected.push("serial");
          this.readable = new ReadableStream<Uint8Array>({
            start(controller) {
              push = controller;
              if (config.greeting) controller.enqueue(encode(config.greeting));
            },
          });
          this.writable = new WritableStream<Uint8Array>({
            write(chunk) {
              record.sent.push({ link: "serial", bytes: Array.from(chunk) });
              push?.enqueue(encode(config.reply));
            },
          });
        },
        async close() {
          this.readable = null;
          this.writable = null;
        },
      };
    },
  });

  put("usb", {
    async requestDevice() {
      const queue: Uint8Array[] = config.greeting ? [encode(config.greeting)] : [];
      let wake: (() => void) | null = null;
      let open = false;
      return {
        productName: "Simulated USB device",
        configuration: { interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [{ endpointNumber: 1, direction: "in", packetSize: 64 }, { endpointNumber: 2, direction: "out", packetSize: 64 }] } }] },
        async open() {
          open = true;
          record.connected.push("usb");
        },
        async selectConfiguration() {},
        async claimInterface() {},
        async transferOut(_endpoint: number, data: Uint8Array) {
          record.sent.push({ link: "usb", bytes: Array.from(data) });
          queue.push(encode(config.reply));
          wake?.();
          return { status: "ok", bytesWritten: data.length };
        },
        async transferIn() {
          while (!queue.length) {
            if (!open) throw new DOMException("closed", "NetworkError");
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const next = queue.shift() as Uint8Array;
          return { status: "ok", data: new DataView(next.buffer, next.byteOffset, next.byteLength) };
        },
        async close() {
          open = false;
          wake?.();
        },
      };
    },
  });

  put("bluetooth", {
    async requestDevice() {
      const events = new EventTarget();
      const notify = Object.assign(events, {
        value: undefined as DataView | undefined,
        async startNotifications() {
          if (config.greeting) deliver(config.greeting);
          return notify;
        },
      });
      const deliver = (text: string) => {
        const bytes = encode(text);
        notify.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        events.dispatchEvent(new Event("characteristicvaluechanged"));
      };
      const write = {
        async writeValue(data: Uint8Array) {
          record.sent.push({ link: "bluetooth", bytes: Array.from(data) });
          deliver(config.reply);
        },
      };
      return {
        name: "Simulated Bluetooth device",
        gatt: {
          async connect() {
            record.connected.push("bluetooth");
            return { async getPrimaryService() { return { async getCharacteristic(uuid: string) { return /write/i.test(uuid) ? write : notify; } }; } };
          },
          disconnect() {},
        },
      };
    },
  });
}
