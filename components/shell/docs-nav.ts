import { docsNav, type LocalNavSection } from "@/lib/docs/pages";

/**
 * The docs sidebar (content/meta-docs/nav.json with its links mapped into /docs), computed once per server process
 * and handed to the shell as props. Server only: lib/docs/pages also reads the mirror from disk. One shared array, so
 * the sidebar and the mobile drawer pass the same object.
 */
export const DOCS_NAV: LocalNavSection[] = docsNav();
