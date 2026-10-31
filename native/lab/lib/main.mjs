// Whether a module is the script node was asked to run. Node resolves links in import.meta.url but not in argv[1], and every
// real box runs these files through its `current` link or junction, so the two only match as real paths.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl, script = process.argv[1]) {
  if (!script) return false;
  try {
    return fileURLToPath(metaUrl) === realpathSync(script);
  } catch {
    return false;
  }
}
