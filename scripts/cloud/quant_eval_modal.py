"""Quantization eval for Muse Glimmer on one Modal GPU. Costs money: needs Ethan's go-ahead.

Compares Meta's Q4_K_M (the laptop build) with mradermacher's i1-IQ1_S (the Jetson build) and
i1-IQ1_M on three jobs, using the invented data in this repo:

  1. names:   list the person names in 20 essays, scored against the roster
  2. lookups: 20 routing decisions on eval/tasks.jsonl items (5 per expected decision),
              scored against each item's `expected`
  3. grading: grade 10 essays with the rubric, scored against the Q4_K_M grades

It writes eval/reports/quantization.md with file sizes, tokens per second, quality and the command.
Tokens per second are on the cloud GPU, not on a Jetson.

    uv run python scripts/cloud/quant_eval_modal.py --check            # validate inputs, no compute
    uv run --with modal python scripts/cloud/quant_eval_modal.py --run # the paid run

modal is imported only for --run, so --help and --check work without it. Only folders marked
.synthetic are ever sent.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LLAMA_CPP_REF = "b10353"  # or newer
GPU = "L40S"
CUDA_ARCH = "89"  # L40S
DECISIONS = ("share_tagged", "share_summary", "ask_user", "refuse")

# label -> (Hugging Face repo, file). Q4_K_M is Meta's published GGUF; the 1-bit files are mradermacher's.
MODELS = {
    "Q4_K_M": ("meta-models/Muse-Glimmer-30B-GGUF", "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf"),
    "i1-IQ1_S": ("mradermacher/Muse-Glimmer-30B-i1-GGUF", "Muse-Glimmer-30B.i1-IQ1_S.gguf"),
    "i1-IQ1_M": ("mradermacher/Muse-Glimmer-30B-i1-GGUF", "Muse-Glimmer-30B.i1-IQ1_M.gguf"),
}
N_NAMES, N_LOOKUPS, N_GRADES = 20, 20, 10

NAMES_SCHEMA = {
    "type": "object",
    "properties": {"names": {"type": "array", "items": {"type": "string"}}},
    "required": ["names"],
    "additionalProperties": False,
}
ROUTE_SCHEMA = {
    "type": "object",
    "properties": {"decision": {"type": "string", "enum": list(DECISIONS)}, "reason": {"type": "string"}},
    "required": ["decision", "reason"],
    "additionalProperties": False,
}
GRADE_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"criterion": {"type": "string"}, "score": {"type": "integer", "minimum": 1, "maximum": 4}},
                "required": ["criterion", "score"],
                "additionalProperties": False,
            },
        },
        "total": {"type": "integer"},
    },
    "required": ["scores", "total"],
    "additionalProperties": False,
}


# -- local inputs ------------------------------------------------------------------------------


def is_synthetic(folder: Path, root: Path | None = None) -> bool:
    """The marker in the folder or a parent up to `root`; one above it never counts.

    `root` defaults to the repo for a folder inside it (demo/.synthetic marks demo/essays), else
    to the folder's own parent, so a stray marker high above an --essays folder is ignored.
    """
    folder = folder.resolve()
    if root is None:
        root = REPO if folder.is_relative_to(REPO.resolve()) else folder.parent
    root = root.resolve()
    for p in (folder, *folder.parents):
        if not p.is_relative_to(root):
            return False
        if (p / ".synthetic").is_file():
            return True
    return False


def find_essay_dir(root: Path) -> Path | None:
    """demo/essays if it exists, else the first folder under demo/ that holds a rubric.md."""
    if (root / "demo" / "essays").is_dir():
        return root / "demo" / "essays"
    found = sorted((root / "demo").rglob("rubric.md")) if (root / "demo").is_dir() else []
    return found[0].parent if found else None


def find_rubric(essay_dir: Path) -> Path:
    """rubric.md next to the essays, or one folder up."""
    here = essay_dir / "rubric.md"
    return here if here.is_file() else essay_dir.parent / "rubric.md"


def roster_people(roster: dict) -> list[dict]:
    people = []
    for p in [roster.get("teacher") or {}, *(roster.get("students") or [])]:
        if p.get("name") or p.get("first"):
            people.append(p)
    return people


def name_forms(person: dict) -> list[str]:
    forms = [person.get("name"), person.get("first"), person.get("last"), *(person.get("nicknames") or [])]
    return [f for f in forms if f]


def expected_names(text: str, people: list[dict]) -> list[str]:
    """Roster people mentioned in the text, by any of their name forms (word-bounded)."""
    hits = []
    for person in people:
        if any(re.search(rf"\b{re.escape(f)}\b", text) for f in name_forms(person)):
            hits.append(person.get("name") or person.get("first"))
    return hits


def load_inputs(args: argparse.Namespace) -> tuple[dict, list[str]]:
    """Read essays, rubric, roster, eval items and policy. Returns (inputs, problems)."""
    problems: list[str] = []
    essay_dir = Path(args.essays) if args.essays else find_essay_dir(REPO)
    roster_path, tasks_path, policy_path = Path(args.roster), Path(args.tasks), Path(args.policy)
    inputs: dict = {"essays": [], "rubric": "", "people": [], "lookups": [], "policy": ""}

    if essay_dir is None or not essay_dir.is_dir():
        problems.append("no essay folder: pass --essays or add demo/essays")
    else:
        if not is_synthetic(essay_dir):
            problems.append(f"{essay_dir.name} has no .synthetic marker; only invented data goes to the cloud")
        rubric = Path(args.rubric) if args.rubric else find_rubric(essay_dir)
        inputs["rubric"] = rubric.read_text() if rubric.is_file() else ""
        if not inputs["rubric"].strip():
            problems.append("rubric.md is missing or empty")
        files = sorted(p for p in essay_dir.glob("*.md") if p.name not in ("rubric.md", "README.md"))
        files += sorted(essay_dir.glob("*.txt"))
        inputs["essays"] = [{"file": p.name, "text": p.read_text()} for p in files]
        if len(inputs["essays"]) < N_NAMES:
            problems.append(f"need {N_NAMES} essays, found {len(inputs['essays'])} in {essay_dir.name}")

    try:
        inputs["people"] = roster_people(json.loads(roster_path.read_text()))
        if not inputs["people"]:
            problems.append("roster has no people")
    except (OSError, ValueError) as exc:
        problems.append(f"cannot read roster ({type(exc).__name__})")

    try:
        items = [json.loads(line) for line in tasks_path.read_text().splitlines() if line.strip()]
        inputs["lookups"] = pick_lookups(items)
        if len(inputs["lookups"]) < N_LOOKUPS:
            problems.append(f"need {N_LOOKUPS // 4} eval items per expected decision, found {len(inputs['lookups'])} total")
    except (OSError, ValueError) as exc:
        problems.append(f"cannot read eval items ({type(exc).__name__})")

    inputs["policy"] = policy_path.read_text() if policy_path.is_file() else ""
    for essay in inputs["essays"]:
        essay["names"] = expected_names(essay["text"], inputs["people"])
    return inputs, problems


def pick_lookups(items: list[dict]) -> list[dict]:
    """5 items per expected decision, in file order, with names swapped for tags."""
    picked: list[dict] = []
    for decision in DECISIONS:
        for item in [i for i in items if i.get("expected") == decision][: N_LOOKUPS // 4]:
            text = item.get("result", "")
            for n, name in enumerate(sorted(item.get("names") or [], key=len, reverse=True)):
                text = text.replace(name, f"[Person {n + 1}]")
            picked.append({"id": item.get("id"), "request": item.get("request", ""), "result_kind": item.get("result_kind", ""),
                           "text": text, "expected": decision})
    return picked


# -- prompts (used in the container) -----------------------------------------------------------


def names_messages(essay: str) -> list[dict]:
    return [
        {"role": "system", "content": "Reasoning strength: low\nList every person name that appears in the text, "
         "exactly as written. Answer with JSON {\"names\": [...]}."},
        {"role": "user", "content": essay},
    ]


def route_messages(item: dict, policy: str) -> list[dict]:
    return [
        {"role": "system", "content": "Reasoning strength: low\nYou are the privacy router on the user's device. "
         "Decide how this result may leave for Muse: share_tagged, share_summary, ask_user or refuse. "
         "Follow the user's policy.\n\nPolicy:\n" + policy + "\n\nAnswer with JSON {\"decision\": ..., \"reason\": ...}."},
        {"role": "user", "content": f"Request: {item['request']}\nResult kind: {item['result_kind']}\nResult:\n{item['text']}"},
    ]


def grade_messages(essay: str, rubric: str) -> list[dict]:
    return [
        {"role": "system", "content": "Reasoning strength: low\nGrade the essay against the rubric. Score each "
         "criterion from 1 to 4. Answer with JSON {\"scores\": [{\"criterion\": ..., \"score\": ...}], \"total\": ...}."
         "\n\nRubric:\n" + rubric},
        {"role": "user", "content": essay},
    ]


# -- container side ----------------------------------------------------------------------------


def parse_json(text: str) -> dict | None:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def chat(url: str, messages: list[dict], schema: dict, max_tokens: int = 2500) -> tuple[dict | None, dict]:
    import urllib.request

    body = {
        "model": "glimmer",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0,
        "chat_template_kwargs": {"reasoning_strength": "low"},
        "response_format": {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}},
    }
    req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.load(resp)
    content = data["choices"][0]["message"].get("content") or ""
    return parse_json(content), data.get("timings") or {}


# The flags the Jetson's muse-privacy-glimmer.service uses, so quality is measured on the setup
# the board really runs (a 4096 context, no prompt cache or checkpoints, a small ubatch).
JETSON_FLAGS = ["-c", "4096", "-np", "1", "-ngl", "99", "-ub", "128", "-b", "512", "--swa-full",
                "--ctx-checkpoints", "0", "--cache-ram", "0", "--no-mmproj", "--jinja"]


def safe_chat(url: str, messages: list[dict], schema: dict, max_tokens: int, errors: dict) -> tuple[dict | None, dict]:
    """chat(), with a failed request counted by error type instead of ending the paid run."""
    try:
        return chat(url, messages, schema, max_tokens)
    except Exception as exc:  # urllib errors, timeouts, a response without choices
        name = type(exc).__name__
        errors[name] = errors.get(name, 0) + 1
        return None, {}


def run_jobs(url: str, payload: dict, reference: dict | None) -> dict:
    """Run the three jobs against one llama-server. `reference` holds the Q4_K_M grades, if known."""
    timings: list[dict] = []
    errors: dict[str, int] = {}
    out: dict = {"names": [], "lookups": [], "grades": [], "parse_failures": 0, "request_errors": errors}

    for essay in payload["essays"][:N_NAMES]:
        answer, t = safe_chat(url, names_messages(essay["text"]), NAMES_SCHEMA, 2000, errors)
        timings.append(t)
        out["parse_failures"] += answer is None
        out["names"].append({"expected": essay["names"], "found": (answer or {}).get("names") or []})

    for item in payload["lookups"][:N_LOOKUPS]:
        answer, t = safe_chat(url, route_messages(item, payload["policy"]), ROUTE_SCHEMA, 2000, errors)
        timings.append(t)
        out["parse_failures"] += answer is None
        out["lookups"].append({"id": item["id"], "expected": item["expected"], "got": (answer or {}).get("decision")})

    for i, essay in enumerate(payload["essays"][:N_GRADES]):
        answer, t = safe_chat(url, grade_messages(essay["text"], payload["rubric"]), GRADE_SCHEMA, 3000, errors)
        timings.append(t)
        out["parse_failures"] += answer is None
        ref = (reference or {}).get("grades", [None] * N_GRADES)[i]
        out["grades"].append({"file": essay["file"], "total": (answer or {}).get("total"),
                              "reference_total": None if ref is None else ref.get("total")})

    prompt_n = sum(t.get("prompt_n", 0) for t in timings)
    prompt_ms = sum(t.get("prompt_ms", 0) for t in timings)
    gen_n = sum(t.get("predicted_n", 0) for t in timings)
    gen_ms = sum(t.get("predicted_ms", 0) for t in timings)
    out["prompt_tps"] = round(prompt_n / (prompt_ms / 1000), 1) if prompt_ms else None
    out["gen_tps"] = round(gen_n / (gen_ms / 1000), 1) if gen_ms else None
    out["generated_tokens"] = gen_n
    return out


def remote_eval(payload: dict) -> dict:
    """Runs on the GPU: download each GGUF, serve it with llama-server, run the jobs."""
    import os
    import subprocess
    import urllib.request

    from huggingface_hub import hf_hub_download

    results: dict = {}
    for label, (repo, filename) in payload["models"].items():
        path = hf_hub_download(repo, filename, cache_dir="/cache")
        proc = subprocess.Popen(["/llama.cpp/build/bin/llama-server", "--model", path, "--alias", "glimmer",
                                 "--host", "127.0.0.1", "--port", "8080", *JETSON_FLAGS])
        try:
            for _ in range(900):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2) as r:
                        if r.status == 200:
                            break
                except OSError:
                    pass
                if proc.poll() is not None:
                    raise RuntimeError(f"llama-server exited while loading {label}")
                time.sleep(1)
            started = time.time()
            result = run_jobs("http://127.0.0.1:8080", payload, results.get("Q4_K_M"))
            result.update(size_bytes=os.path.getsize(path), seconds=round(time.time() - started), file=filename, repo=repo)
            results[label] = result
        except Exception as exc:  # one model that will not load must not lose the others' results
            results[label] = {"failed": type(exc).__name__, "file": filename, "repo": repo}
        finally:
            proc.terminate()
            proc.wait(timeout=60)
    return results


def build_app():
    """Define the Modal app. Only called for --run, so modal is not needed otherwise."""
    import modal

    image = (
        modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.12")
        .apt_install("git", "build-essential", "cmake")
        .pip_install("huggingface_hub>=0.30")
        .run_commands(
            f"git clone --depth 1 --branch {LLAMA_CPP_REF} https://github.com/ggml-org/llama.cpp /llama.cpp",
            f"cmake -S /llama.cpp -B /llama.cpp/build -DGGML_CUDA=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release "
            f"-DCMAKE_CUDA_ARCHITECTURES={CUDA_ARCH}",
            "cmake --build /llama.cpp/build --config Release -j 8 --target llama-server",
        )
    )
    cache = modal.Volume.from_name("muse-privacy-hf-cache", create_if_missing=True)
    app = modal.App("muse-privacy-quant-eval")
    fn = app.function(image=image, gpu=GPU, timeout=4 * 3600, volumes={"/cache": cache},
                      secrets=[modal.Secret.from_name("huggingface")], serialized=True)(remote_eval)
    return app, fn


# -- report ------------------------------------------------------------------------------------


def score(result: dict) -> dict:
    expected = found = matched = 0
    for row in result["names"]:
        got = " ".join(row["found"]).lower()
        expected += len(row["expected"])
        matched += sum(1 for name in row["expected"] if any(part.lower() in got for part in name.split()))
        found += len(row["found"])
    lookups = result["lookups"]
    correct = sum(1 for r in lookups if r["got"] == r["expected"])
    pairs = [(g["total"], g["reference_total"]) for g in result["grades"]
             if isinstance(g["total"], int) and isinstance(g["reference_total"], int)]
    return {
        "names_recall": matched / expected if expected else None,
        "names_found": found,
        "lookup_accuracy": correct / len(lookups) if lookups else None,
        "grade_exact": sum(a == b for a, b in pairs) / len(pairs) if pairs else None,
        "grade_mad": sum(abs(a - b) for a, b in pairs) / len(pairs) if pairs else None,
    }


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.0f}%"


def write_report(results: dict, command: str, out: Path) -> None:
    lines = [
        "# Glimmer quantization eval",
        "",
        f"Command: `{command}`",
        "",
        f"Run {time.strftime('%Y-%m-%d %H:%M %Z')} on one Modal {GPU} with llama.cpp {LLAMA_CPP_REF}, "
        "temperature 0, reasoning strength low. Tokens per second are on this cloud GPU, not on a Jetson. "
        "All inputs are invented.",
        "",
        "| Model | File size | Prompt tok/s | Generate tok/s | Names recall (20 essays) | Lookups correct (20) "
        "| Grades equal to Q4_K_M (10) | Mean total difference vs Q4_K_M | JSON failures |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for label, r in results.items():
        if r.get("failed"):
            lines.append(f"| {label} | not run: {r['failed']} | | | | | | | |")
            continue
        s = score(r)
        mad = "n/a" if s["grade_mad"] is None else f"{s['grade_mad']:.2f}"
        lines.append(
            f"| {label} | {r['size_bytes'] / 1e9:.1f} GB | {r['prompt_tps']} | {r['gen_tps']} | {pct(s['names_recall'])} "
            f"| {pct(s['lookup_accuracy'])} | {pct(s['grade_exact']) if label != 'Q4_K_M' else 'reference'} "
            f"| {mad if label != 'Q4_K_M' else 'reference'} | {r['parse_failures']} |"
        )
    errors = {label: r.get("request_errors") for label, r in results.items() if r.get("request_errors")}
    if errors:
        lines += ["", "Requests that failed (counted as JSON failures above): "
                  + "; ".join(f"{label} {json.dumps(e, sort_keys=True)}" for label, e in errors.items())]
    lines += ["", "Files:", ""]
    lines += [f"- {label}: `{r['repo']}` / `{r['file']}`, {r.get('seconds', 0)} s for all three jobs"
              for label, r in results.items()]
    lines += ["", f"llama-server flags (the Jetson unit's): `{' '.join(JETSON_FLAGS)}`."]
    lines += ["", "Lookups are routing decisions on eval/tasks.jsonl items (5 per expected decision), with the "
              "item's names replaced by tags before the model sees them.", ""]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    raw = out.parent / "raw" / (out.stem + ".json")
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text(json.dumps(results, indent=2))


# -- main --------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Glimmer quantization eval on Modal (paid; needs Ethan's go-ahead).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="validate the inputs locally; no network, no compute")
    mode.add_argument("--run", action="store_true", help="run on Modal (costs money)")
    parser.add_argument("--essays", help="folder of essays (default: demo/essays)")
    parser.add_argument("--rubric", help="rubric file (default: rubric.md beside the essays or one folder up)")
    parser.add_argument("--roster", default=str(REPO / "eval" / "roster.json"))
    parser.add_argument("--tasks", default=str(REPO / "eval" / "tasks.jsonl"))
    parser.add_argument("--policy", default=str(REPO / "eval" / "user_policy.yaml"))
    parser.add_argument("--q4-repo", default=MODELS["Q4_K_M"][0], help="Hugging Face repo with Meta's Q4_K_M GGUF")
    parser.add_argument("--out", default=str(REPO / "eval" / "reports" / "quantization.md"))
    args = parser.parse_args(argv)
    if not (args.check or args.run):
        parser.print_help()
        return 0

    inputs, problems = load_inputs(args)
    models = dict(MODELS, Q4_K_M=(args.q4_repo, MODELS["Q4_K_M"][1]))
    print(f"essays: {len(inputs['essays'])} (names job uses {N_NAMES}, grading uses {N_GRADES})")
    print(f"roster people: {len(inputs['people'])}, lookups: {len(inputs['lookups'])}, policy: "
          f"{'yes' if inputs['policy'] else 'none'}")
    for label, (repo, filename) in models.items():
        print(f"model {label}: {repo}/{filename}")
    print(f"GPU: {GPU}, llama.cpp {LLAMA_CPP_REF}; see scripts/cloud/README.md for cost")
    if problems:
        for p in problems:
            print(f"problem: {p}", file=sys.stderr)
        return 1
    if args.check:
        print("inputs ok")
        return 0

    # Only what the jobs need goes up; the roster stays here (expected names are already computed).
    payload = {"models": models, **{k: inputs[k] for k in ("essays", "rubric", "lookups", "policy")}}
    app, fn = build_app()
    with app.run():
        results = fn.remote(payload)
    command = "uv run --with modal python scripts/cloud/quant_eval_modal.py --run" + (
        f" --q4-repo {args.q4_repo}" if args.q4_repo != MODELS["Q4_K_M"][0] else "")
    write_report(results, command, Path(args.out))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
