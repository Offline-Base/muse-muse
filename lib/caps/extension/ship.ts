import { Sandbox } from "@vercel/sandbox";
import type { Brief } from "@/lib/brief/schema";
import type { ExtensionBrief } from "@/lib/caps/extension/brief";
import { extensionOrigin } from "@/lib/caps/extension/manifest";
import { ExtensionPackError, packageExtension } from "@/lib/caps/extension/package";
import { extensionZipPath } from "@/lib/caps/extension/paths";
import { putExtensionZip } from "@/lib/caps/extension/store";
import { CAPS_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";

/**
 * After a product with a browser extension goes live (docs/CAPABILITIES.md, section 20): the platform's own packer, the
 * read-only copy in CAPS_DIR, compiles the product's extension/ in its sandbox and writes a bundle; the platform reads
 * it, checks it and writes the manifest and config.js for the live link (lib/caps/extension/package.ts), then saves the
 * zip at extensions/<productId>/latest.zip. A refinement packages it again. Anything that goes wrong becomes one plain
 * line in the build room: the product is live either way.
 */

/** The platform's packer in the sandbox: never the product's own copy. */
export const PACKER = `${CAPS_DIR}/extension/files/scripts/extension-pack.mjs`;
export const BUNDLE_FILE = "/tmp/musemuse-extension.json";
const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

export interface ExtensionShipDeps {
  /** Runs node with these arguments in the product's sandbox, never through a shell. */
  node(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(file: string): Promise<Buffer | null>;
  save(productId: string, zip: Buffer): Promise<string>;
}

const firstProblem = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.replace(/^extension: /, "").trim())
    .find(Boolean)
    ?.slice(0, 240) ?? "the packer stopped";

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Packages and saves the extension. Returns the build room's line, or null for a brief with no extension. */
export async function shipExtension(input: { productId: string; liveUrl: string; brief: Brief }, deps: ExtensionShipDeps): Promise<string | null> {
  const ext = (input.brief as { extension?: ExtensionBrief | null }).extension;
  if (!ext) return null;
  const fail = (why: string) => `The browser extension wasn't packaged: ${why.replace(/\.$/, "")}. The web product is live as usual.`;
  let origin: string;
  try {
    origin = extensionOrigin(input.liveUrl);
  } catch (err) {
    return fail((err as Error).message);
  }
  const ran = await deps.node([PACKER, "bundle", "--root", PRODUCT_DIR, "--out", BUNDLE_FILE]);
  if (ran.exitCode !== 0) return fail(firstProblem(ran.stderr));
  const raw = await deps.readFile(BUNDLE_FILE);
  if (!raw) return fail("the packer wrote nothing");
  if (raw.length > BUNDLE_MAX_BYTES) return fail("its files are too big");
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw.toString("utf8"));
  } catch {
    return fail("the packer's output isn't JSON");
  }
  try {
    const pack = packageExtension(bundle, { origin, permissions: ext.permissions });
    await deps.save(input.productId, pack.zip);
    const dropped = pack.dropped.length ? ` Left out ${pack.dropped.join(", ")}, which its brief didn't list.` : "";
    return `Packaged the browser extension for ${origin} (${pack.files} files, ${kb(pack.zip.length)}). People install it with Load unpacked from the product's page.${dropped}`;
  } catch (err) {
    if (err instanceof ExtensionPackError) return fail(err.problems[0]!);
    console.error(`[extension] saving ${extensionZipPath(input.productId)} failed:`, err);
    return fail("it couldn't be saved");
  }
}

/** The real dependencies: the product's sandbox and the extensions store. */
export function sandboxShipDeps(sandboxName: string): ExtensionShipDeps {
  const open = () => Sandbox.get({ name: sandboxName, resume: true });
  return {
    async node(args) {
      const sandbox = await open();
      const cmd = await sandbox.runCommand({ cmd: "node", args, cwd: PRODUCT_DIR, timeoutMs: 120_000 });
      const [stdout, stderr] = await Promise.all([cmd.stdout(), cmd.stderr()]);
      return { exitCode: cmd.exitCode, stdout, stderr };
    },
    async readFile(file) {
      const sandbox = await open();
      return sandbox.readFileToBuffer({ path: file }).catch(() => null);
    },
    save: putExtensionZip,
  };
}
