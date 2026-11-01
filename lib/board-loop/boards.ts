/**
 * Which board a loop reaches. A real board's address and token come from the environment, inside each call, and stay on the
 * server: only the fleet control plane or a board's own MCP server, never SSH.
 */
import { deviceConfig } from "@/lib/device/client";
import { BoardOfflineError, type BoardDriver, type BoardKind } from "@/lib/board-loop/driver";
import { deviceMcpBoard } from "@/lib/board-loop/device-mcp";
import { fleetBoard, safeBoardUrl, type FleetConfig } from "@/lib/board-loop/fleet";
import { runningSimBoard, startSimBoard } from "@/lib/board-loop/sim";

/** The fleet's settings, or null when one is missing or the address would expose the token. */
export function fleetConfig(): FleetConfig | null {
  const url = process.env.BOARD_FLEET_URL?.trim();
  const token = process.env.BOARD_FLEET_TOKEN?.trim();
  const node = process.env.BOARD_FLEET_NODE?.trim();
  if (!url || !token || !node || !safeBoardUrl(url)) return null;
  return { url, token, node };
}

/** The board for a loop's own stages, starting a simulated one if it isn't running. */
export async function loopBoard(target: BoardKind): Promise<BoardDriver> {
  if (target === "simulated") return startSimBoard();
  if (target === "fleet") {
    const config = fleetConfig();
    if (!config) throw new BoardOfflineError("The fleet isn't set up: BOARD_FLEET_URL, BOARD_FLEET_TOKEN and BOARD_FLEET_NODE.");
    return fleetBoard(config);
  }
  const config = deviceConfig({ quiet: true });
  if (!config) throw new BoardOfflineError("No board is set up: DEVICE_MCP_URL and DEVICE_MCP_TOKEN.");
  return deviceMcpBoard(config);
}

/** The board for the try page: never starts anything, so a board that went away shows as offline. */
export async function tryBoard(target: BoardKind): Promise<BoardDriver | null> {
  if (target === "simulated") return runningSimBoard();
  return loopBoard(target).catch(() => null);
}
