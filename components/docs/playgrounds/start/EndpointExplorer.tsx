"use client";

import { useId, useState } from "react";
import { ApiConsole } from "@/components/docs/playgrounds/common/ApiConsole";
import { API_BASE_URL } from "@/components/docs/playgrounds/start/facts";
import { endpointExample, endpointsByResource, ENDPOINTS } from "@/components/docs/playgrounds/start/reference";
import styles from "@/components/docs/playgrounds/start/start.module.css";

/**
 * The API reference index as an explorer: every endpoint the reference covers, grouped by resource, and the kit's API
 * console on the one picked, opened with a request that works through the docs proxy. Ids in paths (a response, a
 * file) are filled from what the reader created on this page; the realtime WebSocket links to its own page instead.
 */
export function EndpointExplorer({ endpoint: initial = "responses.create" }: { slug: string; endpoint?: string }) {
  const id = useId();
  const [picked, setPicked] = useState(() => endpointExample(initial)?.id ?? ENDPOINTS[0].id);
  const e = endpointExample(picked) ?? ENDPOINTS[0];
  return (
    <div className="pg">
      <p className={`${styles.small} pg-advanced`}>
        Base URL <code>{API_BASE_URL}</code> · <code>Authorization: Bearer $MODEL_API_KEY</code> · the live console adds Muse
        Muse&apos;s key on the server, so you never paste one here.
      </p>
      <div className={styles.endpoints} role="group" aria-label="Endpoints">
        {endpointsByResource().map((g, gi) => (
          <div key={g.resource} className={styles.endpointGroup}>
            <p className={styles.endpointResource} id={`${id}-group-${gi}`}>
              {g.resource}
            </p>
            <ul className={styles.endpointList} aria-labelledby={`${id}-group-${gi}`}>
            {g.endpoints.map((x) => (
              <li key={x.id}>
                <button type="button" className={styles.endpoint} aria-pressed={x.id === e.id} onClick={() => setPicked(x.id)}>
                  <span className={`pg-method pg-method-${x.method === "GET" && !x.runnable ? "get" : x.method.toLowerCase()}`}>
                    {x.runnable ? x.method : "WSS"}
                  </span>
                  <span className={styles.endpointRoute} title={x.route}>
                    {x.route.replace(/^\/v1/, "")}
                    <span className="sr-only">: {x.summary}</span>
                  </span>
                  <span className={styles.endpointCost}>{x.cost}</span>
                </button>
              </li>
            ))}
            </ul>
          </div>
        ))}
      </div>
      <div className={styles.sideHead}>
        <p className="pg-title">
          {e.summary} <span className="pg-meta">{e.route}</span>
        </p>
        <a className={styles.link} href={`/docs/${e.slug}`}>
          Reference page
        </a>
      </div>
      {e.note ? <p className="pg-hint">{e.note}</p> : null}
      {e.runnable ? (
        <ApiConsole key={e.id} method={e.method} path={e.path} body={e.body} form={e.form} fileSlots={e.fileSlots} />
      ) : (
        <p className="pg-hint">
          The handshake, the audio frames and the server events are on{" "}
          <a className={styles.link} href={`/docs/${e.slug}`}>
            the realtime reference page
          </a>
          .
        </p>
      )}
    </div>
  );
}
