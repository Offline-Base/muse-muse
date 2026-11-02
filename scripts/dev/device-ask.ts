/**
 * Asks Muse Wonder a question it answers with a real board's tools, printing each tool it used. Needs MODEL_API_KEY,
 * DEVICE_MCP_URL and DEVICE_MCP_TOKEN. Its spend isn't recorded in the usage table.
 *
 *   npx tsx --env-file=.env.local scripts/dev/device-ask.ts "What can you see right now?" [photo-path]
 */
import { writeFileSync } from "node:fs";
import { runDeviceAgent } from "@/lib/device/agent";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { contributorBuildsOn, DEFAULT_PLATFORM_MODEL } from "@/lib/env";
import { metaPlatform } from "@/lib/meta/platform";

const [prompt, photoPath] = process.argv.slice(2);
if (contributorBuildsOn()) throw new Error("Off while BUILDS_ON_CONTRIBUTOR is on: a board's camera and microphone can pick up personal information.");
if (contributorBuildsOn()) throw new Error("Off while BUILDS_ON_CONTRIBUTOR is on: a board's camera and microphone can pick up personal information.");
if (!prompt) throw new Error("Ask something.");
const config = deviceConfig();
if (!config) throw new Error("Set DEVICE_MCP_URL and DEVICE_MCP_TOKEN.");

const { answer, steps } = await runDeviceAgent(prompt, {
  model: DEFAULT_PLATFORM_MODEL,
  respond: (body) => metaPlatform().responses.create(body),
  listTools: () => listDeviceTools(config),
  callTool: (name, args) => callDeviceTool(config, name, args),
});

for (const step of steps) {
  console.log(`tool: ${step.tool} ${JSON.stringify(step.arguments)}${step.isError ? " (failed)" : ""}`);
  for (const part of step.content as Array<{ type: string; data?: string }>) {
    if (part.type === "image" && part.data && photoPath) writeFileSync(photoPath, Buffer.from(part.data, "base64"));
  }
}
console.log(`answer: ${answer}`);
