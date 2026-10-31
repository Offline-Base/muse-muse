import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Calls the tools of one physical board over MCP (muse-device/server.py). DEVICE_MCP_TOKEN opens the board's camera and
 * microphone, so it stays on the server: it is read inside each call, and never logged or sent to a browser.
 */
export interface DeviceConfig {
  url: string;
  token: string;
}

export interface DeviceTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface DeviceToolResult {
  content: unknown[];
  isError: boolean;
}

/** Whether the token can travel to this address: over https, or over http only when it stays on this machine. */
function safeAddress(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" || (protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
}

/** The board's address and token, or null when either is missing or the address would expose the token. */
export function deviceConfig(): DeviceConfig | null {
  const url = process.env.DEVICE_MCP_URL?.trim();
  // Trimmed: a pasted token often ends in a line break, which no header takes.
  const token = process.env.DEVICE_MCP_TOKEN?.trim();
  if (!url || !token) return null;
  if (!safeAddress(url)) {
    console.error("[device] DEVICE_MCP_URL isn't https, so the board stays off.");
    return null;
  }
  return { url, token };
}

/**
 * Tools that wait on the board for longer than the SDK's 60-second default: each is the board's own limit (server.py) plus
 * the trip there, and all fit the 300 seconds a route has. Giving up sooner would leave the board working on a call
 * nobody is waiting for.
 */
const SLOW_TOOL_TIMEOUT_MS: Record<string, number> = { start_model: 150_000, ask_model: 250_000, install_model: 290_000 };

async function withDevice<T>(config: DeviceConfig, doFetch: typeof fetch, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "muse-muse", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: doFetch,
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

export function listDeviceTools(config: DeviceConfig, doFetch: typeof fetch = fetch): Promise<DeviceTool[]> {
  return withDevice(config, doFetch, async (client) => {
    const { tools } = await client.listTools();
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  });
}

/** One tool call. A failure the tool reports, like a missing camera, comes back with isError for the model to read. */
export function callDeviceTool(
  config: DeviceConfig,
  name: string,
  args: Record<string, unknown>,
  doFetch: typeof fetch = fetch,
): Promise<DeviceToolResult> {
  return withDevice(config, doFetch, async (client) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: SLOW_TOOL_TIMEOUT_MS[name] });
    return { content: result.content as unknown[], isError: result.isError === true };
  });
}
