/**
 * Names the files cap shares (docs/CAPABILITIES.md, section 10). Scopes and who may add to a shared space are the data
 * cap's (lib/caps/data/types.ts), so a product that saves rows and files speaks of people the same way:
 *   shared   anyone on the product reads them; who adds follows `uploads` (the owner by default)
 *   visitor  one browser's (its mm_vid cookie)
 *   owner    the product's owner (the owner pass)
 *   user     a person who signed in with a passkey through Muse Muse
 * A plain file with no imports but the data cap's constants, so the schema, the gate and the brief agree.
 */
import { DATA_SCOPES, DATA_WRITERS, type DataScope, type DataWriters } from "@/lib/caps/data/types";

export const FILE_SCOPES = DATA_SCOPES;
export type FileScope = DataScope;
export const FILE_UPLOADERS = DATA_WRITERS;
export type FileUploaders = DataWriters;

export const isFileScope = (v: unknown): v is FileScope => typeof v === "string" && (FILE_SCOPES as readonly string[]).includes(v);
export const isFileUploaders = (v: unknown): v is FileUploaders => typeof v === "string" && (FILE_UPLOADERS as readonly string[]).includes(v);

/** A file's id: the gateway makes it (a UUID). */
export const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a search document says it came from: a stored file, or one item the product saved. */
export type SearchSource = { fileId: string } | { collection: string; docId: string };

/** The files rules a product works under: its one scope, and for a shared one who may add. */
export interface FilesRule {
  scope: FileScope;
  uploads: FileUploaders;
  search: boolean;
  datasets: string[];
}

/** FILES_SEARCH and FILES_DATASETS, read here as lib/env.ts reads a flag, so the brief can follow them without env. */
const on = (name: string) => ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
export const filesSearchOn = () => on("FILES_SEARCH");
export const filesDatasetsOn = () => on("FILES_DATASETS");
