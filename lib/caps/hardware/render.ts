import type { Brief } from "@/lib/brief/schema";
import { gadgetConnectUsable } from "@/lib/caps/hardware/flags";
import { hardwareBlock, type HardwareLink } from "@/lib/caps/hardware/brief";
import { SHOW_TEXT_MAX_CHARS, SHOW_TEXT_PER_MINUTE } from "@/lib/caps/hardware/limits";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The hardware cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 19). Its text names the platform files in
 * template/caps/hardware: the skill, lib/platform/hardware.ts, lib/platform/board.ts, components/platform/ConnectDevice.tsx
 * and tests/caps/hardware.ts.
 */

const LINK_NAME: Record<HardwareLink, string> = { serial: "Web Serial", usb: "WebUSB", bluetooth: "Web Bluetooth" };
const LINK_FN: Record<HardwareLink, string> = { serial: "connectSerial", usb: "connectUsb", bluetooth: "connectBluetooth" };

function linkList(links: readonly HardwareLink[]): string {
  return links.map((l) => LINK_NAME[l]).join(", ");
}

export const HARDWARE_RENDER: CapRenderEntry = {
  title: "Devices",
  build(brief) {
    const hw = hardwareBlock(brief);
    if (!hw) return [];
    const links = hw.links;
    return [
      `The brief asks for ${[links.length ? `browser links (${linkList(links)})` : "", hw.boardTools ? "board tools (read_sensor, show_text)" : "", hw.driveExport ? "drive export (drive_status, export_to_drive)" : ""].filter(Boolean).join(" and ")}: ${hw.why}`,
      "",
      "- Read `.agents/skills/muse-hardware/SKILL.md` first.",
      ...(links.length
        ? [
            `- Browser links: \`${links.map((l) => LINK_FN[l]).join("`, `")}\` in \`lib/platform/hardware.ts\` and the \`ConnectDevice\` button in \`components/platform/ConnectDevice.tsx\`. They run in the browser, in a client component, and only after a click: the browser refuses otherwise.`,
            "- Say on the screen that this works in Chrome and Edge on a computer or Android, not in Safari or on iPhone. `ConnectDevice` shows the plain message by itself where the browser can't. The rest of the product still works there.",
            "- Readings stay in the visitor's browser unless the brief says otherwise.",
          ]
        : []),
      ...(hw.boardTools
        ? [
            "- Board tools: `readSensor` and `showText` in `lib/platform/board.ts`. Server only: call them from a route handler and always pass the incoming request, so the owner's pass travels with it. The build's simulated board doesn't check this, and a live board refuses the owner without it.",
            `- \`showText\` takes up to ${SHOW_TEXT_MAX_CHARS} characters, ${SHOW_TEXT_PER_MINUTE} times a minute. A board does nothing else for a product and never runs commands.`,
            "- Live, a board reaches this product only after its owner links one, and only the owner until they open it to visitors. Otherwise the helpers throw: show `boardMessage(err)`, and keep the rest of the product working.",
          ]
        : []),
      ...(hw.boardTools || hw.driveExport
        ? ["- `Open as owner` on the product's Muse Muse page lands on `/api/musemuse/board/owner` in its own tab, which sets the owner's pass. The pass isn't sent inside the frame on that page, so when a board is offline, also say how the owner gets in."]
        : []),
      ...(hw.driveExport
        ? [
            "- Drive export: `driveStatus` and `exportToDrive` in `lib/platform/board.ts`. Server only, with the request passed in. Only the product's owner, on a board they linked, ever gets through. Visitors never do, even when the link is open to visitors, so offer it only to the owner. Tell who that is from whether `driveStatus` answers, not from a cookie check: the build's simulated owner has no cookie, so a cookie check would hide the button from the smoke test.",
            "- `exportToDrive` answers `needs_confirmation` first: show `approval.title` and every line of `approval.lines` on a card, and call it again with `approval.id` only after the person presses confirm. Never send the id by yourself.",
            "- It exports this product's own tuned model and nothing else. The drive has to be plugged in first, since an export from a product never waits for one. It never erases: when it answers `needs_erase`, show its message, which sends the person to their board's page.",
          ]
        : []),
      ...(hw.boardTools && gadgetConnectUsable()
        ? [
            "- The model on the owner's board: `askBoard` or `askBoardOrMessage` in `lib/platform/board.ts`. Server only, with the request passed in. Show which model answered (`target`), and that it's working, since a small board can take over a minute. When the reply says `simulated: true`, say on that same card that the answer is simulated, not from a model. When the board is off, show the message and keep the rest of the product working.",
            "- A robot, only if the brief asks: `robotStatus`, `requestRobotAction` and `hardStop` in `lib/platform/board.ts`. Only the actions in `ROBOT_ACTIONS` exist. Each is confirmed by the owner: never call `requestRobotAction` with an `approval` except from the person's own click on a card, and live, send them to `confirmUrl`. Put a hard stop button on every screen where something can move, and label readings from `simulated: true` as simulated.",
          ]
        : []),
      "- During the build nothing real is connected. A simulated port stands in for the browser links, and the gateway's simulated board answers the board tools, with `simulated: true`. Don't show the word \"simulated\": the live product gets the real device." + (hw.boardTools && gadgetConnectUsable() ? " The one exception is the board's model and robot, above, where `simulated: true` has to show." : ""),
      ...(links.length ? ["- Smoke test, one link session: call `useFakeDevices(page, { reply })` before `page.goto`, then `checkDeviceLink(page, { link, connect, exchange, shows, shot })` from `tests/caps/hardware.ts`. It checks that the simulated port got the bytes the product sent, and that the product showed the reply."] : []),
      ...(hw.driveExport ? ["- Smoke test, drive export: `checkDriveExport(page, { start, confirm, shows, shot })` from `tests/caps/hardware.ts`, once. The gateway's own record must show the confirmed export reached the simulated board."] : []),
      ...(hw.boardTools ? ["- Smoke test, board tools: `checkBoardTool(page, { run, shows, shot })` from `tests/caps/hardware.ts`, once. The gateway's own record must show the call reached the simulated board. Keep to one call of each tool."] : []),
      "- Every file named here, `tests/caps/hardware*.ts` and `scripts/caps/hardware.mjs` are platform files. Leave them as they are.",
    ];
  },
  refine(brief) {
    const hw = hardwareBlock(brief);
    if (!hw) return [];
    return [`- The product talks to devices (\`.agents/skills/muse-hardware/SKILL.md\`). Keep ${[hw.links.length ? "`checkDeviceLink`" : "", hw.boardTools ? "`checkBoardTool`" : "", hw.driveExport ? "`checkDriveExport`" : ""].filter(Boolean).join(" and ")} in the smoke test passing.`];
  },
  markdown(brief) {
    const hw = hardwareBlock(brief);
    if (!hw) return [];
    return [hw.why, "", ...(hw.links.length ? [`Browser links: ${linkList(hw.links)}. These work in Chrome and Edge on a computer or Android, after a click. Not in Safari or on iPhone.`] : []), ...(hw.boardTools ? ["Board tools: read a sensor and show short text on a board its owner links."] : []), ...(hw.driveExport ? ["Drive export: the owner puts this product's own tuned model on a USB drive in their board, confirming each time."] : [])];
  },
};
