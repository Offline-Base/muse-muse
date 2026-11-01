import list from "@/lib/caps/files/datasets.json";

/**
 * The vetted public datasets (docs/CAPABILITIES.md, section 10): lib/caps/files/datasets.json, checked when it is read.
 * Every dataset names a license that allows redistribution, which a citation shows, and every file its size and
 * sha256, which the product's helper checks after reading it. A plain module with one JSON import, so the brief, the
 * catalog and the gateway read the same list.
 */

export interface DatasetFile {
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** A pinned https download of exactly these bytes, which the mirror script checks. */
  download: string;
  /** The Blob URL of the mirrored copy, or null until it is mirrored. */
  mirror: string | null;
}

export interface Dataset {
  id: string;
  title: string;
  why: string;
  license: { spdx: string; url: string };
  source: { name: string; url: string };
  attribution: string;
  files: DatasetFile[];
}

/** Licenses that allow copying a dataset onto the platform's mirror and passing it on, with attribution where asked. */
export const DATASET_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0", "ODC-PDDL-1.0", "ODC-By-1.0", "ODbL-1.0", "MIT", "Apache-2.0"]);

export const DATASET_ID = /^[a-z][a-z0-9-]{1,47}$/;
export const DATASET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{64}$/;
const TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;
const https = (v: unknown) => typeof v === "string" && /^https:\/\/[^\s]+$/.test(v);

/** The list, checked: ids and file names plain and each once, a size, a sha256, an https download, an allowed license. */
export function vettedDatasets(raw: unknown = list): Dataset[] {
  const datasets = (raw as { datasets?: unknown[] })?.datasets;
  if ((raw as { version?: unknown })?.version !== 1 || !Array.isArray(datasets)) throw new Error("lib/caps/files/datasets.json isn't a version 1 list.");
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return datasets.map((d, i) => {
    const x = d as Dataset;
    const where = `datasets.json entry ${i} (${String(x?.id)})`;
    if (typeof x?.id !== "string" || !DATASET_ID.test(x.id)) throw new Error(`${where} has no plain id.`);
    if (ids.has(x.id)) throw new Error(`${where} repeats an id.`);
    ids.add(x.id);
    for (const field of ["title", "why", "attribution"] as const) if (typeof x[field] !== "string" || !x[field].trim()) throw new Error(`${where} has no ${field}.`);
    if (!DATASET_LICENSES.has(x.license?.spdx) || !https(x.license?.url)) throw new Error(`${where} has a license that isn't on the list of ones that allow redistribution.`);
    if (typeof x.source?.name !== "string" || !https(x.source?.url)) throw new Error(`${where} has no source.`);
    if (!Array.isArray(x.files) || !x.files.length) throw new Error(`${where} has no files.`);
    const names = new Set<string>();
    for (const f of x.files) {
      const at = `${where}, file ${String(f?.name)}`;
      if (typeof f?.name !== "string" || !DATASET_FILE.test(f.name) || names.has(f.name)) throw new Error(`${at} has no plain name, or repeats one.`);
      names.add(f.name);
      if (!Number.isInteger(f.bytes) || f.bytes <= 0) throw new Error(`${at} has no size.`);
      if (typeof f.sha256 !== "string" || !SHA.test(f.sha256) || hashes.has(f.sha256)) throw new Error(`${at} has no sha256, or repeats one.`);
      hashes.add(f.sha256);
      if (typeof f.contentType !== "string" || !TYPE.test(f.contentType)) throw new Error(`${at} has no content type.`);
      if (!https(f.download)) throw new Error(`${at} has no https download.`);
      if (f.mirror !== null && !https(f.mirror)) throw new Error(`${at} has a mirror that isn't an https URL.`);
    }
    return x;
  });
}

/** The ids a brief may name. */
export function datasetIds(raw: unknown = list): string[] {
  return vettedDatasets(raw).map((d) => d.id);
}

/** The Blob path of a mirrored dataset file. */
export const datasetBlobPath = (id: string, file: string) => `datasets/${id}/${file}`;

/** One dataset and its file, or null. */
export function findDatasetFile(datasets: readonly Dataset[], id: string, file: string): { dataset: Dataset; file: DatasetFile } | null {
  if (!DATASET_ID.test(id) || !DATASET_FILE.test(file)) return null;
  const dataset = datasets.find((d) => d.id === id);
  const f = dataset?.files.find((x) => x.name === file);
  return dataset && f ? { dataset, file: f } : null;
}

/** What the gateway's list says about a dataset: no mirror or download address, a gateway URL per file instead. */
export function publicDataset(d: Dataset, gatewayUrl: string) {
  return {
    id: d.id,
    title: d.title,
    why: d.why,
    license: d.license,
    source: d.source,
    attribution: d.attribution,
    files: d.files.map((f) => ({ name: f.name, contentType: f.contentType, bytes: f.bytes, sha256: f.sha256, url: `${gatewayUrl}/datasets/${d.id}/${f.name}` })),
  };
}
