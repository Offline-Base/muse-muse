import type { CodeStep } from "@/components/docs/playgrounds/open-weights/deploy";
import { SPARK_CHECKPOINTS, gb } from "@/components/docs/playgrounds/open-weights/facts";
import { shq } from "@/components/docs/playgrounds/open-weights/shell";

/**
 * The Mac Studio recipe (cookbook/muse-spark-open-mac) as a planner: two Macs with 512 GB or four with 256 GB, each
 * holding a share of the NVFP4 model and its own full copy on disk, a direct Thunderbolt 5 link between every pair
 * (two cables per pair doubles the bandwidth), passwordless SSH from the primary, and the mlx.launch commands with
 * the reader's host names and generation settings.
 */

export interface MacPlanOptions {
  macs: 2 | 4;
  hosts: string[];
  doubleCables: boolean;
  prompt: string;
  maxTokens: number;
  temp: number;
  topP: number;
  port: number;
}

export function defaultHosts(macs: 2 | 4): string[] {
  return Array.from({ length: macs }, (_, i) => `mac-studio-${i + 1}.local`);
}

export const MAC_DEFAULTS: MacPlanOptions = {
  macs: 4,
  hosts: defaultHosts(4),
  doubleCables: true,
  prompt: "Give me a one-sentence summary of what you can do.",
  maxTokens: 4096,
  temp: 1.0,
  topP: 1.0,
  port: 8080,
};

export interface MacPlan {
  memoryGb: number;
  shareGb: number;
  sharePercent: number;
  pairs: Array<[string, string]>;
  cables: number;
  portsPerMac: number;
  diskPerMacGb: number;
  steps: CodeStep[];
  checklist: string[];
  warnings: string[];
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function macPlan(o: MacPlanOptions): MacPlan {
  const macs = o.macs;
  const hosts = defaultHosts(macs).map((d, i) => (o.hosts[i] ?? "").trim() || d);
  const warnings: string[] = [];
  hosts.forEach((h) => {
    if (!HOST.test(h)) warnings.push(`${h} isn't a plain host name.`);
  });
  if (new Set(hosts).size !== hosts.length) warnings.push("Two Macs share a host name; each entry in the hostfile must be a different Mac.");
  const memoryGb = macs === 2 ? 512 : 256;
  const footprint = SPARK_CHECKPOINTS.nvfp4.footprintGb;
  const shareGb = footprint / macs;
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < hosts.length; i++) for (let j = i + 1; j < hosts.length; j++) pairs.push([hosts[i], hosts[j]]);
  const perPair = o.doubleCables ? 2 : 1;
  const [primary, ...others] = hosts;

  const steps: CodeStep[] = [];
  steps.push({
    title: `On ${primary}: check passwordless SSH to the other Mac${others.length === 1 ? "" : "s"}`,
    lang: "bash",
    code: others.map((h) => `ssh ${h} 'echo ok'`).join("\n"),
    note: "Each should print ok without asking for a password.",
  });
  steps.push({
    title: "If one asks for a password, set up key-based access",
    lang: "bash",
    code: ["ssh-keygen -t ed25519", ...others.map((h) => `ssh-copy-id ${h}`)].join("\n"),
  });
  steps.push({
    title: "Install mlx-lm on every Mac",
    lang: "bash",
    code: ["pip install -U mlx-lm", "", "# or, from the primary, on the others:", ...others.map((h) => `ssh ${h} 'pip install -U mlx-lm'`)].join("\n"),
    note: "mlx.launch starts the program over SSH on each Mac, so each needs mlx-lm and its own copy of the NVFP4 checkpoint on disk.",
  });
  const env = "--env MLX_METAL_FAST_SYNCH=1";
  steps.push({
    title: `Start the server on ${primary} (OpenAI-compatible, port ${o.port})`,
    lang: "bash",
    code: `mlx.launch --hostfile hostfile.json --backend jaccl ${env} -- \\\n  mlx_lm.server --model ${SPARK_CHECKPOINTS.nvfp4.repo} --port ${o.port}`,
    note: `hostfile.json lists ${hosts.join(", ")}, each with its Thunderbolt IP addresses and RDMA devices. The MLX distributed docs describe the format, and mlx.distributed_config can generate it.`,
  });
  steps.push({
    title: "Or test without a server",
    lang: "bash",
    code: [
      `mlx.launch --hostfile hostfile.json --backend jaccl ${env} -- \\`,
      "  mlx_lm.generate \\",
      `    --model ${SPARK_CHECKPOINTS.nvfp4.repo} \\`,
      `    --prompt "${(o.prompt || MAC_DEFAULTS.prompt).replace(/(["\\$`])/g, "\\$1")}" \\`,
      `    --max-tokens ${Math.round(o.maxTokens)} \\`,
      `    --temp ${o.temp.toFixed(1)} \\`,
      `    --top-p ${o.topP.toFixed(1)}`,
    ].join("\n"),
    note: "The chat template defaults to xhigh reasoning, so leave room for reasoning tokens before the answer.",
  });
  steps.push({
    title: "Call the server",
    lang: "bash",
    code: [
      `curl http://${primary}:${o.port}/v1/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      "  -d " +
        shq(
          JSON.stringify(
            { model: SPARK_CHECKPOINTS.nvfp4.repo, messages: [{ role: "user", content: o.prompt || MAC_DEFAULTS.prompt }], max_tokens: Math.round(o.maxTokens), temperature: o.temp, top_p: o.topP },
            null,
            2,
          ),
        ),
    ].join("\n"),
  });
  if (o.maxTokens < 2048) warnings.push("At xhigh, a small token budget can run out during reasoning, before the answer.");
  if (o.temp !== 1 || o.topP !== 1) warnings.push("The recommended sampling is temperature 1.0 and top_p 1.0; the model card's results were measured there.");

  const checklist = [
    "macOS 26.2 or later on every Mac, with RDMA turned on (it adds the RDMA-over-Thunderbolt driver jaccl uses)",
    "MLX 0.30.1 or later",
    `A direct Thunderbolt 5 link between every pair: ${pairs.length} link${pairs.length === 1 ? "" : "s"}${o.doubleCables ? ", two cables each to double the bandwidth" : ""}`,
    `Passwordless SSH from ${primary} to ${others.join(", ")}`,
    `Disk on every Mac for the full NVFP4 checkpoint (about ${SPARK_CHECKPOINTS.nvfp4.footprintGb} GB)`,
  ];

  return {
    memoryGb,
    shareGb,
    sharePercent: Math.round((shareGb / memoryGb) * 100),
    pairs,
    cables: pairs.length * perPair,
    portsPerMac: (macs - 1) * perPair,
    diskPerMacGb: footprint,
    steps,
    checklist,
    warnings,
  };
}

export function macSummary(p: MacPlan, macs: 2 | 4): string {
  return `${macs} Macs with ${p.memoryGb} GB each: about ${gb(p.shareGb)} GB of NVFP4 weights per Mac (${p.sharePercent}% of its memory), ${p.pairs.length} Thunderbolt 5 link${p.pairs.length === 1 ? "" : "s"} and ${p.cables} cable${p.cables === 1 ? "" : "s"}, ${p.portsPerMac} port${p.portsPerMac === 1 ? "" : "s"} per Mac.`;
}
