/**
 * Calls a real board through Muse Muse's own client: lists its tools, reads its hardware, and takes one photo.
 * Needs DEVICE_MCP_URL and DEVICE_MCP_TOKEN.
 *
 *   npx tsx --env-file=.env.local scripts/dev/device-check.ts [photo-path]
 */
import { writeFileSync } from "node:fs";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";

const config = deviceConfig();
if (!config) throw new Error("Set DEVICE_MCP_URL and DEVICE_MCP_TOKEN.");

console.log("tools:", (await listDeviceTools(config)).map((tool) => tool.name).join(", "));

const profile = await callDeviceTool(config, "describe_device", {});
const { model, cameras, microphones } = JSON.parse((profile.content[0] as { text: string }).text);
console.log({ model, cameras, microphones });

const photo = await callDeviceTool(config, "capture_image", {});
const part = photo.content[0] as { data: string; mimeType: string };
const jpeg = Buffer.from(part.data, "base64");
console.log(`photo: ${part.mimeType}, ${jpeg.length} bytes, isError=${photo.isError}`);
if (process.argv[2]) writeFileSync(process.argv[2], jpeg);
