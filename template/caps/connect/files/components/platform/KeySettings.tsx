// Platform file (Muse Muse platform services). Don't edit: put it on a settings screen only the owner opens.
//
// The owner's keys for the outside services this product uses. A key is typed once, saved by Muse Muse, and never
// shown again, here or anywhere: the product only ever sees its name and when it was saved. No script: small forms.
//   const keys = await secrets(await headers()).list();
//   <KeySettings keys={keys} returnTo="/settings" />
import type { KeyList } from "@/lib/platform/secrets";

export function KeySettings({ keys, returnTo = "/", status }: { keys: KeyList; returnTo?: string; status?: string | null }) {
  const saved = new Map(keys.keys.map((k) => [k.service, k]));
  const services = [...new Map(keys.services.map((s) => [s.service, s])).values()];
  return (
    <section className="card stack" aria-label="Keys for outside services">
      <div className="card-head">
        <h3>Your keys</h3>
      </div>
      <p className="hint">Each key stays with Muse Muse and is added to this product&apos;s calls there. Nobody sees it again after you save it, you included.</p>
      {status ? (
        <p className={status === "saved" || status === "removed" ? "note" : "error"} role="status" data-testid="key-status">
          {status === "saved" ? "Saved." : status === "removed" ? "Removed." : "That key wasn't saved. Check it and try again."}
        </p>
      ) : null}
      {services.map((s) => {
        const have = saved.get(s.service);
        return (
          <div key={s.service} className="stack" data-testid={`key-${s.service}`}>
            <form method="post" action="/api/musemuse/connect-keys" className="fields" autoComplete="off">
              <input type="hidden" name="action" value="save" />
              <input type="hidden" name="service" value={s.service} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <div className="field">
                <label htmlFor={`key-${s.service}-value`}>{s.label}</label>
                <input id={`key-${s.service}-value`} name="value" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={4096} data-testid={`key-input-${s.service}`} placeholder={have ? "Saved. Paste a new key to replace it." : "Paste the key"} />
                <p className="hint">
                  {s.keyHint} {s.why}
                </p>
              </div>
              <div className="row">
                <button type="submit" className="primary" data-testid={`key-save-${s.service}`}>
                  {have ? "Replace key" : "Save key"}
                </button>
                {have ? <span className="chip">Saved {new Date(have.savedAt).toLocaleDateString("en-US")}</span> : null}
              </div>
            </form>
            {have ? (
              <form method="post" action="/api/musemuse/connect-keys" className="row">
                <input type="hidden" name="action" value="remove" />
                <input type="hidden" name="name" value={have.name} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button type="submit" className="text">
                  Remove key
                </button>
              </form>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
