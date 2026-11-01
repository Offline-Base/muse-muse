/**
 * The files cap's limits (docs/CAPABILITIES.md, section 10). The per-product numbers for the live namespace come from the
 * env (FILES_PRODUCT_MB, FILES_MAX_FILE_MB) and are passed in; everything else is fixed here.
 */
export const FILES_LIMITS = {
  /** Files one product keeps in its live namespace. */
  filesPerProduct: 2_000,
  /** What one visitor's or one signed-in person's files may add up to. */
  subjectBytes: 50 * 1024 * 1024,
  /** A build's own namespace, b:<buildId>, deleted when it ends. */
  buildBytes: 50 * 1024 * 1024,
  buildFiles: 200,
  /** A file's name as the product shows it. */
  nameMax: 120,
  /**
   * A ticket's upload URL is good for this long, and a person's open tickets count toward their own 50 MB for as long.
   * A product's totals count only ready files, checked again at done, so tickets nobody uses can't block anyone's
   * uploads. A ticket never finished is swept after `pendingMaxAgeMs`.
   */
  ticketValidMs: 15 * 60_000,
  pendingMaxAgeMs: 3_600_000,
  /** Open tickets one address may hold in a product at once (pending, not yet swept), so unused uploads stay small. */
  pendingPerAddress: 10,
  /** The read URL GET /files/<id> gives (a signed gateway URL) is good for this long. */
  readValidMs: 60 * 60_000,
  /** How long the redirect to a private blob is good for. Each read through the gateway signs a new one. */
  blobReadValidMs: 5 * 60_000,
  /** Every files and search call one token makes, a minute. */
  perTokenPerMinute: 120,
  /** Every call for one end user (their forwarded IP), a minute. */
  perIpPerMinute: 60,
  /** Upload tickets, per token a minute and per end user a minute. */
  ticketsPerTokenPerMinute: 30,
  ticketsPerIpPerMinute: 10,
  /** Reads of a signed file URL, per product and address a minute. A page of 50 pictures loads 50. */
  readsPerIpPerMinute: 300,
  pageDefault: 50,
  pageMax: 100,
  /** Search: one document's text, the docs in a product's index, hits per query and queries a minute. */
  docMaxBytes: 1024 * 1024,
  docsPerProduct: 2_000,
  docsPerBuild: 200,
  /** One visitor's or user's documents and text in a product's index (the owner has only the product's limits). */
  docsPerSubject: 200,
  textBytesPerSubject: 20 * 1024 * 1024,
  /** All the text in a product's index, and in a build's. */
  textBytesPerProduct: 200 * 1024 * 1024,
  textBytesPerBuild: 20 * 1024 * 1024,
  /** A document is indexed in chunks of about this many characters, so a hit can say where in the text it is. */
  chunkChars: 4_000,
  titleMax: 200,
  queryMax: 200,
  hitsMax: 10,
  queriesPerMinute: 30,
  snippetWords: 30,
  /** Datasets: reads per token a minute (the contract's 60), and per end user's address. */
  datasetReadsPerMinute: 60,
  /** A crashed build's files and index are cleared this long after its last write. */
  buildNamespaceMaxAgeMs: 24 * 3_600_000,
} as const;

/** The per-product numbers the env sets, for the live namespace. */
export interface FilesQuotas {
  productBytes: number;
  maxFileBytes: number;
}

/**
 * Content types a product may store. Raster images, audio, video and PDF are served as themselves; the plain text types
 * are always served as an attachment, never as a page (section 10, Guards). No SVG, HTML or script: nothing that runs.
 */
export const FILE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
] as const;
export type FileContentType = (typeof FILE_CONTENT_TYPES)[number];

export const isFileContentType = (v: unknown): v is FileContentType => typeof v === "string" && (FILE_CONTENT_TYPES as readonly string[]).includes(v);

/** True for a type a browser may show in place: an image, audio, video or a PDF. Anything else is downloaded. */
export const servedInline = (type: string) => /^(image|audio|video)\//.test(type) || type === "application/pdf";
