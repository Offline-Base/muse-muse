/**
 * Plans a Mac Studio cluster for Muse Spark Open (cookbook/muse-spark-open-mac), in code only. No model call, no
 * network. It writes the commands and files the person runs on their own Macs; the product never runs them.
 */

export const NVFP4_REPO = "meta-models/Muse-Spark-Open-816B-A42B-NVFP4";
/** The NVFP4 checkpoint's size. Every Mac keeps a full copy on its own disk. */
export const NVFP4_GB = 537;

export type MacCount = 2 | 4;

export interface MacPlanInput {
  macs: number;
  /** Unified memory per Mac, in GB. */
  memoryGb: number;
  /** Host names, primary first, such as mac-studio-1.local. */
  hosts: string[];
  port?: number;
}

/** What can go wrong, each with one fix. The log doctor's answer must name one of these ids, or "none". */
export const MAC_CHECKS = [
  { id: "macos", label: "macOS 26.2 or later on every Mac", fix: "Update macOS on every Mac. 26.2 adds the RDMA-over-Thunderbolt driver jaccl uses." },
  { id: "rdma", label: "RDMA turned on, on every Mac", fix: "Start each Mac in recovery, open Utilities > Terminal, run rdma_ctl enable, then reboot. It can't be done remotely, even with sudo." },
  { id: "mlx", label: "MLX 0.30.1 or later and mlx-lm on every Mac", fix: "Run pip install -U mlx-lm on every Mac, since mlx.launch starts the program on each one." },
  { id: "thunderbolt", label: "A direct Thunderbolt 5 link between every pair", fix: "Connect every pair of Macs directly, two cables per pair to double the bandwidth. With four Macs each one connects to the other three." },
  { id: "ssh", label: "Passwordless SSH from the primary to every other Mac", fix: "On the primary: ssh-keygen -t ed25519, then ssh-copy-id <host> for each other Mac." },
  { id: "disk", label: `Disk for the full NVFP4 checkpoint (about ${NVFP4_GB} GB) on every Mac`, fix: "Free space on each Mac's disk: each one loads the model from its own copy." },
  { id: "hostfile", label: "hostfile.json lists every Mac with its Thunderbolt IP and RDMA devices", fix: "Generate it with mlx.distributed_config --over thunderbolt --backend jaccl --auto-setup, instead of writing it by hand." },
  { id: "memory", label: "Two Macs with 512 GB each, or four with 256 GB each", fix: "The model doesn't fit in less. Four Macs serve fastest." },
] as const;

export type MacCheckId = (typeof MAC_CHECKS)[number]["id"];
export const MAC_CHECK_IDS: readonly MacCheckId[] = MAC_CHECKS.map((c) => c.id);

export interface MacCommand {
  id: string;
  title: string;
  code: string;
}

