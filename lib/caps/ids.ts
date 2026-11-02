/**
 * Wave 3 caps (docs/CAPABILITIES.md, section 2.1): platform services a brief can ask for. A plain constant file with no
 * imports, so lib/env.ts can read it without an import cycle. Unit 2 created it with every line below. Each unit then
 * changes only its own CAP_READY line, in the merge that makes its cap work.
 */
export const CAP_IDS = ["data", "files", "connect", "jobs", "live", "media", "code", "runtime", "hardware", "extension", "games", "platform"] as const;
export type CapId = (typeof CAP_IDS)[number];
export const CAP_UNIT: Record<CapId, number> = { data: 3, files: 4, connect: 5, jobs: 6, live: 7, media: 8, code: 9, runtime: 10, hardware: 13, extension: 14, games: 14, platform: 15 };
/** The flag that lets the brief writer pick the cap and turns its routes on. */
export const CAP_FLAG: Record<CapId, string> = {
  data: "DATA_ENABLED", files: "FILES_ENABLED", connect: "CONNECT_ENABLED", jobs: "JOBS_ENABLED", live: "LIVE_ENABLED",
  media: "MEDIA_ENABLED", code: "CODE_ENABLED", runtime: "RUNTIME_ENABLED", hardware: "HARDWARE_ENABLED",
  extension: "NATIVE_EXTENSION", games: "NATIVE_GAME_ENGINES", platform: "PLATFORM_POWERS",
};
/** False until the unit merges with its routes, overlay and checks. One line per cap, so merges never collide. */
export const CAP_READY: Record<CapId, boolean> = {
  data: true,
  files: true,
  connect: true,
  jobs: true,
  live: true,
  media: true,
  code: true,
  runtime: true,
  hardware: true,
  extension: true,
  games: true,
  platform: true,
};
/** Products with this cap need a signed-in builder (unit 1). Stateless caps stay open to guests. */
export const CAP_NEEDS_BUILDER: Record<CapId, boolean> = {
  data: true, files: true, connect: true, jobs: true, live: false, media: false, code: true, runtime: true,
  hardware: true, extension: false, games: false, platform: true,
};
export const capMarker = (id: CapId) => `cap:${id}`;

/** True for a string that names a cap. */
export function isCapId(value: unknown): value is CapId {
  return typeof value === "string" && (CAP_IDS as readonly string[]).includes(value);
}
