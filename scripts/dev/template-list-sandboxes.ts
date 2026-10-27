// Lists recent sandboxes and their status, to confirm test sandboxes were stopped.
import { Sandbox } from "@vercel/sandbox";
const res = await Sandbox.list({ limit: 15 } as never);
const rows = (res as unknown as { sandboxes?: Array<{ name?: string; status?: string; createdAt?: number }> }).sandboxes ?? [];
for (const s of rows) console.log(s.name, s.status, s.createdAt ? new Date(s.createdAt).toISOString() : "");
