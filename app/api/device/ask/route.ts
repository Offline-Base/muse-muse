import OpenAI from "openai";
import { requireAdminOrAutomation } from "@/lib/auth";
import { ASKS_PER_MINUTE, runDeviceAgent } from "@/lib/device/agent";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { cachedFleetBoards, fleetAsk, fleetConfigured } from "@/lib/device/fleet";
import { DEFAULT_PLATFORM_MODEL, env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { badRequest, errorJson, readJson, route } from "@/lib/http";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { spendPaused } from "@/lib/quota";
import { recordUsage } from "@/lib/usage";

// Several model calls, each with a photo or a recording of up to 30 seconds on the board.
export const maxDuration = 300;

const MAX_PROMPT_CHARS = 2000;
const MINUTE_MS = 60_000;

/** The daily spend cap was reached partway through a question. */
class PausedError extends Error {}

/**
 * POST {prompt} -> {answer, steps}: Muse Wonder answers using the board's tools and, when it's set up, the fleet's read-only
 * tools. Either is enough. Admins only, since it uses a real camera and microphone and spends model credits. 503
 * device_not_configured (neither is set up) or paused, 429 rate_limited, 502 device_unavailable or model_unavailable.
 */
export const POST = route(async (req: Request) => {
  const user = await requireAdminOrAutomation(req);
  const body = await readJson(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw badRequest("Ask something.");
  if (prompt.length > MAX_PROMPT_CHARS) throw badRequest(`Keep it under ${MAX_PROMPT_CHARS} characters.`);
  const config = deviceConfig();
  // OPEN_ACCESS=admin on a preview acts as an admin for anyone who opens it, and these use the fleet's token.
  const fleet = fleetConfigured() && !user.openAccess;
  if (!config && !fleet) return errorJson(503, "device_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");
  const key = `device:ask:${user.id}`;
  const counts = await hitRateLimits([key], new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS));
  if ((counts[key] ?? 0) > ASKS_PER_MINUTE) return errorJson(429, "rate_limited");

  // Muse Wonder under BUILDS_ON_CONTRIBUTOR too, the owner's exception: a board's camera and microphone carry personal information, which can't go to Contributor.
  const model = DEFAULT_PLATFORM_MODEL;
  try {
    return Response.json(
      await runDeviceAgent(prompt, {
        model,
        respond: async (params) => {
          if (await spendPaused()) throw new PausedError();
          const res = await metaPlatform().responses.create(params);
          await recordUsage({ source: "platform", endpoint: "device_ask" }, [fromResponsesUsage(model, res.usage)]);
          return res;
        },
        listTools: async () => (config ? listDeviceTools(config) : []),
        callTool: async (name, args) =>
          config ? callDeviceTool(config, name, args) : { content: [{ type: "text", text: `No board is set up, so ${name} didn't run.` }], isError: true },
        llamaTraining: env.deviceLlamaTraining,
        ...(fleet ? { fleet: { boards: () => cachedFleetBoards(), ask: (input) => fleetAsk(input) } } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof PausedError) return errorJson(503, "paused");
    // Why goes to the log. The board's address and token never go in a reply.
    console.error("[device]", err instanceof Error ? err.message : err);
    return errorJson(502, err instanceof OpenAI.APIError ? "model_unavailable" : "device_unavailable");
  }
});
