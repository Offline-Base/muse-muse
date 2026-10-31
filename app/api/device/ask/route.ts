import OpenAI from "openai";
import { requireAdminOrAutomation } from "@/lib/auth";
import { runDeviceAgent } from "@/lib/device/agent";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { DEFAULT_PLATFORM_MODEL } from "@/lib/env";
import { badRequest, errorJson, readJson, route } from "@/lib/http";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { spendPaused } from "@/lib/quota";
import { recordUsage } from "@/lib/usage";

// Several model calls, each with a photo or a recording of up to 30 seconds on the board.
export const maxDuration = 300;

const MAX_PROMPT_CHARS = 2000;

/**
 * POST {prompt} -> {answer, steps}: Muse Wonder answers using the board's tools. Admins only, since it uses a real camera
 * and microphone and spends model credits. 503 device_not_configured or paused, 502 device_unavailable or
 * model_unavailable.
 */
export const POST = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const body = await readJson(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw badRequest("Ask something.");
  if (prompt.length > MAX_PROMPT_CHARS) throw badRequest(`Keep it under ${MAX_PROMPT_CHARS} characters.`);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const model = DEFAULT_PLATFORM_MODEL;
  try {
    return Response.json(
      await runDeviceAgent(prompt, {
        model,
        respond: async (params) => {
          const res = await metaPlatform().responses.create(params);
          await recordUsage({ source: "platform", endpoint: "device_ask" }, [fromResponsesUsage(model, res.usage)]);
          return res;
        },
        listTools: () => listDeviceTools(config),
        callTool: (name, args) => callDeviceTool(config, name, args),
      }),
    );
  } catch (err) {
    // Why goes to the log. The board's address and token never go in a reply.
    console.error("[device]", err instanceof Error ? err.message : err);
    return errorJson(502, err instanceof OpenAI.APIError ? "model_unavailable" : "device_unavailable");
  }
});
