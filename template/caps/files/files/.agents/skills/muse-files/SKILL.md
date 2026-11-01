---
name: muse-files
description: How a Muse Muse product keeps files people upload, searches their text with sources shown, and reads vetted public datasets. Read it when brief.md has a "Files and search" section.
---

# Keeping files, search and datasets

The brief's `files` block says what people keep, in which scope, who adds to a shared space, whether the product
searches, and which vetted datasets it reads. `brief.md`'s "Files and search" section has this product's exact choices.

## Uploads

In a client component:

```tsx
import { uploadFile, UploadError } from "@/lib/platform/files-browser";

<input type="file" data-testid="file-upload" accept="image/*,application/pdf,text/plain"
  onChange={async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const kept = await uploadFile(file, { scope: "shared" });
      // kept: { id, name, contentType, bytes, url, ... }
    } catch (err) {
      if (err instanceof UploadError) setError(err.message); // plain words, show them next to the button
    }
  }} />
```

`uploadFile` goes through the product's own `/api/musemuse/files` route, sends the bytes straight to storage, and asks
the gateway to check them. Pictures, audio, video, PDF and plain text (txt, csv, md, json), up to 25 MB a file.

## On the server

```ts
import { files } from "@/lib/platform/files";

const page = await files(request).list({ scope: "shared" }); // { items, next }
const one = await files(request).get(id);                   // facts and a read URL good for an hour, or null
await files(request).delete(id);                            // true or false; only the owner deletes shared files
```

Always pass the incoming request (or `await headers()` in a server action). Show a picture with `<img src={file.url}>`.
Read a file's bytes on the server with `fetch(file.url)`. A link is good for an hour: get the file again for a new one.

## Search (when the brief searches)

```ts
import { search } from "@/lib/platform/search";

await search(request).index({ source: { fileId: kept.id }, text });            // a file's text; title is its name
await search(request).index({ source: { collection: "notes", docId }, title, text }); // a saved item's text
const hits = await search(request).query(q); // [{ title, snippet, citation }]
```

- Index a file's text right after its upload. Plain text as it is. For a PDF or a photo, ask Muse Wonder for its text
  with `metaClient(request)` first: that spends from the product's Meta budget, so do it once per file.
- Every answer built from a hit shows `<Citation citation={hit.citation} />` from `components/platform/Citation.tsx`
  beside it. Never present something as from a file without one.
- The search box has `data-testid="file-search"` and searches on Enter.

## Datasets (when the brief names one)

```ts
import { dataset } from "@/lib/platform/datasets";
import { Citation, datasetCitation } from "@/components/platform/Citation";

const penguins = dataset(request, "palmer-penguins");
const csv = await penguins.text("penguins.csv"); // checked against its sha256
const info = await penguins.info();             // title, license, source, attribution
// beside what you show from it:
<Citation citation={datasetCitation(info)} />
```

The license must be on screen wherever the data is used.

## Rules

- Files in a shared space are seen by everyone on the product. Never put personal details there, and say on the
  upload button who will see the file.
- Files are kept until someone deletes them, not for a day. Say so, and give people a delete button.
- Limits a person can hit: 25 MB a file, 50 MB a person, 500 MB and 2,000 files for the product. A refused upload is an
  `UploadError` (browser) or `FilesError` (server) with a plain message: show it.
- In a build every file is a real file in the build's own test space, deleted when the build ends.

## Smoke test

```ts
import { checkFiles, openAsOwner } from "./caps/files";

test("files", async ({ page }) => {
  // await openAsOwner(page); // when only the owner adds files
  await checkFiles(page, {
    upload: "fixtures/field-notes.txt",
    listed: "field-notes.txt",
    search: { q: "heron", expect: "Herons nest" },   // when the brief searches
    dataset: { shows: "Adelie" },                    // when the brief names a dataset
  });
});
```

Call it once. Keep the smoke test to about 20 files and search calls. These files are platform files: wrap them,
never edit them: `lib/platform/files.ts`, `lib/platform/files-browser.ts`, `lib/platform/search.ts`,
`lib/platform/datasets.ts`, `components/platform/Citation.tsx`, `app/api/musemuse/files`, `tests/caps/files.ts`.
