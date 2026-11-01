/**
 * The real pieces behind lib/device/drive-product.ts: the product's own model, the lab's files, the kit, the Hub and the
 * counters. app/api/gateway/gadget/route.ts imports this only for a drive tool call, so a gadget call otherwise loads none of it.
 */
import path from "node:path";
import { latestProofAt } from "@/lib/caps/hardware/store";
import { isOwnModelJob, ownModelFor } from "@/lib/caps/gpu/own-model";
import { productDriveCall, type ProductDriveDeps } from "@/lib/device/drive-product";
import { loadKit } from "@/lib/drive/kit";
import { readDriveTemplates } from "@/lib/drive/plan";
import { hubText } from "@/lib/drive/sources";
import type { GadgetDriveCall } from "@/lib/gateway/gadget";
import { hitRateLimits, reserveCounter } from "@/lib/gateway/store";
import { localFilesFor } from "@/lib/train/local-files-server";

const DEPS: ProductDriveDeps = {
  ownModel: (productId) => ownModelFor(productId),
  ownsJob: (productId, jobId) => isOwnModelJob(productId, jobId),
  localFiles: localFilesFor,
  kit: () => loadKit(),
  planDeps: async () => ({
    templates: await readDriveTemplates(path.join(process.cwd(), "drive")),
    hubText: (repo, commit, name, token) => hubText(repo, commit, name, token),
    hfToken: () => process.env.HF_TOKEN?.trim() || null,
  }),
  spendApproval: async (nonce, exp) => (await reserveCounter(`tool-approval:${nonce}`, exp, 1, 1)) !== null,
  note: async (key, at) => {
    await hitRateLimits([key], at);
  },
  latestNote: latestProofAt,
};

export const runProductDrive = (call: GadgetDriveCall): Promise<Response> => productDriveCall(call, DEPS);
