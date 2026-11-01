import type { CapRenderEntry } from "@/lib/caps/render";
import { PUBLIC_APIS, SERVICES } from "@/lib/caps/connect/allowlist";
import { connectBlock, connectBuildBlock, connectDroppedNote, type ConnectBrief } from "@/lib/caps/connect/brief";

/**
 * The connect cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 11). Its text names the platform files in
 * template/caps/connect: lib/platform/fetch-public.ts, secrets.ts and send.ts, components/platform/KeySettings.tsx and
 * ConfirmSend.tsx, the routes under app/api/musemuse/connect-*, tests/caps/connect.ts and the muse-connect skill.
 *
 * Every entry works from connectBuildBlock: keys and sends the stored brief has but the flags now leave out are never
 * asked for, the same way the gateway's rules, the judge and verify's record leave them out.
 */

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function apis(block: ConnectBrief) {
  return block.publicApis.flatMap((id) => (Object.hasOwn(PUBLIC_APIS, id) ? [PUBLIC_APIS[id]!] : []));
}
function keys(block: ConnectBrief) {
  return block.keys.filter((k) => Object.hasOwn(SERVICES, k.service) && SERVICES[k.service]!.calls.length);
}
function sends(block: ConnectBrief) {
  return block.sends.filter((s) => s.channel === "email" || s.channel === "chat");
}

function manifestLine(block: ConnectBrief): string {
  const connect = { publicApis: apis(block).map((a) => a.id), keys: keys(block).map((k) => k.service), sends: sends(block).map((s) => s.channel) };
  return `- \`musemuse.json\` gets \`"caps": ["connect"]\` and \`"connect": ${JSON.stringify(connect)}\`, exactly these. Verify checks it against this section.`;
}

