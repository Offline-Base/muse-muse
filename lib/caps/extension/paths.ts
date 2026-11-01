/** Where a product's latest extension zip is kept (docs/CAPABILITIES.md, 2.10: the `extensions` prefix). */
export const extensionZipPath = (productId: string) => `extensions/${productId}/latest.zip`;

/** The file name a download is saved as. */
export const extensionFileName = (slug: string) => `${slug}-extension.zip`;
