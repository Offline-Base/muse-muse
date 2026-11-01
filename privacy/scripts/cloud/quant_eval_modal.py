"""Quantization eval for Muse Glimmer on one Modal GPU. Costs money: needs Ethan's go-ahead.

Compares Meta's Q4_K_M (the laptop build) with mradermacher's i1-IQ1_S (the Jetson build) and
i1-IQ1_M on four jobs, using the invented data in this repo and the prompts the device ships
(base/local_llm.py, base/router.py, base/workspace/agent.py):

  1. names:   the second pass for names on 20 essays, scored against the roster
  2. lookups: 20 router decisions on eval/tasks.jsonl items (5 per expected decision) that the
              device's router sends to the model, with production inputs built by egress's own
              helpers: the kind and job topics the connector sends, the guard's tags and keyword
              topics of the result and the request, and the request topics this model labels.
              Scored against each item's `expected`, as the model decided and after the router's
              rule path and floors (run on the laptop afterwards)
  3. grading: grade 10 tagged essays with the rubric, scored against the Q4_K_M grades
  4. topics:  the request-topics pass on up to 40 requests (the 20 lookups and up to 4 more eval
              tasks per policy topic), scored against the hand labels and the Q4_K_M labels
              (in-sample tasks: only the comparison with Q4_K_M means much)

It writes eval/reports/quantization.md with file sizes, tokens per second, quality and the command.
Tokens per second are on the cloud GPU, not on a Jetson.

    uv run python scripts/cloud/quant_eval_modal.py --check            # validate inputs, no compute
    uv run --with modal python scripts/cloud/quant_eval_modal.py --run # the paid run

modal is imported only for --run, so --help and --check work without it. Only folders marked
.synthetic, whose .synthetic-manifest.json lists every file in them, are ever sent. The prompts
are built here from base/ and sent in the payload; the container never imports base.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))  # base/ and eval/ for the local side; the container never imports them
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
N_NAMES, N_LOOKUPS, N_GRADES, N_TOPICS = 20, 20, 10, 40
TOPICS_PER_LABEL = 4  # extra topic requests per policy topic, beyond the lookups
TRUNCATION_CAP = 8000  # as base/local_llm.py


# -- local inputs ------------------------------------------------------------------------------


def shipped_prompts(request_topics: dict[str, str]) -> dict:
    """The device's own prompts, schemas and token budgets for each job, read from base/.

    Built on the laptop and sent in the payload, so the container runs exactly what ships.
    """
    from base.local_llm import NAMES_PROMPT, NAMES_SCHEMA, TOPICS_PROMPT, topics_schema
    from base.router import MAX_TOKENS, NO_RULES, ROUTE_SCHEMA, SYSTEM_PROMPT
    from base.workspace.agent import GRADE_SCHEMA, GRADE_SYSTEM
    from base.workspace.agent import MAX_TOKENS as GRADE_TOKENS
    from scripts.grade_crosscheck import GRADE_INSTRUCTIONS

    listed = "\n".join(f"- {name}: {desc}" for name, desc in request_topics.items())
    return {
        # 1500 is the default budget of LocalLLM.llm_names and LocalLLM.request_topics
        "names": {"system": NAMES_PROMPT, "schema": NAMES_SCHEMA, "max_tokens": 1500},
        "topics": {"system": f"{TOPICS_PROMPT}\n\nTopics:\n{listed}", "schema": topics_schema(list(request_topics)),
                   "names": list(request_topics), "max_tokens": 1500},  # fmt: skip
        "route": {"system": SYSTEM_PROMPT + NO_RULES, "schema": ROUTE_SCHEMA, "max_tokens": MAX_TOKENS},
        "grade": {"system": GRADE_SYSTEM, "schema": GRADE_SCHEMA, "max_tokens": GRADE_TOKENS,
                  "instructions": GRADE_INSTRUCTIONS},  # fmt: skip
    }


def is_synthetic(folder: Path, root: Path | None = None) -> bool:
    """The marker in the folder or a parent up to `root`, with a manifest beside it that lists every
    file under the marker's folder (base.config.synthetic_marked); one above `root` never counts.

    `root` defaults to the repo for a folder inside it (demo/.synthetic marks demo/essays), else
    to the folder's own parent, so a stray marker high above an --essays folder is ignored.
    """
    from base.config import synthetic_marked

    folder = folder.resolve()
    if root is None:
        root = REPO if folder.is_relative_to(REPO.resolve()) else folder.parent
    return synthetic_marked(folder, root)


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
    """Read essays, rubric, roster, eval items and policy. Returns (inputs, problems).

    inputs["route_inputs"] (id -> RouteInput without request topics) stays on the laptop for the
    router's floors; everything else listed in PAYLOAD_KEYS goes up.
    """
    problems: list[str] = []
    essay_dir = Path(args.essays) if args.essays else find_essay_dir(REPO)
    roster_path, tasks_path, policy_path = Path(args.roster), Path(args.tasks), Path(args.policy)
    inputs: dict = {"essays": [], "rubric": "", "people": [], "lookups": [], "topic_items": [], "request_topics": {},
                    "route_inputs": {}}  # fmt: skip
    from base import guard
    from base.policy import PolicyError, UserPolicy

    policy = None
    try:
        policy = UserPolicy.load(policy_path)
        inputs["request_topics"] = dict(policy.request_topics)
    except (OSError, PolicyError) as exc:
        problems.append(f"cannot read the policy ({type(exc).__name__})")
    try:
        roster = guard.load_roster(roster_path)
        inputs["people"] = roster_people(json.loads(roster_path.read_text()))
        if not inputs["people"]:
            problems.append("roster has no people")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        roster = None
        problems.append(f"cannot read roster ({type(exc).__name__})")
    tagmap = guard.TagMap(seed=0)  # in memory; tags only need to be consistent within this run

    def model_view(text: str) -> str:  # the agent's view: roster names and identifiers as tags
        return guard.tag(text, roster, tagmap).text if roster is not None else text

    if essay_dir is None or not essay_dir.is_dir():
        problems.append("no essay folder: pass --essays or add demo/essays")
    else:
        if not is_synthetic(essay_dir):
            problems.append(f"{essay_dir.name} has no .synthetic marker with a .synthetic-manifest.json that lists "
                            "every file in it; only invented data goes to the cloud")
        rubric = Path(args.rubric) if args.rubric else find_rubric(essay_dir)
        inputs["rubric"] = model_view(rubric.read_text()) if rubric.is_file() else ""
        if not inputs["rubric"].strip():
            problems.append("rubric.md is missing or empty")
        files = sorted(p for p in essay_dir.glob("*.md") if p.name not in ("rubric.md", "README.md"))
        files += sorted(essay_dir.glob("*.txt"))
        inputs["essays"] = [{"file": p.name, "text": p.read_text()} for p in files]
        if len(inputs["essays"]) < N_NAMES:
            problems.append(f"need {N_NAMES} essays, found {len(inputs['essays'])} in {essay_dir.name}")

    for essay in inputs["essays"]:
        essay["names"] = expected_names(essay["text"], inputs["people"])
        essay["tagged"] = model_view(essay["text"])

    try:
        items = [json.loads(line) for line in tasks_path.read_text().splitlines() if line.strip()]
    except (OSError, ValueError) as exc:
        items = []
        problems.append(f"cannot read eval items ({type(exc).__name__})")
    if items and policy is not None and roster is not None:
        picked = pick_lookups(items)
        for item in picked:
            row, inp = production_input(item, roster, tagmap, policy)
            inputs["lookups"].append(row)
            inputs["route_inputs"][item["id"]] = inp
        inputs["topic_items"] = [
            {"id": i["id"], "request": i["request"], "labels": hand_labels(i, inputs["request_topics"])}
            for i in pick_topic_items(items, {i["id"] for i in picked}, inputs["request_topics"])
        ]
    if items and len(inputs["lookups"]) < N_LOOKUPS:
        problems.append(f"need {N_LOOKUPS // 4} eval items per expected decision, found {len(inputs['lookups'])} total")
    return inputs, problems


PAYLOAD_KEYS = ("essays", "rubric", "lookups", "topic_items")


def production_kind(item: dict) -> str:
    """The kind the connector sends with this item's result (eval/run_eval.py production_labels)."""
    from eval.run_eval import production_labels

    return production_labels(item)[0]


