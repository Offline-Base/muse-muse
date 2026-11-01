---
name: muse-hardware
description: Use only when the brief has a hardware block. A page that talks to a device over Web Serial, WebUSB or Web Bluetooth, a product's server that reads a board's sensors or shows text on it, and an owner putting the product's own tuned model on a USB drive.
---

# Devices

Separate things. A brief may ask for any of them.

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
- If another site frames the product and doesn't allow devices, `ConnectDevice` says to open it in its own tab, with a link. If you call `connectSerial` yourself, show `err.message` from `HardwareError`.
- `connectUsb` needs `filters` with the device's vendor id. `connectBluetooth` needs the service's UUID and the characteristics to use. Prefer serial when the device offers it: most do.

## Board tools

Only when the brief says `boardTools`. Server only: a route handler, with the request passed in. Every helper needs it, and without it a live board refuses the owner, though the build's simulated board doesn't notice.

```ts
import { boardMessage, readSensor, showText } from "@/lib/platform/board";

export async function GET(request: Request) {
  try {
    const { sensors } = await readSensor({ request }); // [{ name, kind, value, unit }]
    await showText("Back in 5 minutes", { request });  // up to 200 characters, 6 a minute
    return Response.json({ sensors });
  } catch (err) {
    const message = boardMessage(err);
    if (message) return Response.json({ message }, { status: 503 });
    throw err;
  }
}
```

Live, the board's owner has to link a board to this product, and only the owner reaches it until they open it to visitors. Anything else throws. `boardMessage(err)` gives the line to show for every way a board can say no: no board for this person, too many calls, no such sensor. `isBoardOffline(err)` is true for the first of those. Keep the rest of the product working.

The owner gets their pass from `Open as owner` on the product's Muse Muse page, which opens the product in its own tab. Inside the frame on that page the pass isn't sent, so the board looks offline there. When a board is offline, say "If you own this product, use Open as owner on its Muse Muse page."

A board does only this for a product, and never runs commands. Its camera and microphone need the brief to list `muse-gadget` too. Then, where the owner should reach them, use `boardPhoto({ request })` and `boardSound({ seconds, request })` from `lib/platform/board.ts` rather than `takePhoto` and `recordSound`, which don't send the owner's pass.

## Drive export

Only when the brief says `driveExport`. The product's owner puts the product's own tuned model on a USB drive plugged into their own board. Server only: route handlers, with the request passed in. Only the owner ever gets through. Visitors never do, even on a board its owner opened to visitors, so show this only to the owner, and give everyone else the rest of the product.

A model from "Train on my data" can't go on a drive today: it stays private, so it has no files a board can fetch, and `exportToDrive` answers `own_model_not_ready`. Show that sentence as it is, and never promise an export for such a model.

To tell who the owner is, see whether `driveStatus` answers. Don't check for a cookie: the build's simulated owner has no cookie, so the button would be missing in the smoke test.

The owner gets their pass from `Open as owner` on the product's Muse Muse page, which opens the product in its own tab. Inside the frame on that page the pass isn't sent, so the board looks offline there. When `isBoardOffline(err)` is true, say "If you own this product, use Open as owner on its Muse Muse page."

Two steps, and the person has to do the second one. The first call starts nothing:

```ts
import { boardMessage, driveStatus, exportToDrive } from "@/lib/platform/board";

export async function POST(request: Request) {
  const { approval } = (await request.json()) as { approval?: string };
  try {
    return Response.json(await exportToDrive({ approval, request }));
  } catch (err) {
    const message = boardMessage(err);
    if (message) return Response.json({ message }, { status: 503 });
    throw err;
  }
}

export async function GET(request: Request) {
  try {
    return Response.json(await driveStatus({ request }));
  } catch (err) {
    const message = boardMessage(err);
    if (message) return Response.json({ message }, { status: 503 });
    throw err;
  }
}
```

- `needs_confirmation`: show `approval.title` and every line of `approval.lines`, in full, on a card with Confirm and Cancel. Send `approval.id` back only from the Confirm click. Never send it by yourself: the card is the only proof a person agreed, and the gateway can't check that for you. The lines name the model, the drive and the Usage Policy's points, so don't shorten them. With `stale: true`, something changed, so show the new card.
- `ok: true`: it has started. Poll `driveStatus` every 10 seconds at most. `export.state` ends in `done`, `failed` or `stopped`, and `done` with `result: "PASS"` means it's safe to unplug. Show `message`, and the progress from `done_bytes` and `total_bytes`.
- `needs_erase`: show `message`. A product can never erase or format a drive. The owner confirms that on their board's page.
- The drive has to be plugged in first. An export from a product never waits for one, so say "Plug the drive into your board, then press Export." `boardMessage(err)` has the line for no drive, more than one drive, an export already going, and a model that isn't ready.

There is nothing to choose: `exportToDrive` always means this product's own model, and takes no link, file or drive. A product can't stop an export or send another product's model.

## During the build

Nothing real is connected:

- A simulated port stands in for the browser links.
- The gateway answers board tools from a simulated board: one sensor, `board-temp`, at 41.5 C, and `showText` returns what it was given.
- The gateway answers the drive tools from a simulated stick, for a simulated owner. `exportToDrive` still asks first, and a confirmed export ends in `done` with `PASS` after about 8 seconds.

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

For drive export, once, with `start` opening the card and `confirm` pressing Confirm on it. `shows` is what the product shows once it's done:

```ts
import { checkDriveExport } from "./caps/hardware";

await checkDriveExport(page, {
  start: (p) => p.getByRole("button", { name: "Export to my drive" }).click(),
  confirm: (p) => p.getByRole("button", { name: "Confirm" }).click(),
  shows: "Safe to unplug",
  shot: "04-drive",
});
```

One link session and one call of each board tool is enough. The first checks the simulated port got the bytes your product sent and that the product showed the reply. The second is confirmed by the gateway's own record.

## The model on the owner's board (askBoard)

`askBoard(messages, { request })` runs on the model on the owner's paired board: one-bit Muse Glimmer on a Jetson Orin Nano, a small Llama on anything else. The platform picks it from the board's kind. Nothing goes to a cloud model, so it suits private data. It can take over a minute, so show progress and which model answered (`target`).

When the board is off it throws. `askBoardOrMessage` gives `{ ok: false, message }` instead: show that line and keep the rest of the product working. Don't fall back to a cloud model on your own: the person chose their board for a reason, so ask them first.

During the build, a fixed rule stands in for the model and its answers start with `[simulated ...]`. Test that your screen shows the answer, not what the answer says.

## A robot (robotStatus, requestRobotAction, hardStop)

Only for a brief that asks, and only on a simulated board for now. A real board refuses.

- `ROBOT_ACTIONS` is everything there is, with its limits. Anything else is refused on the platform and again on the board.
- The owner confirms every action. `requestRobotAction` never acts on the first call. Live, it answers with `confirmUrl`: open it in its own tab, where the owner says yes on Muse Muse. During the build it answers with `approval`: show the card, and call again with `approval.id` only from the person's own click.
- `hardStop` needs no confirmation and stays on until the owner clears it. Keep a hard stop button on every screen where something can move.
- Say "simulated" wherever `simulated: true`.
