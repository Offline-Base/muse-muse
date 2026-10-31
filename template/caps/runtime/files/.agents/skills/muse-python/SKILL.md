---
name: muse-python
description: How a Muse Muse product runs small Python functions next to its Next.js app, with packages from PyPI. Read it when brief.md has a "Python functions" section.
---

# Python functions

brief.md's "Python functions" section lists each function, what goes in and what comes out, and the packages. Python
does the computing. Everything else stays in TypeScript: pages, actions, model calls, validation.

## The shape

Each function is one file, `api/py/<name>.py`, with a class named `handler`. Vercel serves it at `/api/py/<name>`,
next to the Next.js app. Keep each file self-contained: no imports from other files in the product.

```python
import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"null")
            result = {"total": sum(float(x) for x in data["values"])}
            self.reply(200, result)
        except (KeyError, TypeError, ValueError) as err:
            self.reply(400, {"error": f"That input doesn't work here: {err}"})

    def reply(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
```

- JSON in, JSON out. Answer 400 with `{"error": "..."}` in plain words for input that doesn't work.
- Plain JSON values only: convert numpy numbers and arrays with `.item()` or `.tolist()` before `json.dumps`.
- Under 10 seconds and 4.5 MB each way. Nothing is kept between calls, and nothing runs in the background.
- No model calls, keys, tokens or other services from Python, and no network at all. The action calls the model in
  TypeScript and passes what Python needs in the body.
- No web frameworks (Flask, FastAPI, Django and the like): with one in `requirements.txt` Vercel runs the whole project as
  that app, and the Next.js app stops working.
- `api/py/musemuse_health.py` and `vercel.json` are platform files. Leave them as they are, and add nothing else to
  `vercel.json`.

## Packages

List them in `requirements.txt`, one per line, pinned as `name==version`. Pick versions with wheels for Python 3.12, which
Vercel runs, and for the build machine's Python, which `node scripts/py-local.mjs doctor` prints. Then run
`node scripts/py-local.mjs install`. It installs wheels from PyPI outside the product folder, so nothing large is
deployed. The build machine reaches PyPI for downloads only.

## Calling it from an action

The action route stays in TypeScript and the UI calls the action, never `/api/py/` directly:

```ts
// app/api/actions/fit_curve/route.ts
import { z } from "zod";
import { CapError, callPython } from "@/lib/platform/python";

const Input = z.object({ points: z.array(z.tuple([z.number(), z.number()])).min(2).max(500) });

export async function POST(request: Request) {
  const parsed = Input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send at least 2 points." }, { status: 400 });
  try {
    const fit = await callPython<{ slope: number; intercept: number }>(request, "fit_curve", parsed.data);
    return Response.json(fit);
  } catch (err) {
    if (err instanceof CapError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
```

`callPython(request, name, input)` runs `api/py/<name>.py` on Vercel through the deployment's own `/api/py/<name>`, and
on the build machine through `scripts/py-local.mjs`. Always pass the request.

## Trying it

- `echo '{"values": [1, 2]}' | node scripts/py-local.mjs call sum_values` runs one function and prints its reply.
- `node scripts/py-local.mjs doctor` lists the functions it finds and the Python it uses.

## The smoke test

Run one Python-backed action through its route with the platform's helper, and assert the reply's shape:

```ts
import { expectPythonAction } from "./caps/runtime";

test("the fit comes from Python", async ({ request }) => {
  const fit = await expectPythonAction<{ slope: number }>(request, "fit_curve", { points: [[0, 1], [1, 3], [2, 5]] });
  expect(typeof fit.slope).toBe("number");
});
```

It records the check. Then verify's caps step loads every function, runs `musemuse_health`, and runs each function your
smoke test used again on the same input with the platform's own runner. A reply of a different shape fails the check, so
keep functions deterministic: no random numbers or clock times in the reply's keys.
