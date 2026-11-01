# Versions and the Code page

Every build of a product is a commit. `/p/<slug>/code` lists them with the change asked for, status, time and cost. For a build with saved source it shows the file tree, any file, the diff against the previous saved version, Download source and, for the owner or an admin, Restore this version.

## What is saved

When a build deploys, `startDeployStep` hands the exact files going to Vercel to `captureVersion` (`lib/versions/store.ts`).

- **Storage:** bytes go to `source/<productId>/<sha1>`, so an unchanged file is stored once. The list goes in `product_versions` (`drizzle/0028_versions.sql`), written last, so a row never names a missing file. A retry replaces the same row.
- **Failure:** a failed save logs and never stops the deploy. The commit then says "Source not kept".
- **Older builds:** builds from before this have no row and also say "Source not kept". There's no backfill, since old deployments can't be mapped to builds with certainty.
- **Deploy failures:** files are saved before Vercel builds them, so a build whose deploy then fails can have saved files. It can be read, but only a live or partial version can be restored.

## What never appears

`lib/versions/policy.ts` decides, on saving and again on reading.

- **Hidden paths** are never saved or shown: env files, `.mcp.json`, `.npmrc`, key files, `credentials.*`, `secrets.*`, the platform's build files (`brief.md`, `refine-N.md` and the like), `inspo/` and `fixtures/`.
- **Held files** look like they hold a secret (a Muse Muse token, a private key, common API key shapes) or are native programs. They are listed with their size, but the content is never stored.
- **Paths** requested from a page are only found by exact match in the saved list, and storage keys come from the SHA-1, so a crafted path reaches nothing. Storage URLs are never sent to a browser, though the blobs themselves are public-access at a URL holding the file's hash.

The secret check catches known shapes only. A password typed into code as plain text isn't caught, so anything a product's code holds should be treated as readable.

## Who can see it

The Code page follows the product's own page. Anyone who can open `/p/<slug>` can read its code, except that a product its owner switched off is only for the owner and admins, and a taken-down product has no page for anyone. Guests all share one account, so nothing here calls a build "yours", and a guest can't restore. Zips are counted per hour, per product and across the site.

## Restore

`POST /api/builds/<id>/restore` starts `restoreProduct`, a new build with kind `refine` and the message "Restore version N", so history only grows. It uses the same lock as a change, so it answers 409 while another build runs.

It writes the saved files to the sandbox, removes files that version didn't have, commits in the sandbox, deploys with a fresh token and registers. It runs no Muse Code and no judge, so it costs no Meta spend.

- Hidden and held files stay as they are, because they were never saved.
- Saved data rows don't roll back, and the demo video stays the newer one.
- The next change's prompt says the files were restored, because Muse Code's session remembers the later code.
- A restore that fails puts the live version's files back in the sandbox, when they were saved. If they weren't, the next change starts from the restored files.
