import { APIError, Sandbox } from "@vercel/sandbox";
import type { SandboxHostApi } from "@/lib/sandbox/host/types";

/**
 * The default host: @vercel/sandbox, called exactly as builder.ts called it before the host interface. Every method
 * passes its params through and hands back the SDK's own Sandbox.
 */
export const vercelHost: SandboxHostApi = {
  name: "vercel",
  get: (params) => Sandbox.get(params),
  getOrCreate: (params) => Sandbox.getOrCreate(params),
  fork: (params) => Sandbox.fork(params),
  isNotFound: (err) => err instanceof APIError && err.response.status === 404,
};
