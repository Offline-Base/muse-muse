import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { CALL_SERVICE_IDS, PUBLIC_APIS, SEND_CHANNELS_LIVE, SERVICES } from "@/lib/caps/connect/allowlist";
import { connectOptions } from "@/lib/caps/connect/flags";

/** The brief writer's catalog section for the connect cap (docs/CAPABILITIES.md, section 11), read per call. */
export const CONNECT_CATALOG: CapCatalogEntry = {
  name: "keyless public APIs",
  get block() {
    const opts = connectOptions();
    const apis = Object.values(PUBLIC_APIS)
      .map((a) => `${a.id} (${a.label})`)
      .join("; ");
    const lines = [
      `- connect (Outside services): a product can read these keyless public APIs through the platform, cached, with no key: ${apis}. Pick the ones the muse needs. Their answers are public facts, and a product shows where each came from. Other APIs aren't reachable.`,
    ];
    if (opts.vault) {
      lines.push(
        `  It can also call ${CALL_SERVICE_IDS.map((id) => SERVICES[id]!.label).join(", ")} with the product owner's own key, which the owner types into the product's key settings. The platform keeps the key and adds it to each call; the product's code never sees it. Services not listed here aren't available.`,
      );
    }
    if (opts.sends) {
      const what = SEND_CHANNELS_LIVE.map((c) => (c === "chat" ? "a message to the owner's Slack channel" : "an email from the owner's own domain"));
      lines.push(`  It can send ${what.join(" or ")} with the owner's own account, after the owner confirms that one message. Up to 10 a day and 5 recipients each. No SMS, social posts or payments.`);
    }
    return lines.join("\n");
  },
};
