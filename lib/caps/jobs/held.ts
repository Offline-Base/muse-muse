import { jobsStore } from "@/lib/caps/jobs/store";
import type { SendArgs } from "@/lib/caps/connect/handler";

/**
 * A job's send (docs/CAPABILITIES.md, section 12): nothing goes. The whole message becomes a notice, with the lines the
 * owner's confirmation card shows, and the owner confirms or dismisses it on Muse Muse. A build's is recorded and shown
 * to no one.
 */
export async function holdJobSend(input: { productId: string; namespace: string; send: SendArgs; lines: string[]; title: string }): Promise<string> {
  return jobsStore.addNotice({
    productId: input.productId,
    namespace: input.namespace,
    kind: "send_held",
    title: `A job drafted this. ${input.title}`,
    body: input.lines.join("\n"),
    payload: { send: input.send },
  });
}
