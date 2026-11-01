import type { GetItSlots } from "@/components/product/GetItPanel";
import type { ProductView } from "@/components/view-types";
import { EXTENSION_PERMISSIONS, type ExtensionBrief, type ExtensionPermission } from "@/lib/caps/extension/brief";
import { extensionFileName } from "@/lib/caps/extension/paths";

/** What each permission lets the extension do, in the words the panel shows. */
const PERMISSION_WORDS: Record<ExtensionPermission, string> = {
  activeTab: "see the address and title of the page you're on, when you click it",
  storage: "keep its settings and recent results in your browser",
  contextMenus: "add an item to the right-click menu for text you select",
  sidePanel: "open a panel beside the page",
};

/** Where the extension downloads from (app/p/[slug]/get/extension). */
export const extensionLink = (origin: string, slug: string) => `${origin.replace(/\/+$/, "")}/p/${slug}/get/extension`;

/**
 * The Get it panel's extension slot (docs/CAPABILITIES.md, section 20), with NATIVE_EXTENSION on: a live product whose
 * brief has a browser extension offers its zip with the Load unpacked steps. Anything else has none. `ready` is whether
 * the zip is there (extensionZipReady): false says it isn't ready yet instead of offering a link that answers 404, and
 * null (couldn't tell) keeps the link.
 */
export function extensionSlots(input: {
  product: Pick<ProductView, "slug" | "liveUrl">;
  origin: string;
  brief: { extension?: ExtensionBrief | null } | null;
  ready?: boolean | null;
}): GetItSlots {
  const ext = input.brief?.extension;
  if (!input.product.liveUrl || !ext) return {};
  if (input.ready === false) {
    return {
      extension: (
        <div className="output-panel">
          <p>{ext.does}</p>
          <p className="muted">The extension isn&apos;t ready to download yet. It&apos;s packaged each time the product goes live, so check back after its next change.</p>
        </div>
      ),
    };
  }
  const can = EXTENSION_PERMISSIONS.filter((p) => ext.permissions.includes(p)).map((p) => PERMISSION_WORDS[p]);
  const { slug } = input.product;
  return {
    extension: (
      <div className="output-panel">
        <p>{ext.does}</p>
        <ol>
          <li>
            <a href={extensionLink(input.origin, slug)} download={extensionFileName(slug)}>
              Download the extension
            </a>{" "}
            and unzip it.
          </li>
          <li>
            In Chrome, Edge or Brave, open <code>chrome://extensions</code> and turn on Developer mode.
          </li>
          <li>Click Load unpacked and choose the unzipped folder. Pin it from the extensions menu to keep it in reach.</li>
        </ol>
        <p className="muted">
          It isn&apos;t in any extension store. It works only with this product, and sends what you&apos;re looking at only when you click it.
          {can.length ? ` It can ${can.join(", ")}.` : ""}
        </p>
      </div>
    ),
  };
}
