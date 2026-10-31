import { hasNativeWork } from "@/lib/native/targets";
import { NATIVE_TEMPLATE_FILES } from "@/lib/native/template-source";

/**
 * Files the sandbox gets beyond the snapshot's template for this brief: the phone and desktop bridge, PWA manifest, icons
 * and skill. Empty for a brief with neither, so a web-only build gets nothing new.
 */
export function nativeExtraFiles(brief: Parameters<typeof hasNativeWork>[0]): Array<{ path: string; content: string }> {
  return hasNativeWork(brief) ? NATIVE_TEMPLATE_FILES.map((f) => ({ ...f })) : [];
}
