import { CopyField } from "@/components/CopyButton";
import type { GetItSlots } from "@/components/product/GetItPanel";
import type { ProductView } from "@/components/view-types";
import { publicActions } from "@/lib/outputs/generate";
import { githubActionFileName } from "@/lib/outputs/github-action";
import { selfHostFileName } from "@/lib/outputs/selfhost";
import { vscodeFileName, vsixFileName } from "@/lib/outputs/vscode";

/** Where the runtime outputs download from (app/p/[slug]/get/*.zip). */
export function runtimeOutputLinks(origin: string, slug: string) {
  const base = origin.replace(/\/+$/, "");
  return {
    vscode: `${base}/p/${slug}/get/vscode.zip`,
    githubAction: `${base}/p/${slug}/get/github-action.zip`,
    selfHost: `${base}/p/${slug}/get/selfhost.zip`,
  };
}

/**
 * The Get it panel's runtime output slots (docs/CAPABILITIES.md, section 16), with RUNTIME_OUTPUTS on: the VS Code
 * extension and the GitHub Action for a live product with public actions, and the self-host kit for its owner only. A
 * product with no live link has none.
 */
export function runtimeOutputSlots(input: { product: Pick<ProductView, "slug" | "name" | "liveUrl" | "manifest">; origin: string; isOwner: boolean }): GetItSlots {
  const { product, origin, isOwner } = input;
  if (!product.liveUrl) return {};
  const links = runtimeOutputLinks(origin, product.slug);
  const { slug } = product;
  const hasActions = publicActions(product.manifest).length > 0;
  const workflow = `- uses: ./.github/actions/${slug}\n  with:\n    action: ${publicActions(product.manifest)[0]?.name ?? ""}\n    input: '{}'`;
  return {
    ...(hasActions
      ? {
          vscode: (
            <div className="output-panel">
              <p>A VS Code extension that runs each of its actions from the command palette. It isn&apos;t in the Marketplace: you package it yourself.</p>
              <ol>
                <li>
                  <a href={links.vscode} download={vscodeFileName(slug)}>
                    Download {vscodeFileName(slug)}
                  </a>{" "}
                  and unzip it.
                </li>
                <li>
                  In that folder: <code>npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license</code>
                </li>
                <li>
                  Then <code>code --install-extension {vsixFileName(slug)}</code>. Or open the folder in VS Code and press F5 to try it.
                </li>
              </ol>
            </div>
          ),
          github_action: (
            <div className="output-panel">
              <p>A GitHub Action that runs one of its actions in a workflow and puts the reply in its <code>result</code> output. It isn&apos;t in the Marketplace.</p>
              <ol>
                <li>
                  <a href={links.githubAction} download={githubActionFileName(slug)}>
                    Download {githubActionFileName(slug)}
                  </a>{" "}
                  and unzip it into your repository as <code>.github/actions/{slug}/</code>.
                </li>
                <li>Add a step like this to a workflow:</li>
              </ol>
              <CopyField value={workflow} label="Workflow step" />
            </div>
          ),
        }
      : {}),
    ...(isOwner
      ? {
          self_host: (
            <div className="output-panel">
              <p>
                Run your own copy on your own Meta API key. The kit is this product&apos;s code as it runs now, with no Muse Muse key or token in it. Only you see this tab, so
                you decide who gets the code.
              </p>
              <ol>
                <li>
                  <a href={links.selfHost} download={selfHostFileName(slug)}>
                    Download {selfHostFileName(slug)}
                  </a>{" "}
                  and unzip it. It takes a few seconds to put together.
                </li>
                <li>
                  Run <code>npm ci</code>, copy <code>.env.example</code> to <code>.env.local</code> and add your Meta API key.
                </li>
                <li>
                  Run <code>npm run build</code> and <code>npm start</code>, or deploy it to Vercel. Its README says what needs Muse Muse and won&apos;t work on your own key.
                </li>
              </ol>
            </div>
          ),
        }
      : {}),
  };
}
