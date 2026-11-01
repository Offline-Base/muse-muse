// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for devices, each only when the brief asks for it (the gateway's record says):
//   link-sent    the simulated port got bytes the product sent (tests/caps/hardware.ts, checkDeviceLink)
//   link-reply   the product showed the device's reply
//   board-tool   a board tool call reached the simulated board, by the gateway's own record
//   board-limit  the smoke test stayed within its board calls
//   board-shown  the product showed the board's answer (checkBoardTool)
//   drive-tool   a confirmed export reached the simulated drive, by the gateway's own record
//   drive-shown  the product showed the finished export (checkDriveExport)
//
// What these rest on: board-tool and board-limit read the gateway's record, which product code can't write. The others read
// the smoke test's record, which a product test could write itself.

/** What a smoke test may call per verify: one of each, and a retry. */
const SMOKE_BOARD_CALLS = 4;

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);

export async function check({ record, proof }) {
  if (!proof) return [{ id: "gateway", ok: false, detail: "the gateway's record for devices is missing" }];
  const links = Number(proof["brief:links"] ?? 0) > 0;
  const boardTools = Number(proof["brief:boardTools"] ?? 0) > 0;
  const driveExport = Number(proof["brief:driveExport"] ?? 0) > 0;
  if (!links && !boardTools && !driveExport) return [{ id: "brief", ok: false, detail: "the gateway's record says this brief has neither device links nor board tools" }];
  const out = [];
  if (links) {
    for (const [id, missing] of [["link-sent", "the smoke test didn't run checkDeviceLink"], ["link-reply", "the smoke test didn't run checkDeviceLink"]]) {
      const seen = recorded(record, id);
      out.push({ id, ok: seen?.ok === true, detail: seen?.detail ?? missing });
    }
  }
  if (boardTools) {
    const calls = Number(proof.read_sensor ?? 0) + Number(proof.show_text ?? 0);
    out.push({ id: "board-tool", ok: calls > 0, detail: calls > 0 ? `the gateway saw ${calls} board tool call${calls === 1 ? "" : "s"} reach the simulated board` : "the gateway saw no board tool call in this verify" });
    out.push({ id: "board-limit", ok: calls <= SMOKE_BOARD_CALLS, detail: `the gateway saw ${calls} board tool calls in this verify, and the smoke test may use at most ${SMOKE_BOARD_CALLS}` });
    const shown = recorded(record, "board-shown");
    out.push({ id: "board-shown", ok: shown?.ok === true, detail: shown?.detail ?? "the smoke test didn't run checkBoardTool" });
  }
  if (driveExport) {
    const exports = Number(proof.export_to_drive ?? 0);
    out.push({ id: "drive-tool", ok: exports > 0, detail: exports > 0 ? `the gateway saw ${exports} confirmed export${exports === 1 ? "" : "s"} reach the simulated drive` : "the gateway saw no confirmed export in this verify" });
    const shown = recorded(record, "drive-shown");
    out.push({ id: "drive-shown", ok: shown?.ok === true, detail: shown?.detail ?? "the smoke test didn't run checkDriveExport" });
  }
  return out;
}
