/**
 * The shell templates every product's downloads are patched from. scripts/native/release-shells.ts uploads them and writes
 * shells.json next to this file, which deploys with the platform. native/ itself doesn't.
 */
import shells from "@/lib/native/shells.json";

export const SHELL_TEMPLATE_KINDS = ["android", "mac", "windows"] as const;
export type ShellTemplateKind = (typeof SHELL_TEMPLATE_KINDS)[number];

/** The file name under native/shells/<version>/, and in the packager snapshot. */
export const SHELL_TEMPLATE_FILES: Record<ShellTemplateKind, string> = { android: "android.apk", mac: "mac.zip", windows: "windows.zip" };

export interface ShellTemplate {
  pathname: string;
  /** Null until it's in the live Blob store. The packager then needs the copy baked into its snapshot. */
  url: string | null;
  bytes: number;
  sha256: string;
}

export interface ShellRelease {
  shellVersion: string;
  templates: Partial<Record<ShellTemplateKind, ShellTemplate>>;
}

/** The release packages are made from. Its `templates` can be missing a kind until that shell is built. */
export function currentShells(): ShellRelease {
  return shells as ShellRelease;
}
