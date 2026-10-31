/**
 * Small standalone pages the trust unit answers with outside the app's layout (docs/CAPABILITIES.md, section 7). Plain
 * HTML with inline styles that follow the platform's tokens' values, light and dark, since nothing else loads with them.
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#111112;--fg-2:rgba(0,2,7,0.68)}
@media (prefers-color-scheme:dark){:root{--bg:#181819;--fg:#ffffff;--fg-2:rgba(242,247,255,0.6)}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:64px 16px}
h1{font-size:24px;line-height:1.25;margin:0 0 12px}
p{margin:0 0 12px;color:var(--fg-2)}
`;

/** The answer for a request from a restricted territory, with status 451. */
export function unavailablePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not available here</title><style>${STYLE}</style></head>
<body><main>
<h1>Muse Muse isn't available where you are</h1>
<p>Muse Muse uses Meta's models, and Meta's terms don't allow them to be used from this country or region.</p>
<p>Built with Muse Muse. Not an official Meta product.</p>
</main></body></html>
`;
}