def pick_lookups(items: list[dict]) -> list[dict]:
    """5 items per expected decision, in file order, among those the device's router sends to the
    model (a document list or a dreaming report takes the rule path with no model call)."""
    from base.router import RULE_KINDS

    picked: list[dict] = []
    for decision in DECISIONS:
        ok = [i for i in items if i.get("expected") == decision and production_kind(i) not in RULE_KINDS]
        picked += ok[: N_LOOKUPS // 4]
    return picked


def pick_topic_items(items: list[dict], skip: set[str], request_topics: dict[str, str]) -> list[dict]:
    """Up to TOPICS_PER_LABEL more items per policy request topic that carry that hand label, in
    file order, never one already picked; kinds egress gives no topic pass are left out."""
    from base.egress import NO_TOPIC_PASS

    picked: list[dict] = []
    for topic in request_topics:
        fits = [i for i in items if i["id"] not in skip and production_kind(i) not in NO_TOPIC_PASS
                and topic in hand_labels(i, request_topics)]  # fmt: skip
        for item in fits[:TOPICS_PER_LABEL]:
            skip.add(item["id"])
            picked.append(item)
    return picked[: N_TOPICS - N_LOOKUPS]


def hand_labels(item: dict, request_topics: dict[str, str]) -> list[str]:
    from scripts.check_request_topics import label

    return [t for t in request_topics if label(item, t)]


def production_input(item: dict, roster, tagmap, policy) -> tuple[dict, object]:
    """One eval item as the device's egress would route it (eval/run_eval.py release_item), built
    with egress's own helpers: the kind and job topics production_labels gives, the guard's tags,
    blocked reasons and keyword topics of the result, never-share keywords in the raw and tagged
    request (`request_blocked` for those only the request names) and the request's identifier
    hits. `topic_pass` is False where egress skips the request-topic pass (the result's own
    never-share topics already refuse). The name pass is taken as perfect here (the item's
    `other_names`); job 1 measures it on its own. Returns the payload row and the RouteInput."""
    from base import guard
    from base.egress import needs_topic_pass, request_keyword_topics, route_input
    from base.router import REQUEST_LIMIT, TEXT_LIMIT, _scrub
    from eval.run_eval import production_labels

    kind, job_topics = production_labels(item)
    tagged = guard.tag(item["result"], roster, tagmap, llm_names=lambda _text: list(item.get("other_names") or []),
                       never_share=policy.never_share)  # fmt: skip
    asked = guard.tag(item["request"], roster, tagmap)
    own = list(dict.fromkeys([*job_topics, *tagged.topics]))
    found = request_keyword_topics(item["request"], asked.text, policy.never_share)
    summary = item.get("summary") if kind == "per_student" else None
    inp = route_input(asked, kind, tagged, own, found, policy.never_share, summary)
    # Scrubbed and cut as base.router.build_user_message does, so the container only formats lines.
    secrets = [h.value for h in inp.hits if h.value and len(h.value) >= 3]
    text = _scrub(tagged.text, secrets)
    text = text[:TEXT_LIMIT] + " [truncated]" if len(text) > TEXT_LIMIT else text
    row = {"id": item["id"], "request": _scrub(inp.request, secrets)[:REQUEST_LIMIT], "result_kind": kind,
           "text": text, "hit_kinds": sorted({h.kind for h in inp.hits}), "blocked": list(tagged.blocked),
           "keyword_topics": list(inp.topics), "topic_pass": needs_topic_pass(kind, tagged, own, policy),
           "expected": item["expected"], "labels": hand_labels(item, policy.request_topics)}  # fmt: skip
    return row, inp


def final_decisions(results: dict, route_inputs: dict, policy) -> None:
    """Add `final` to each lookup row: what the device's router decides when the model answers as
    this model did, so the rule path and the floors apply as on the device. Runs on the laptop."""
    from dataclasses import replace

    from base.router import Router

    class Answer:  # stands in for the model call with the decision the model really gave
        def __init__(self, decision):
            self.decision = decision

        def chat_json(self, *_args, **_kw):
            if self.decision not in DECISIONS:
                raise ValueError("no decision")
            return {"decision": self.decision, "reason": "model"}

    for result in results.values():
        for row in result.get("lookups") or []:
            inp = route_inputs.get(row["id"])
            if inp is None:
                continue
            topics = list(dict.fromkeys([*inp.topics, *(row.get("topics") or [])]))
            router = Router(None, Answer(row.get("got")), policy, rules_text="")
            row["final"] = router.decide(replace(inp, topics=topics)).decision


# -- prompts and requests (used in the container: no base imports below this line) ------------


def with_reasoning_line(messages: list[dict], level: str = "low") -> list[dict]:
    """As base/local_llm.py: Glimmer reads `Reasoning strength: <level>` from the system prompt."""
    line = f"Reasoning strength: {level}"
    out = [dict(m) for m in messages]
    if out and out[0].get("role") == "system":
        content = out[0].get("content") or ""
        if isinstance(content, str) and "reasoning strength:" not in content.lower():
            out[0]["content"] = f"{line}\n\n{content}" if content else line
        return out
    return [{"role": "system", "content": line}, *out]


def response_format(schema: dict) -> dict:
    """As base/local_llm.py: strict json_schema, from a plain schema or a {name, schema} wrapper."""
    if "schema" in schema and "type" not in schema:
        inner = {"name": schema.get("name", "result"), "strict": schema.get("strict", True), "schema": schema["schema"]}
    else:
        inner = {"name": "result", "strict": True, "schema": schema}
    return {"type": "json_schema", "json_schema": inner}


def request_body(messages: list[dict], schema: dict, max_tokens: int) -> dict:
    """The body LocalLLM.build_body sends to llama-server (tested to stay the same)."""
    return {
        "model": "glimmer",
        "messages": with_reasoning_line(messages),
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"reasoning_strength": "low"},
        "response_format": response_format(schema),
    }


