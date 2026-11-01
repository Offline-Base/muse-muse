---
name: muse-python
description: How a Muse Muse product runs small Python functions next to its Next.js app, with packages from PyPI. Read it when brief.md has a "Python functions" section.
---

# Python functions

brief.md's "Python functions" section lists each function, what goes in and what comes out, and the packages. Python
does the computing. Everything else stays in TypeScript: pages, actions, model calls, validation.

## What a function is, and who can reach it

Each function is one file, `api/py/<name>.py`. Vercel serves it at `/api/py/<name>`, next to the Next.js app. That
address is public: anyone can send it anything, without going through your action. On a deployment the function also
runs with the product's settings in its environment. So every function:

- starts with the platform's guard, exactly as below. It clears the product's settings before any other code in the
  file runs, and refuses every call that doesn't carry the header `callPython` sends. Verify's `guard` check runs each
  function and fails one without it.
- checks its own input: types, sizes and allowed values of every field it uses, as if the action's checks didn't exist.
- never reads text from the input as code. No `eval`, `exec`, `compile`, `pickle`, `yaml.load`, pandas `eval` or
  `query`, and no `sympify` or `parse_expr`. Most sympy functions read a string with `eval` too, so never pass a string
  from the input to sympy at all. Verify's `safe` check refuses these. To work with a formula a person typed, parse it
  in TypeScript into a small tree of numbers, variable names and operators, send that as JSON, and build the sympy
  expression from it with `Symbol`, `Integer`, `Rational` and the operators.

`node scripts/py-local.mjs new <name>` writes a new function with the guard and a `do_POST` to fill in. Start there.

## The shape

```python
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler


# Muse Muse guard. Keep it first and as it is. On a deployment every function gets the product's settings, and anyone
# can call /api/py/<name>. This clears the settings before any other code here runs, and refuses every call that
# doesn't come from the product's own server (callPython sends the header).
def _musemuse_key():
    token = os.environ.pop("PRODUCT_TOKEN", "")
    for name in ("GATEWAY_URL", "VERCEL_OIDC_TOKEN"):
        os.environ.pop(name, None)
    return hmac.new(token.encode(), b"musemuse-python-v1", hashlib.sha256).hexdigest() if token else ""


_MUSEMUSE_KEY = _musemuse_key()


class MuseMuseGuard(BaseHTTPRequestHandler):
    def parse_request(self):
        if not super().parse_request():
            return False
        if _MUSEMUSE_KEY and not hmac.compare_digest(self.headers.get("X-MuseMuse-Python", ""), _MUSEMUSE_KEY):
            self.close_connection = True
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": "This function answers only its own product."}')
            return False
        return True

    def log_message(self, format, *args):
        pass
# End of the Muse Muse guard.


class handler(MuseMuseGuard):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"null")
            values = data["values"]
            if not isinstance(values, list) or not 1 <= len(values) <= 1000:
                raise ValueError("send 1 to 1000 values")
            result = {"total": sum(float(x) for x in values)}
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

- The class is named `handler` and subclasses `MuseMuseGuard`. Don't override `parse_request` or `handle` in it.
- JSON in, JSON out. Answer 400 with `{"error": "..."}` in plain words for input that doesn't work.
- Plain JSON values only: convert numpy numbers and arrays with `.item()` or `.tolist()` before `json.dumps`.
- Under 10 seconds and 4.5 MB each way. Nothing is kept between calls, and nothing runs in the background.
- No model calls, keys, tokens or other services from Python, and no network at all. The action calls the model in
  TypeScript and passes what Python needs in the body.
- Keep each file self-contained: no imports from other files in the product, and nothing from the environment.
- No web frameworks (Flask, FastAPI, Django and the like): with one in `requirements.txt` Vercel runs the whole project as
  that app, and the Next.js app stops working.
- `api/py/musemuse_health.py`, `vercel.json` and `.python-version` are platform files. Leave them as they are, and add
  nothing else to `vercel.json`.

## Packages

List them in `requirements.txt`, one per line, pinned as `name==version`. Pick versions with wheels for Python 3.14: the
build machine runs it, and `.python-version` makes Vercel run the same one. Then run `node scripts/py-local.mjs install`.
It installs wheels from PyPI outside the product folder, so nothing large is deployed. The build machine reaches PyPI for
downloads only. A call never installs anything: until you run `install`, a function with packages fails and says so.

Every function is deployed with all of `requirements.txt`, and Vercel allows one Python function 500 MB. Verify's `size`
check fails when the installed packages take more than 450 MB. numpy with one or two more packages fits; numpy, scipy
and pandas together is already large. Never torch, tensorflow or the like.

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

`callPython(request, name, input)` runs `api/py/<name>.py` on Vercel through the deployment's own `/api/py/<name>`,
with the guard's header, and on the build machine through `scripts/py-local.mjs`. Always pass the request.

## Trying it

- `echo '{"values": [1, 2]}' | node scripts/py-local.mjs call sum_values` runs one function and prints its reply.
- `node scripts/py-local.mjs doctor` lists the functions it finds and the Python it uses.
- On the build machine a function can't open the product's `.env` files.

## The smoke test

Run one Python-backed action through its route with the platform's helper, and assert the reply's shape:

```ts
import { expectPythonAction } from "./caps/runtime";

test("the fit comes from Python", async ({ request }) => {
  const fit = await expectPythonAction<{ slope: number }>(request, "fit_curve", { points: [[0, 1], [1, 3], [2, 5]] });
  expect(typeof fit.slope).toBe("number");
});
```

It records the check. Then verify's caps step loads every function, runs the guard and `musemuse_health`, and runs each
function your smoke test used again on the same input with the platform's own runner. A reply of a different shape fails
the check, so keep functions deterministic: no random numbers or clock times in the reply's keys. Every call is noted,
but only an input of 64 KB or less is kept to run again, so give the smoke test at least one small input (a small image
rather than a photo) when you can.
