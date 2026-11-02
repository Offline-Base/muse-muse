/**
 * Each way Muse Muse reaches a model on hardware, and who can read the text on the way. Muse Privacy on a person's own laptop
 * is the only private path. A board or the fleet can keep text from a cloud model, unless a fleet combo model sends it to one,
 * but not from the servers and networks it passes through.
 *
 * Data only, with no imports: privacy/ shares no code with the platform (lib/__tests__/privacy-boundary.test.ts), so its row
 * is read from its docs by hand. lib/__tests__/reach-claims.test.ts holds the copy to this table, and docs/GADGETS.md shows it.
 */

/**
 * The trust words in docs/OFFLINE.md, section 3, with one stretch that docs/GADGETS.md states too: `home` is the owner's own
 * device, even when a hosted site reaches it at a public address over the internet.
 */
export type ReachTier = "this-machine" | "home" | "shared";

export interface ReachRow {
  id: "muse-privacy" | "paired-board" | "fleet-gateway" | "board-tools";
  name: string;
  /** The code this row describes: a path in this repo, or `jetson-infra:` and a path in that one. */
  code: readonly string[];
  tier: ReachTier;
  private: boolean;
  whoCanRead: string;
  /** The one sentence a product may show. */
  sentence: string;
  /** What runs today, as of Nov 2. Not for a product's copy. */
  today: string;
}

export const REACH: readonly ReachRow[] = [
  {
    id: "muse-privacy",
    name: "Muse Privacy on your own laptop",
    code: ["privacy/docs/THREAT_MODEL.md", "privacy/base/egress.py", "privacy/relay/src"],
    tier: "this-machine",
    private: true,
    // THREAT_MODEL.md rows R and A2, and "The relay sees what Muse sees" under residual risk.
    whoCanRead:
      "Nobody off the laptop reads the original documents or the tag map. Muse and the relay see tagged text, summaries and Muse's own requests, including any name typed into Muse, and a tagged result can be a document's own text with only the names swapped. Cloudflare ends TLS at the relay, so the relay isn't end-to-end encrypted. Tagging can miss a name, and what you type into Muse reaches Meta first.",
    sentence:
      "Your original documents and tag map stay on your laptop, but Muse and its relay on Cloudflare see their text with names tagged, summaries and Muse's requests, including any name you type into Muse, and tagging can miss a name.",
    today: "Runs on a laptop. The Jetson version is designed and simulated only, and has never run on a board.",
  },
  {
    id: "paired-board",
    name: "A product using a paired board",
    code: ["lib/caps/hardware/board.ts", "lib/gateway/gadget-connect.ts", "lib/gateway/gadget.ts", "template/caps/hardware/files/lib/platform/board.ts"],
    tier: "home",
    private: false,
    whoCanRead:
      "The product's server, Muse Muse and the board, over a public https address on a hosted site, for what goes to the board and what comes back, photos and recordings included. A board added by address has no pin, so it can sit behind a tunnel that ends TLS, which can read it too: ask_board refuses such a board, but show_text and the media tools still reach it.",
    sentence:
      "This product's server and Muse Muse can read what goes to the owner's board and what comes back, photos and recordings included, and so can a tunnel in front of it if the owner added the board by address.",
    today: "Not live: GADGET_CONNECT was unset in production on Nov 2 (docs/BUILD_LOG.md), and this path has not run on real hardware.",
  },
  {
    id: "fleet-gateway",
    name: "The fleet gateway",
    code: [
      "lib/board-loop/fleet.ts",
      "jetson-infra:docs/serving-over-ngrok.md",
      "jetson-infra:scripts/fleet-up.sh",
      "jetson-infra:control-plane/jetson_cp/hub.py",
      "jetson-infra:control-plane/jetson_cp/llm.py",
    ],
    tier: "shared",
    private: false,
    whoCanRead:
      "The product's server, ngrok, which ends TLS, the lead board and the board that answers, plus Muse Muse when the call goes through it. Called at offlinebase.com/admin rather than the ngrok address, a Vercel rewrite in another project ends TLS first. From the lead board to another board the chat may cross the office network unencrypted: fleet-up.sh enrolls boards over http on the LAN, and whether a given board uses the tunnel instead isn't known. A combo model can send the whole chat to its cloud provider, OpenRouter or Vercel AI Gateway, and by default does for any chat its router doesn't find plainly simple. The gateway's request log holds metadata. ngrok's inspector runs on port 4040 of the lead board (fleet-up.sh reads it), and a Nov 2 report, not reproduced, said it held the last 50 requests with raw bodies in memory.",
    sentence:
      "This product's server, ngrok and the fleet's boards can read your text, and so may anyone on the office network between boards, a combo model's cloud provider, and Muse Muse or Vercel when the call goes through them.",
    today: "The fleet serves through ngrok. In this repo only the board loop calls its chat route (BOARD_LOOP_TARGET=fleet), and no product route forwards a chat to it.",
  },
  {
    id: "board-tools",
    name: "Board tools through the fleet's /device route",
    code: [
      "lib/device/client.ts",
      "lib/gateway/gadget.ts",
      "lib/device/agent.ts",
      "app/api/device/ask/route.ts",
      "muse-device/autostart.sh",
      "jetson-infra:control-plane/jetson_cp/routes/device.py",
    ],
    tier: "shared",
    private: false,
    whoCanRead:
      "Muse Muse, ngrok, which ends TLS, the lead board and the board, plus the product's server when a product made the call, for what goes to the tools and what comes back, photos and recordings included. From the lead board to another board it's plain http on the office network, token included, so anyone on that network can read it. ngrok's inspector on port 4040 of the lead board sits in front of this route too, so it may hold the board's bearer token, which opens every tool on it, and the photos and recordings in memory. Meta's model reads tool results when an admin asks on Muse Muse's admin page /device (/api/device/ask).",
    sentence:
      "This product's server, Muse Muse, ngrok and the fleet's lead board can read what goes to and comes back from a board's tools, including photos and recordings, and it crosses the office network as plain http.",
    today: "A real board answered through Muse Muse's client on Nov 2 (docs/BUILD_LOG.md), but not from a live product: DEVICE_MCP_URL isn't set in production. The route merged into jetson-infra on Nov 2.",
  },
];
