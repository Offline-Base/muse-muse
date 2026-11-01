---
name: muse-hardware
description: Use only when the brief has a hardware block. A page that talks to a device over Web Serial, WebUSB or Web Bluetooth, and a product's server that reads a board's sensors or shows text on it.
---

# Devices

Two separate things. A brief may ask for either or both.

## Browser links

The visitor's own browser talks to a device they plugged in or paired. Nothing goes through a server unless the product sends it there.

```tsx
"use client";
import { useRef, useState } from "react";
import { ConnectDevice } from "@/components/platform/ConnectDevice";
import type { DeviceLink } from "@/lib/platform/hardware";

export function Thermometer() {
  const link = useRef<DeviceLink | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  return (
    <>
      <ConnectDevice
        link="serial"
        options={{ baudRate: 9600 }}
        label="Connect the thermometer"
        onConnect={(next) => {
          link.current = next;
          next.onLine(setReading);
        }}
      />
      <button type="button" className="secondary" onClick={() => void link.current?.send("READ\n")}>Read now</button>
      {reading ? <p>{reading}</p> : null}
    </>
  );
}
```

- `connectSerial`, `connectUsb` and `connectBluetooth` are in `lib/platform/hardware.ts`. All three give the same `DeviceLink`: `send`, `onData`, `onLine`, `close`.
- A device picker opens only from a click. Don't connect on page load.
- They work in Chrome and Edge on a computer or Android, not in Safari or on iPhone. `ConnectDevice` says so by itself. Keep the rest of the page working there, and say it on the page too.
- `connectUsb` needs `filters` with the device's vendor id. `connectBluetooth` needs the service's UUID and the characteristics to use. Prefer serial when the device offers it: most do.

## Board tools

Only when the brief says `boardTools`. Server only: a route handler, with the request passed in.

```ts
import { readSensor, showText, isBoardOffline } from "@/lib/platform/board";

const { sensors } = await readSensor({ request }); // [{ name, kind, value, unit }]
await showText("Back in 5 minutes", { request });  // up to 200 characters, 6 a minute
```

Live, the board's owner has to link a board to this product, and only the owner reaches it until they open it to visitors. Anything else throws, and `isBoardOffline(err)` is true: show "The board isn't available right now" and keep going. A board does nothing else for a product and never runs commands.

## During the build

Nothing real is connected:

- A simulated port stands in for the browser links.
- The gateway answers board tools from a simulated board: one sensor, `board-temp`, at 41.5 C, and `showText` returns what it was given.

Don't show the word "simulated". The live product gets the real device.

## The smoke test

```ts
import { checkBoardTool, checkDeviceLink, useFakeDevices } from "./caps/hardware";

await useFakeDevices(page, { reply: "TEMP 21.4\n" }); // before page.goto
await page.goto("/");
await checkDeviceLink(page, {
  link: "serial",
  connect: (p) => p.getByRole("button", { name: "Connect the thermometer" }).click(),
  exchange: (p) => p.getByRole("button", { name: "Read now" }).click(),
  shows: "21.4",
  shot: "02-reading",
});

await checkBoardTool(page, {
  run: (p) => p.getByRole("button", { name: "Read the board" }).click(),
  shows: "41.5",
  shot: "03-board",
});
```

One link session and one call of each board tool is enough. The first checks the simulated port got the bytes your product sent and that the product showed the reply. The second is confirmed by the gateway's own record.
