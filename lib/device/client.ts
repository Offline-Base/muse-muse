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

/** The board's address and token, or null when either is missing. */
export function deviceConfig(): DeviceConfig | null {
  const url = process.env.DEVICE_MCP_URL?.trim();
  // Trimmed: a pasted token often ends in a line break, which no header takes.
  const token = process.env.DEVICE_MCP_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

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
    const result = await client.callTool({ name, arguments: args });
    return { content: result.content as unknown[], isError: result.isError === true };
  });
}
