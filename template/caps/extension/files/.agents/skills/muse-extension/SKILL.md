---
name: muse-extension
description: How a Muse Muse product ships a Chrome extension (Manifest V3) beside its web app, calling the product's own actions. Read it when brief.md has a "Browser extension" section.
---

# Browser extension

brief.md's "Browser extension" section says what the extension does and the permissions it may ask for. The web
product stays the product: the extension is a small popup, side panel or right-click item that sends the page the
person is on to one of the product's own actions and shows the answer. People install it with Load unpacked from the
product's page on Muse Muse. It isn't in any extension store.

## The folder

Everything lives in `extension/`, outside the Next.js app:

| File | What it is |
|---|---|
| `manifest.json` | Name, description, version, popup, service worker, icons. Yours to fill in |
| `popup.html`, `popup.ts`, `popup.css` | The popup. A starting point: make it do what the brief says |
| `background.ts` | The service worker. Context menus and anything that runs without the popup |
| `platform.ts` | Platform file: `productAction`, `currentPage`, `ProductError` |
| `config.d.ts` | Platform file: the shape of `config.js`, which the platform writes |

- Plain TypeScript and DOM code only. No React, no JSX and no packages: each `.ts` file is compiled on its own, with no
  bundler. Import the extension's own files by a relative path ending in `.js`: `import { productAction } from "./platform.js"`.
- `manifest.json` keys you may set: `manifest_version` (3), `name`, `short_name`, `description` (132 characters at most),
  `version`, `action` (`default_popup`, `default_title`, `default_icon`), `background` (`{"service_worker": "background.js",
  "type": "module"}`, always), `side_panel`, `permissions`, `icons` (PNG at 16, 32, 48, 128), `commands`,
  `minimum_chrome_version`. Never `host_permissions`, `content_scripts`, `content_security_policy`, `web_accessible_resources`,
  `externally_connectable` or `key`: the platform writes the host permission and the policy itself.
- Permissions: exactly the ones brief.md lists, from `activeTab`, `storage`, `contextMenus` and `sidePanel`. A permission the
  brief doesn't list is left out when the platform packages it, so verify fails on one.

## What it may do

- Reach the network only with `productAction(name, input)` from `platform.ts`. It POSTs JSON to the product's own
  `/api/actions/<name>` and returns the JSON reply, or throws `ProductError` with a message to show as it is. The
  extension's content security policy allows only the product's own link, so any other address fails in the browser:
  calls, images, styles and fonts alike. Ship images, styles and fonts in the extension folder, or use `data:` and
  `blob:` images it makes, or images from the product's own link.
- Read the current page's address and title with `currentPage()` (the `activeTab` permission). Chrome shares them only
  after the person clicks the extension. The extension can't read or change what's on a page.
- Get selected text from a right-click item (`contextMenus`): in `background.ts`, `chrome.contextMenus.create({ id,
  title, contexts: ["selection"] })` inside `chrome.runtime.onInstalled`, then `chrome.contextMenus.onClicked`, where
  `info.selectionText` is the text. Keep results in `chrome.storage.local` (`storage`) for the popup to show.
- Keep a panel open beside the page (`sidePanel`): `side_panel.default_path` in the manifest, and the same page code as
  a popup.
- No `eval`, no `new Function`, no `import()` at run time, no inline scripts or `onclick=` attributes (Manifest V3 runs
  none), no scripts, styles or fonts from other sites, no frames, no pictures or recordings of the page or screen
  (`chrome.tabs.captureVisibleTab`, `tabCapture`, `desktopCapture`, `pageCapture`). Verify's `manifest` check refuses
  each one by name.

## The look and the words

- `popup.css` starts with the product's design tokens from `app/globals.css`. Keep using them, so the popup matches the
  web product. A popup is 360 px wide; nothing in it scrolls sideways.
- Every input has a label. Every call has loading, error and empty states, as in the web product.
- Say what leaves the page, next to the button that sends it: "Sends this page's title and address to <Product> when
  you click." If it sends selected text, say that.
- Show replies as words and fields, never raw JSON.

## Trying it

- `node scripts/extension-pack.mjs check` compiles it and runs the platform's checks.
- `node scripts/extension-pack.mjs build --origin http://localhost:3000` writes the folder Chrome loads to
  `test-results/caps/extension-build/`, pointed at that address.

## The test

Add `tests/extension.spec.ts` with one test that uses the helpers in `tests/caps/extension.ts`. It runs with the smoke
test in every verify. It's a spec of its own because the extension runs in a browser of its own, which the demo video
can't show, and the demo runs only `tests/smoke.spec.ts`.

```ts
import { expect, test } from "@playwright/test";
import { expectExtensionAction, openExtension, openPopup } from "./caps/extension";
import { judgeShot } from "./judge-shot";

test("the extension saves the page", async ({ baseURL }) => {
  const ext = await openExtension(baseURL);
  try {
    // A page for it to act on first: the product's own page is enough.
    const tab = await ext.context.newPage();
    await tab.goto(`${baseURL}/`);
    const popup = await openPopup(ext);
    await test.step("Save this page from the extension", async () => {
      await expectExtensionAction(popup, "save_note", () => popup.getByRole("button", { name: "Save this page" }).click());
      await expect(popup.getByText("Saved")).toBeVisible();
    });
    await judgeShot(popup, "04-extension");
  } finally {
    await ext.close();
  }
});
```

- `openExtension` builds the extension for the test server and loads it into its own Chromium. Close it in `finally`.
- `openPopup` opens the popup at popup size and checks it rendered. `expectExtensionAction` checks the click called the
  action and got JSON. Both record their checks.
- Take one judge screenshot of the popup after it shows a result.
- Verify also loads the extension and opens the popup itself, with no product server behind it: the popup must render
  without an answer, with its normal empty or loading state.

## Platform files

`extension/platform.ts`, `extension/config.d.ts`, `scripts/extension-pack.mjs`, `scripts/caps/extension.mjs`,
`tests/caps/extension.ts` and this skill. Verify puts them back before every run, so an edit to one is lost.