export const CONNECT_RENDER: CapRenderEntry = {
  title: "Outside services",
  build(brief) {
    const block = connectBuildBlock(brief);
    if (!block) return [];
    const dropped = connectDroppedNote(connectBlock(brief), block);
    if (dropped) console.log(dropped);
    if (!apis(block).length && !keys(block).length && !sends(block).length) {
      return [
        "The brief asked for outside services that are switched off on Muse Muse right now, so this product uses none. Build the rest of it without them, and say in BUILD_NOTES.md what it would have done.",
        "",
        manifestLine(block),
        "- Never put a key, a token or a webhook address in code, a page, a log or an error message.",
      ];
    }
    const lines: string[] = ["The brief asks for outside services through the platform:", ""];
    if (apis(block).length) {
      lines.push("| Public API | What it gives | Paths | Show this credit |", "|---|---|---|---|");
      for (const a of apis(block)) lines.push(`| \`${a.id}\` | ${cell(a.label)} | ${a.paths.map((p) => `\`${p.path}\`: ${cell(p.does)}`).join("<br>")} | ${cell(a.attribution)} |`);
      lines.push("");
    }
    if (keys(block).length) {
      lines.push("| Owner's key for | Why | Calls it may make |", "|---|---|---|");
      for (const k of keys(block)) {
        const s = SERVICES[k.service]!;
        lines.push(`| \`${s.id}\` (${cell(s.label)}) | ${cell(k.why)} | ${s.calls.map((c) => `\`${c.method} ${c.path}\``).join(", ")}${s.visitors ? "" : " (owner only)"} |`);
      }
      lines.push("");
    }
    if (sends(block).length) {
      lines.push("| Sends | Why |", "|---|---|");
      for (const s of sends(block)) lines.push(`| ${s.channel === "email" ? "email (the owner's Resend key)" : "chat (the owner's Slack webhook)"} | ${cell(s.why)} |`);
      lines.push("");
    }
    lines.push("- Read `.agents/skills/muse-connect/SKILL.md` first. It has the helper calls, every rule below and the test helpers.");
    if (apis(block).length) {
      lines.push(
        "- Public APIs: on the server only, `fetchPublic(request, { api, path, query })` from `lib/platform/fetch-public.ts` gives `{ status, data, cached }`. `path` is one of the paths above with its values filled in, and `query` holds only the parameters the skill lists for that path. Anything else is refused. Show each API's credit line next to what it gave.",
      );
    }
    if (keys(block).length) {
      lines.push(
        "- Owner's keys: put `<KeySettings keys={await secrets(await headers()).list()} returnTo=\"/settings\" status={(await searchParams).key ?? null} />` from `components/platform/KeySettings.tsx` on a settings page only the owner opens, as the skill shows (the services come with the list, and `status` is the `key` search parameter the form comes back with); it saves a key through the platform and never shows it again. Call the service on the server with `secrets(request).call(\"<service>\", { method, path, body })` from `lib/platform/secrets.ts`, which gives `{ status, data }`. The platform adds the key; the product's code never has it, and nothing may ask for a key anywhere else. With no key saved, a call throws `CapError` with code `needs_key`: show the owner where to add it.",
      );
    }
    if (sends(block).length) {
      lines.push(
        "- Sends: on the server, `send(request, { channel, to, subject, body })` from `lib/platform/send.ts` first gives `{ status: \"needs_confirmation\", confirmation }` and sends nothing. Render `<ConfirmSend confirmation={confirmation} />` from `components/platform/ConfirmSend.tsx`: the owner reads the exact message and presses Confirm, which sends it once. Changing a word needs a new confirmation. Only the owner can send. At most 5 recipients a message and 10 messages a day.",
      );
    }
    lines.push(
      manifestLine(block),
      "- Never put a key, a token or a webhook address in code, a page, a log or an error message.",
      "- In this build every outside answer is a recorded sample: public APIs give a real answer recorded on Oct 31, a service call gives a made-up sample in the service's shape, and a confirmed send says `simulated: true` and goes nowhere. Show samples as they come; never write a test that expects a sample's exact words.",
    );
    if (apis(block).length) {
      lines.push("- Smoke test: one public API call shown on screen, then `checkFetchShown(page, (fetched) => <text from it>)` from `tests/caps/connect.ts`, which records the check from what the server really got.");
    }
    if (keys(block).length) lines.push("- Smoke test: `saveTestKey(page, \"<service>\")` once, on the settings screen, after `openAsOwner(page)`. It types a made-up key; verify then checks that no page or file shows it.");
    if (sends(block).length) lines.push("- Smoke test: one send, then `confirmSend(page)`, which presses Confirm and waits for \"Sent (sample)\". Keep it to one confirmed send.");
    lines.push(
      "- `template/AGENTS.md` says the build machine can reach only npm, the Meta API and the Muse Muse gateway. That still holds: every outside call goes through the gateway, which answers this build with samples.",
      "- `lib/platform/fetch-public.ts`, `lib/platform/secrets.ts`, `lib/platform/send.ts`, `lib/platform/connect.ts`, `components/platform/KeySettings.tsx`, `components/platform/ConfirmSend.tsx`, the routes in `app/api/musemuse/connect-keys` and `app/api/musemuse/connect-send`, and `tests/caps/connect.ts` are platform files. Wrap them, never edit them.",
    );
    return lines;
  },
  refine(brief) {
    const block = connectBuildBlock(brief);
    if (!block) return [];
    const parts = [
      apis(block).length ? `public APIs ${apis(block).map((a) => `\`${a.id}\``).join(", ")} with \`fetchPublic\`` : null,
      keys(block).length ? `the owner's keys for ${keys(block).map((k) => `\`${k.service}\``).join(", ")} with \`secrets(request).call\`` : null,
      sends(block).length ? `confirmed ${sends(block).map((s) => s.channel).join(" and ")} sends with \`send\` and \`ConfirmSend\`` : null,
    ].filter(Boolean);
    return [`- It reaches outside services through the platform: ${parts.join("; ")} (\`.agents/skills/muse-connect/SKILL.md\`). Keep them, keep \`musemuse.json\`'s \`connect\` block in step, and never put a key in code.`];
  },
  markdown(brief) {
    const block = connectBuildBlock(brief);
    if (!block) return [];
    return [
      ...(apis(block).length ? [`Public APIs: ${apis(block).map((a) => a.label).join(", ")}.`] : []),
      ...(keys(block).length ? [`Owner's keys: ${keys(block).map((k) => `${SERVICES[k.service]!.label} (${k.why})`).join("; ")}.`] : []),
      ...(sends(block).length ? [`Sends, each confirmed by the owner: ${sends(block).map((s) => `${s.channel} (${s.why})`).join("; ")}.`] : []),
    ];
  },
};