def names_messages(essay: str, prompt: dict) -> list[dict]:
    return [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": essay}]


def topics_messages(request: str, prompt: dict) -> list[dict]:
    return [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": request}]


def route_messages(item: dict, topics: list[str], prompt: dict) -> list[dict]:
    """base.router.build_user_message for this item (tested to stay the same), no learned rules.
    The text and request were scrubbed and cut on the laptop (production_input)."""
    user = "\n".join([
        f"Request: {item.get('request') or ''}",
        f"Result kind: {item.get('result_kind')}",
        f"Topics: {', '.join(topics) or 'none'}",
        f"Blocked: {'; '.join(item.get('blocked') or []) or 'none'}",
        f"Found and tagged: {', '.join(item.get('hit_kinds') or []) or 'none'}",
        "Learned rule for this result: none",
        "Tagged text:",
        item.get("text") or "",
    ])  # fmt: skip
    return [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": user}]


def grade_messages(essay: str, rubric: str, prompt: dict) -> list[dict]:
    """The agent's grading step: the teacher's instructions, the rubric and one tagged essay."""
    user = f"Teacher's instructions:\n{prompt['instructions']}\n\nRubric:\n{rubric}\n\nEssay:\n{essay}"
    return [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": user}]


def grade_total(answer: dict | None) -> int | None:
    """Sum of the four scores clamped to 1..4, as the agent recomputes it; else the given total."""
    scores = (answer or {}).get("scores")
    if isinstance(scores, dict) and scores and all(isinstance(v, int) for v in scores.values()):
        return sum(min(4, max(1, v)) for v in scores.values())
    total = (answer or {}).get("total")
    return total if isinstance(total, int) else None


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
    """One shipped request at temperature 0 (the device leaves temperature unset; 0 keeps the
    models comparable). A reply cut off before any content is retried once with double the budget,
    as the device does."""
    import urllib.request

    for budget in (max_tokens, min(max_tokens * 2, TRUNCATION_CAP)):
        body = request_body(messages, schema, budget) | {"temperature": 0}
        req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})  # fmt: skip
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.load(resp)
        choice = data["choices"][0]
        content = choice["message"].get("content") or ""
        if content.strip() or choice.get("finish_reason") != "length" or budget >= TRUNCATION_CAP:
            break
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
    """Run the four jobs against one llama-server. `reference` holds the Q4_K_M results, if known.

    payload["prompts"] comes from shipped_prompts(); a hand-built payload without it gets the
    same prompts with no request topics (only possible on the laptop, where base imports).
    """
    prompts = payload.get("prompts") or shipped_prompts({})
    timings: list[dict] = []
    errors: dict[str, int] = {}
    out: dict = {"names": [], "lookups": [], "grades": [], "topics": [], "parse_failures": 0, "request_errors": errors}

    def ask(job: str, messages: list[dict]) -> dict | None:
        answer, t = safe_chat(url, messages, prompts[job]["schema"], prompts[job]["max_tokens"], errors)
        timings.append(t)
        out["parse_failures"] += answer is None
        return answer

    def label(request: str) -> list[str]:
        names = prompts["topics"].get("names") or []
        if not names or not request.strip():
            return []  # no call, as LocalLLM.request_topics
        found = {str(t) for t in (ask("topics", topics_messages(request, prompts["topics"])) or {}).get("topics") or []}
        return [n for n in names if n in found]

    for essay in payload["essays"][:N_NAMES]:
        answer = ask("names", names_messages(essay["text"], prompts["names"]))
        out["names"].append({"expected": essay["names"], "found": (answer or {}).get("names") or []})

    for item in payload["lookups"][:N_LOOKUPS]:
        found = label(item["request"])  # scored in job 4 either way
        routed = found if item.get("topic_pass", True) else []  # egress skips the pass when the result refuses
        topics = list(dict.fromkeys([*(item.get("keyword_topics") or []), *routed]))
        answer = ask("route", route_messages(item, topics, prompts["route"]))
        out["lookups"].append({"id": item["id"], "expected": item["expected"], "got": (answer or {}).get("decision"),
                               "topics": routed})  # fmt: skip
        out["topics"].append({"id": item["id"], "labels": item.get("labels") or [], "found": found})

    for item in payload.get("topic_items") or []:
        out["topics"].append({"id": item["id"], "labels": item["labels"], "found": label(item["request"])})

    for i, essay in enumerate(payload["essays"][:N_GRADES]):
        # "tagged" is the agent's model view, made on the laptop; a hand-built payload may leave it out
        answer = ask("grade", grade_messages(essay.get("tagged", essay["text"]), payload["rubric"], prompts["grade"]))
        ref = (reference or {}).get("grades", [None] * N_GRADES)[i]
        out["grades"].append({"file": essay["file"], "total": grade_total(answer),
                              "reference_total": None if ref is None else ref.get("total")})  # fmt: skip

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


def score(result: dict, reference: dict | None = None) -> dict:
    expected = found = matched = 0
    for row in result["names"]:
        got = " ".join(row["found"]).lower()
        expected += len(row["expected"])
        matched += sum(1 for name in row["expected"] if any(part.lower() in got for part in name.split()))
        found += len(row["found"])
    lookups = result["lookups"]
    correct = sum(1 for r in lookups if r["got"] == r["expected"])
    finals = [r for r in lookups if "final" in r]
    pairs = [(g["total"], g["reference_total"]) for g in result["grades"]
             if isinstance(g["total"], int) and isinstance(g["reference_total"], int)]
    topics = result.get("topics") or []
    tp = sum(len(set(r["found"]) & set(r["labels"])) for r in topics)
    said = sum(len(r["found"]) for r in topics)
    labeled = sum(len(r["labels"]) for r in topics)
    ref = {r["id"]: set(r["found"]) for r in (reference or {}).get("topics") or []}
    shared = [r for r in topics if r["id"] in ref]
    return {
        "names_recall": matched / expected if expected else None,
        "names_found": found,
        "lookup_accuracy": correct / len(lookups) if lookups else None,
        "final_accuracy": sum(r["final"] == r["expected"] for r in finals) / len(finals) if finals else None,
        "grade_exact": sum(a == b for a, b in pairs) / len(pairs) if pairs else None,
        "grade_mad": sum(abs(a - b) for a, b in pairs) / len(pairs) if pairs else None,
        "topics_n": len(topics),
        "topics_precision": tp / said if said else None,
        "topics_recall": tp / labeled if labeled else None,
        "topics_exact": sum(set(r["found"]) == set(r["labels"]) for r in topics) / len(topics) if topics else None,
        "topics_same_as_reference": sum(set(r["found"]) == ref[r["id"]] for r in shared) / len(shared) if shared else None,
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
        "temperature 0 (the device leaves it unset), reasoning strength low, the device's own prompts and "
        "schemas. Tokens per second are on this cloud GPU, not on a Jetson. All inputs are invented.",
        "",
        "| Model | File size | Prompt tok/s | Generate tok/s | Names recall (20 essays) | Lookups correct (20) "
        "| Grades equal to Q4_K_M (10) | Mean total difference vs Q4_K_M | JSON failures |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    reference = results.get("Q4_K_M") if not results.get("Q4_K_M", {}).get("failed") else None
    scored = {label: score(r, reference) for label, r in results.items() if not r.get("failed")}
    for label, r in results.items():
        if r.get("failed"):
            lines.append(f"| {label} | not run: {r['failed']} | | | | | | | |")
            continue
        s = scored[label]
        mad = "n/a" if s["grade_mad"] is None else f"{s['grade_mad']:.2f}"
        lines.append(
            f"| {label} | {r['size_bytes'] / 1e9:.1f} GB | {r['prompt_tps']} | {r['gen_tps']} | {pct(s['names_recall'])} "
            f"| {pct(s['lookup_accuracy'])} | {pct(s['grade_exact']) if label != 'Q4_K_M' else 'reference'} "
            f"| {mad if label != 'Q4_K_M' else 'reference'} | {r['parse_failures']} |"
        )
    if any(s["final_accuracy"] is not None or s["topics_n"] for s in scored.values()):
        lines += [
            "",
            "| Model | Lookups correct after the router's rule path and floors | Request topics: precision "
            "| Recall | Same labels as the hand labels | Same labels as Q4_K_M |",
            "|---|---|---|---|---|---|",
        ]
        for label, s in scored.items():
            same = "reference" if label == "Q4_K_M" else pct(s["topics_same_as_reference"])
            lines.append(f"| {label} | {pct(s['final_accuracy'])} | {pct(s['topics_precision'])} "
                         f"| {pct(s['topics_recall'])} | {pct(s['topics_exact'])} of {s['topics_n']} | {same} |")
    errors = {label: r.get("request_errors") for label, r in results.items() if r.get("request_errors")}
    if errors:
        lines += ["", "Requests that failed (counted as JSON failures above): "
                  + "; ".join(f"{label} {json.dumps(e, sort_keys=True)}" for label, e in errors.items())]
    lines += ["", "Files:", ""]
    lines += [f"- {label}: `{r['repo']}` / `{r['file']}`, {r.get('seconds', 0)} s for all four jobs"
              for label, r in results.items()]
    lines += ["", f"llama-server flags (the Jetson unit's): `{' '.join(JETSON_FLAGS)}`."]
    lines += ["", "Lookups are router decisions on eval/tasks.jsonl items (5 per expected decision) that the device "
              "sends to the model, with production inputs built by egress's own helpers: the kind and job topics "
              "of eval/run_eval.py production_labels, the guard's tags and keyword topics of the result, "
              "never-share keywords and identifiers in the request, and the request topics the same model labeled "
              "(where egress runs that pass). The name pass is taken as perfect there (each item's other_names "
              "are tagged); job 1 measures it. \"Lookups correct\" is the model's own decision; the second table "
              "runs the device's router on the laptop with that decision, so its rule path and floors apply. "
              "Request topics are scored on the 20 lookups and up to 4 more eval tasks per policy topic that carry "
              "its hand label (class_level is a class_aggregate item). These are in-sample: the tasks were picked "
              "for their labels and the topic descriptions were written with them in view, so only the comparison "
              "with Q4_K_M means much; held-out numbers are in eval/reports/request_topics.md.", ""]
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
    print(f"roster people: {len(inputs['people'])}, lookups: {len(inputs['lookups'])}, "
          f"topic requests: {len(inputs['lookups']) + len(inputs['topic_items'])}, "
          f"request topics in the policy: {len(inputs['request_topics'])}")  # fmt: skip
    print("prompts: base/local_llm.py (names, request topics), base/router.py, base/workspace/agent.py (grading)")
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

    # Only what the jobs need goes up; the roster and the RouteInputs stay here.
    payload = {"models": models, "prompts": shipped_prompts(inputs["request_topics"]),
               **{k: inputs[k] for k in PAYLOAD_KEYS}}  # fmt: skip
    app, fn = build_app()
    with app.run():
        results = fn.remote(payload)
    from base.policy import UserPolicy

    final_decisions(results, inputs["route_inputs"], UserPolicy.load(args.policy))
    command = "uv run --with modal python scripts/cloud/quant_eval_modal.py --run" + (
        f" --q4-repo {args.q4_repo}" if args.q4_repo != MODELS["Q4_K_M"][0] else "")
    write_report(results, command, Path(args.out))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
