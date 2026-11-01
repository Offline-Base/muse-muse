import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { dataSignInOn } from "@/lib/caps/data/types";
import { vettedDatasets } from "@/lib/caps/files/datasets";
import { filesDatasetsOn, filesSearchOn } from "@/lib/caps/files/types";

/**
 * The brief writer's catalog section for the files cap (docs/CAPABILITIES.md, section 10). Read per call, since it
 * follows FILES_SEARCH, FILES_DATASETS and DATA_SIGN_IN. The vetted datasets are listed by id and license.
 */
export function filesCatalogBlock(opts: { search?: boolean; datasets?: boolean; signIn?: boolean } = {}): string {
  const search = opts.search ?? filesSearchOn();
  const datasets = (opts.datasets ?? filesDatasetsOn()) ? vettedDatasets() : [];
  const signIn = opts.signIn ?? dataSignInOn();
  const scopes = signIn
    ? "Shared files everyone on the product sees; visitor files stay with one browser; owner files are the product owner's; user files follow a person who signs in."
    : "Shared files everyone on the product sees; visitor files stay with one browser; owner files are the product owner's.";
  return [
    `- files (Keeping files): a product can keep files people upload (pictures, audio, video, PDF, plain text) on the platform, with no 24-hour limit. ${scopes} Pick it only when the muse needs files people come back to. Files with personal details never go in a shared space. 25 MB a file, 500 MB and 2,000 files a product, 50 MB a person.`,
    ...(search ? ["- files.search: the product can index the text of its files and saved items and search it, and every answer shows where it came from (the file or item, and where in its text). Text inside a PDF or a photo comes from the product's own Muse Wonder call first."] : []),
    ...(datasets.length
      ? [`- files.datasets: vetted public datasets a product can read, each with its license shown where it's used: ${datasets.map((d) => `${d.id} (${d.title}, ${d.license.spdx})`).join("; ")}.`]
      : []),
  ].join("\n");
}

export const FILES_CATALOG: CapCatalogEntry = {
  name: "kept files",
  get block() {
    return filesCatalogBlock();
  },
};
