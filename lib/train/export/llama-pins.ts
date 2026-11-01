/**
 * llama.cpp at the tag the quantize job makes files with (LLAMACPP_TAG in lib/train/recipes/quantize.ts). The sha256s are
 * GitHub's own asset digests for that release, read Nov 1 2026, and a test keeps the tag equal to the job's.
 */
export type InstallerOs = "mac" | "windows" | "linux" | "jetson";

export const LLAMA_TAG = "b11669";

export interface LlamaBuild {
  /** What uname -m says. */
  arch: string;
  asset: string;
  sha256: string;
}

export const LLAMA_BUILDS: Record<InstallerOs, readonly LlamaBuild[]> = {
  mac: [
    { arch: "arm64", asset: "llama-b11669-bin-macos-arm64.tar.gz", sha256: "dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd" },
    { arch: "x86_64", asset: "llama-b11669-bin-macos-x64.tar.gz", sha256: "cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532" },
  ],
  linux: [
    { arch: "x86_64", asset: "llama-b11669-bin-ubuntu-x64.tar.gz", sha256: "cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac" },
    { arch: "aarch64", asset: "llama-b11669-bin-ubuntu-arm64.tar.gz", sha256: "9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99" },
  ],
  windows: [{ arch: "AMD64", asset: "llama-b11669-bin-win-cpu-x64.zip", sha256: "37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b" }],
  jetson: [{ arch: "aarch64", asset: "llama-b11669-bin-ubuntu-arm64.tar.gz", sha256: "9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99" }],
};

/** The tag's source, as LLAMACPP_SOURCE in QUANT_PY pins it. */
export const LLAMA_SOURCE = {
  url: "https://github.com/ggml-org/llama.cpp/archive/refs/tags/b11669.tar.gz",
  sha256: "e06ba4fa263e30fdb9f0e65f00a8965202ddaa0c51f548a67e1f9b2164d04efc",
  top: "llama.cpp-b11669",
};

/** The context to run with. A Jetson's 8 GB is shared with the system, so it asks for less. Not measured on a board. */
export const LLAMA_RUN_CONTEXT: Record<InstallerOs, number> = { mac: 8192, windows: 8192, linux: 8192, jetson: 4096 };
