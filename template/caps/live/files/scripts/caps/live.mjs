// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for live captions and updates, each only when the brief asks for it (the gateway's record says):
//   notice       the page said where the audio goes before the microphone started (tests/caps/live.ts)
//   chunks       at least two caption pieces with times came back from the fake microphone, and the gateway took them
//   chunk-limit  the smoke test stayed within its pieces
//   shown        the captions' words showed on the page
//   live-update  a change in one browser showed in a second within 5 seconds with no reload, and the gateway sent it
//                over a stream

/** What a smoke test's captions may use per verify (docs/CAPABILITIES.md, section 13). */
const SMOKE_CHUNKS = 6;

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);

export async function check({ record, proof }) {
  if (!proof) return [{ id: "gateway", ok: false, detail: "the gateway's record for live captions and updates is missing" }];
  const captions = Number(proof["brief:captions"] ?? 0) > 0;
  const updates = Number(proof["brief:updates"] ?? 0) > 0;
  if (!captions && !updates) return [{ id: "brief", ok: false, detail: "the gateway's record says this brief has neither captions nor updates" }];
  const out = [];
  if (captions) {
    const notice = recorded(record, "notice");
    out.push({ id: "notice", ok: notice?.ok === true, detail: notice?.detail ?? "the smoke test didn't run checkCaptions" });
    const pieces = recorded(record, "chunks");
    const seen = Number(proof.chunks ?? 0);
    out.push({
      id: "chunks",
      ok: pieces?.ok === true && seen >= 2,
      detail: pieces?.ok !== true ? (pieces?.detail ?? "the smoke test didn't run checkCaptions") : seen >= 2 ? pieces.detail : `the gateway took ${seen} caption piece${seen === 1 ? "" : "s"} in this verify, and needs at least 2`,
    });
    out.push({ id: "chunk-limit", ok: seen <= SMOKE_CHUNKS, detail: `the gateway took ${seen} caption pieces in this verify, and the smoke test may use at most ${SMOKE_CHUNKS}` });
    const shown = recorded(record, "shown");
    out.push({ id: "shown", ok: shown?.ok === true, detail: shown?.detail ?? "the smoke test didn't run checkCaptions" });
  }
  if (updates) {
    const update = recorded(record, "live-update");
    const streams = Number(proof.streams ?? 0);
    const events = Number(proof.events ?? 0);
    out.push({
      id: "live-update",
      ok: update?.ok === true && streams > 0 && events > 0,
      detail: update?.ok !== true ? (update?.detail ?? "the smoke test didn't run checkLiveUpdate") : streams > 0 && events > 0 ? update.detail : `the gateway opened ${streams} streams and sent ${events} changes in this verify, so the change didn't come over a stream`,
    });
  }
  return out;
}