export interface MacPlan {
  problems: string[];
  sharePerMacGb: number;
  /** Every pair of Macs that needs a direct link, by host name. */
  links: Array<[string, string]>;
  cables: number;
  commands: MacCommand[];
  /** A hostfile.json to fill in, with FILL_IN where only the person's Macs know the value. */
  hostfileSkeleton: string;
  setupScript: string;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

export function defaultHosts(macs: number): string[] {
  return Array.from({ length: macs }, (_, i) => `mac-studio-${i + 1}.local`);
}

export function planMacCluster(input: MacPlanInput): MacPlan {
  const port = input.port ?? 8080;
  const hosts = input.hosts.map((h) => h.trim());
  const problems: string[] = [];
  if (input.macs !== 2 && input.macs !== 4) problems.push("Use two Macs or four. The recipe covers no other count.");
  if (input.macs === 2 && input.memoryGb < 512) problems.push("Two Macs need 512 GB of unified memory each.");
  if (input.macs === 4 && input.memoryGb < 256) problems.push("Four Macs need 256 GB of unified memory each.");
  if (hosts.length !== input.macs) problems.push(`List ${input.macs} host names, one per Mac.`);
  const bad = hosts.filter((h) => !HOST.test(h));
  if (bad.length) problems.push(`These aren't host names: ${bad.join(", ")}. Use letters, numbers, dots and dashes.`);
  if (new Set(hosts).size !== hosts.length) problems.push("Two entries name the same Mac.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push("Pick a port from 1024 to 65535.");

  const links: Array<[string, string]> = [];
  for (let i = 0; i < hosts.length; i++) for (let j = i + 1; j < hosts.length; j++) links.push([hosts[i], hosts[j]]);
  const list = hosts.join(",");
  const others = hosts.slice(1);
  const launch = `mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model ${NVFP4_REPO} --port ${port}`;
  const commands: MacCommand[] = [
    { id: "ssh", title: "Check passwordless SSH from the primary", code: others.map((h) => `ssh ${h} 'echo ok'`).join("\n") },
    { id: "keys", title: "If one asks for a password, set up a key", code: ["ssh-keygen -t ed25519", ...others.map((h) => `ssh-copy-id ${h}`)].join("\n") },
    { id: "install", title: "Install mlx-lm on every Mac", code: "pip install -U mlx-lm" },
    { id: "hostfile", title: "Generate hostfile.json over Thunderbolt", code: `mlx.distributed_config --verbose --hosts ${list} --over thunderbolt --backend jaccl --auto-setup --output hostfile.json` },
    { id: "server", title: `Serve an OpenAI-compatible API on port ${port}`, code: launch },
    {
      id: "generate",
      title: "Or test from the command line, with room for xhigh reasoning",
      code: `mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.generate --model ${NVFP4_REPO} \\\n  --prompt "Give me a one-sentence summary of what you can do." \\\n  --max-tokens 4096 --temp 1.0 --top-p 1.0`,
    },
  ];
  const hostfile = hosts.map((h, i) => ({
    ssh: h,
    ips: i === 0 ? ["FILL_IN_RANK0_THUNDERBOLT_IP"] : [],
    rdma: hosts.map((_, j) => (j === i ? null : ["FILL_IN_RDMA_DEVICE", "FILL_IN_RDMA_DEVICE"])),
  }));
  const setupScript = [
    "#!/usr/bin/env bash",
    "# Run on the primary Mac. Written by a planner; nothing here has run on your Macs yet.",
    "set -euo pipefail",
    `HOSTS=(${others.join(" ")})`,
    'for h in "${HOSTS[@]}"; do ssh -o BatchMode=yes "$h" "echo ok" || { echo "No passwordless SSH to $h: run ssh-copy-id $h"; exit 1; }; done',
    "# Each Mac: install mlx-lm and check its free disk, in 1 GB blocks.",
    `prep='pip install -U mlx-lm && df -g ~ | awk "NR==2 {print \\$4}"'`,
    `for h in local "\${HOSTS[@]}"; do`,
    '  if [ "$h" = local ]; then free=$(bash -c "$prep" | tail -1); else free=$(ssh "$h" "$prep" | tail -1); fi',
    `  [ "$free" -ge ${NVFP4_GB} ] || { echo "$h has \${free} GB free; the NVFP4 checkpoint needs about ${NVFP4_GB} GB"; exit 1; }`,
    "done",
    `mlx.distributed_config --verbose --hosts ${list} --over thunderbolt --backend jaccl --auto-setup --output hostfile.json`,
    launch,
    "",
  ].join("\n");
  return {
    problems,
    sharePerMacGb: hosts.length ? Math.round((NVFP4_GB / hosts.length) * 100) / 100 : 0,
    links,
    cables: links.length * 2,
    commands,
    hostfileSkeleton: `${JSON.stringify(hostfile, null, 2)}\n`,
    setupScript,
  };
}

/** The log doctor's reply, kept only when it names a known check. */
export function checkDiagnosis(id: string): (typeof MAC_CHECKS)[number] | "none" | null {
  if (id === "none") return "none";
  return MAC_CHECKS.find((c) => c.id === id) ?? null;
}
