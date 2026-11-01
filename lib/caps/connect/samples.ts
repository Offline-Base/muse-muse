import nws from "@/lib/caps/connect/samples/nws.json";
import openlibrary from "@/lib/caps/connect/samples/openlibrary.json";
import usgs from "@/lib/caps/connect/samples/usgs.json";
import wikipedia from "@/lib/caps/connect/samples/wikipedia.json";
import airtable from "@/lib/caps/connect/samples/services/airtable.json";
import github from "@/lib/caps/connect/samples/services/github.json";
import notion from "@/lib/caps/connect/samples/services/notion.json";
import openweathermap from "@/lib/caps/connect/samples/services/openweathermap.json";

/**
 * Recorded samples a build token gets instead of an outside call (docs/CAPABILITIES.md, 2.7). Public APIs' samples were
 * recorded from the real APIs on Oct 31 and trimmed; services' are made up in the shape of their docs, since nobody's
 * key was used. Imported, so they ship with the function that serves them.
 */
export interface Sample {
  status: number;
  data: unknown;
}

/** By API id, then path id. */
export const API_SAMPLES: Readonly<Record<string, Readonly<Record<string, readonly Sample[]>>>> = {
  nws: nws as unknown as Record<string, Sample[]>,
  wikipedia: wikipedia as unknown as Record<string, Sample[]>,
  openlibrary: openlibrary as unknown as Record<string, Sample[]>,
  usgs: usgs as unknown as Record<string, Sample[]>,
};

/** By service id, then "METHOD path pattern" as services.json writes the call. */
export const SERVICE_SAMPLES: Readonly<Record<string, Readonly<Record<string, readonly Sample[]>>>> = {
  github: github as unknown as Record<string, Sample[]>,
  openweathermap: openweathermap as unknown as Record<string, Sample[]>,
  airtable: airtable as unknown as Record<string, Sample[]>,
  notion: notion as unknown as Record<string, Sample[]>,
};
