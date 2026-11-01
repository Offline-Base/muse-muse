"""The local agent: runs one private task over a workspace folder. See docs/CONTRACTS.md, Workspace.

Every step that sees document text runs on this device's Glimmer, or through the heavy-step hook on
the user's own laptop. Feedback files with real names, and the full result of any other task
(RESULT_FILE), are written only under settings.paths.output / job id.
raw_result keeps real names and stays on the device; summary has no names. Nothing here sends
anything to Muse: the connector releases results through egress.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from statistics import mean
from typing import Any

from base import events
from base.config import CloudBackendRefused, Settings, assert_synthetic, synthetic_marked
from base.regions import mark_uncovered, reads_uncovered
from base.types import Roster
from base.workspace.index import Doc, DocumentIndex, WorkspacePathError
from base.workspace.jobs import JobStore
from base.workspace.scans import ScanError

log = logging.getLogger(__name__)

CRITERIA = ("ideas", "organization", "evidence", "conventions")
GRADING_WORDS = re.compile(r"\b(grad(e|es|ed|ing)|feedback|scor(e|es|ed|ing)|rubrics?)\b", re.IGNORECASE)
RUBRIC_NAME = "rubric.md"
RESULT_FILE = "result.md"  # a generic task's full answer with real names, saved under output/<job id>/
TOPICS_GRADING = ["grades", "writing"]
MAX_DOC_CHARS = 24_000
MAX_REDUCE_CHARS = 48_000
MAX_TOKENS = 3000  # reasoning counts against this, so keep it well above 1500
REASONING = "low"

_SCORE = {"type": "integer", "minimum": 1, "maximum": 4}
GRADE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "object",
            "properties": {c: _SCORE for c in CRITERIA},
            "required": list(CRITERIA),
            "additionalProperties": False,
        },
        "total": {"type": "integer"},
        "strengths": {"type": "string"},
        "next_step": {"type": "string"},
        "feedback": {"type": "string"},
    },
    "required": ["scores", "total", "strengths", "next_step", "feedback"],
    "additionalProperties": False,
}
ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}

GRADE_SYSTEM = (
    f"Reasoning strength: {REASONING}\n"
    "You help a teacher grade one student essay against the teacher's rubric. Score each criterion "
    "(ideas, organization, evidence, conventions) as a whole number from 1 to 4. total is the sum of "
    "the four scores. strengths: one or two sentences. next_step: one short sentence naming the single "
    "most useful thing to work on next, without the student's name. feedback: one warm, specific "
    "paragraph written to the student. Reply with JSON only."
)
MAP_SYSTEM = (
    f"Reasoning strength: {REASONING}\n"
    "You help a teacher with their own documents on their own device. Apply the teacher's instructions "
    'to the one document below. Reply with JSON {"answer": "..."}. If the document has nothing that '
    "the instructions need, say so in one sentence."
)
REDUCE_SYSTEM = (
    f"Reasoning strength: {REASONING}\n"
    "You help a teacher with their own documents on their own device. Below are answers to the same "
    "instructions, one per document. Combine them into one clear answer to the instructions. "
    'Reply with JSON {"answer": "..."}.'
)
NAME_NOISE = frozenset({"essay", "draft", "final", "feedback", "assignment", "copy", "revised"})


class StepError(ValueError):
    """A model step returned something that does not fit its schema. Messages hold no document text."""


class AgentBusy(RuntimeError):
    """Too many private tasks are queued or running; the message is plain and has no content."""


MAX_ACTIVE_JOBS = 5  # queued plus running; more are refused until one finishes
STOPPED = "The device was stopped before the job finished."


class Agent:
    def __init__(
        self,
        settings: Settings,
        llm: Any,
        index: DocumentIndex,
        jobs: JobStore,
        heavy: Any = None,
        roster: Roster | None = None,
        tagmap: Any = None,
        restore: Callable[[str, dict[str, str]], str] | None = None,
    ):
        self.settings = settings
        self.llm = llm
        self.index = index
        self.jobs = jobs
        self.heavy = heavy
        self.roster = roster
        self.tagmap = tagmap
        self.restore = restore
        self._active = 0
        self._active_lock = threading.Lock()
        self._create_lock = threading.Lock()
        # One job at a time on the device (one model slot), two on the cloud backend.
        self._slots = threading.Semaphore(2 if settings.is_cloud_backend else 1)
        self._stop = threading.Event()
        self._scratch_tags: Any = None

    # entry points

    def run_private_task(self, instructions: str, folder: str | None) -> str:
        """Queue the task and return its job id at once; the work runs in a daemon thread.

        Raises AgentBusy when MAX_ACTIVE_JOBS are already queued or running, so a looping caller
        cannot start unlimited threads and model calls.
        """
        with self._create_lock:
            active = getattr(self.jobs, "active_count", lambda: 0)()
            if active >= MAX_ACTIVE_JOBS:
                raise AgentBusy(f"The device is busy with {active} tasks. Try again when one finishes.")
            job_id = self.jobs.create("private_task", instructions, folder)
        threading.Thread(
            target=self._run_queued, args=(job_id, instructions, folder), name=f"job-{job_id}", daemon=True
        ).start()
        return job_id

    def stop(self) -> None:
        """Stop starting model steps: steps already queued fail at once instead of calling a model."""
        self._stop.set()

    def _run_queued(self, job_id: str, instructions: str, folder: str | None) -> None:
        with self._slots:  # waits, still "queued", while another job uses the model
            self._run(job_id, instructions, folder)

    def run_sync(self, instructions: str, folder: str | None) -> str:
        """Same as run_private_task but finishes before returning (tests and the eval)."""
        job_id = self.jobs.create("private_task", instructions, folder)
        self._run(job_id, instructions, folder)
        return job_id

    # the job

    def _run(self, job_id: str, instructions: str, folder: str | None) -> None:
        with self._active_lock:
            self._active += 1
        events.emit("working", job_id)
        try:
            self.jobs.start(job_id)
            raw, summary, kind, topics, sources = self._work(job_id, instructions, folder)
            self.jobs.finish(job_id, raw, kind, summary=summary, topics=topics, sources=sources)
        except Exception as exc:  # the job records a short reason; the thread must not die loudly
            log.warning("job %s failed: %s", job_id, type(exc).__name__)
            try:
                self.jobs.fail(job_id, short_error(exc))
            except Exception:
                log.warning("job %s could not be marked failed", job_id)
        finally:
            with self._active_lock:
                self._active -= 1
                idle = self._active == 0
            if idle:
                events.settle(job_id)  # amber again if the user still has a card to answer

    def _work(self, job_id: str, instructions: str, folder: str | None):
        """(raw, summary, kind, topics, sources). `sources` are the doc ids the job read (the
        rubric too), so egress applies the user's controls and the image checks to the real
        pages, not the folder name. With SAM_ENABLED=1, an image read while covering was off is
        marked (regions.mark_uncovered), so its result is kept even once that toggle is off."""
        text = self._restore(instructions)  # real names, for choosing what to do on the device
        path = self.index.resolve(folder)
        assert_synthetic(self.settings, path)
        synthetic = is_marked(path, self.index.root)  # True only for folders marked as invented data
        uncovered = reads_uncovered(self.index)
        docs = self.index.list(folder)
        # The model gets Muse's instructions with tags, and documents with roster names and known
        # values swapped for the same tags, so no instruction can make it spell out a real name
        # in a form the guard does not know (reversed, letter by letter, as a slug).
        task = self._model_view(instructions)
        rubrics = [d for d in docs if PurePosixPath(d.id).name.lower() == RUBRIC_NAME]
        rubric = min(rubrics, key=lambda d: len(PurePosixPath(d.id).parts)) if rubrics else self._parent_rubric(path)
        if rubric is not None and GRADING_WORDS.search(text):
            self.jobs.set_kind(job_id, "grading")
            essays = [d for d in docs if d.id != rubric.id]
            out = self._grade(job_id, task, essays, rubric, synthetic)
            read = [*essays, rubric]
        else:
            self.jobs.set_kind(job_id, "generic")
            out = self._generic(job_id, task, docs, synthetic)
            read = docs
        sources = [str(d.id) for d in read]
        if uncovered or reads_uncovered(self.index):  # covering was off when the job started or ended
            sources = mark_uncovered(sources)
        return (*out, sources)

    def _parent_rubric(self, folder: Path) -> Doc | None:
        """The nearest rubric.md above the folder, up to the workspace root (demo/rubric.md for
        demo/essays), so a teacher can keep one rubric next to the folder of essays."""
        root = self.index.root
        for parent in folder.parents:
            if not parent.is_relative_to(root):
                break
            candidate = parent / RUBRIC_NAME
            if candidate.is_file() and candidate.resolve().is_relative_to(root):
                rel = candidate.relative_to(root).as_posix()
                st = candidate.stat()
                return Doc(id=rel, path=rel, title=candidate.stem, size=st.st_size, modified=st.st_mtime)
        return None

    def _restore(self, text: str) -> str:
        tags = {**tag_dict(self._scratch_tags), **tag_dict(self.tagmap)}
        if self.restore is None and not tags:
            return text
        restore = self.restore
        if restore is None:
            from base.guard import restore  # lazy: the guard is optional for this module
        return restore(text, tags)

    def _view_tags(self) -> Any:
        """The TagMap for the model's view: the device's own, or one kept in memory for this agent."""
        from base.guard import TagMap  # lazy: the guard is optional for this module

        if isinstance(self.tagmap, TagMap):
            return self.tagmap
        if self.roster is not None:
            if self._scratch_tags is None:
                self._scratch_tags = TagMap(None)
            return self._scratch_tags
        return None

    def _model_view(self, text: str) -> str:
        """`text` as the model sees it: roster names, known values and identifiers as tags."""
        if not text:
            return text
        tagmap = self._view_tags()
        if tagmap is not None and self.roster is not None:
            from base import guard

            return guard.tag(text, self.roster, tagmap).text
        for tag, value in sorted(tag_dict(self.tagmap).items(), key=lambda kv: len(kv[1] or ""), reverse=True):
            if value and len(value) >= 2:  # no roster: swap the values the plain tag map knows
                text = re.sub(rf"(?<!\w){re.escape(value)}(?!\w)", tag, text, flags=re.IGNORECASE)
        return text

    # grading path

    def _grade(self, job_id: str, instructions: str, essays: list[Doc], rubric: Doc, synthetic: bool):
        if not essays:
            raise StepError("The folder has a rubric but no essays to grade.")
        rubric_text = self._model_view(clip(self.index.read(rubric.id), MAX_DOC_CHARS))
        texts = [self.index.read(d.id) for d in essays]
        names = unique(
            [
                student_name(d, t, self.roster, i + 1)
                for i, (d, t) in enumerate(zip(essays, texts, strict=True))
            ]
        )

        def step(i: int) -> dict[str, Any]:
            messages = [
                {"role": "system", "content": GRADE_SYSTEM},
                {
                    "role": "user",
                    "content": f"Teacher's instructions:\n{instructions}\n\nRubric:\n{rubric_text}\n\n"
                    f"Essay:\n{self._model_view(clip(texts[i], MAX_DOC_CHARS))}",
                },
            ]
            for attempt in (1, 2):
                raw = self._model_step(job_id, f"grade:{i + 1}", messages, GRADE_SCHEMA, synthetic, "grade")
                try:
                    grade = clean_grade(raw)
                    for key in ("strengths", "next_step", "feedback"):
                        grade[key] = self._restore(grade[key])  # real names, for the files on the device
                    return grade
                except StepError:
                    if attempt == 2:
                        raise
            raise AssertionError("unreachable")

        grades = self._each(step, len(essays))

        out_dir = self._job_dir(job_id)
        used: set[str] = set()
        for name, grade in zip(names, grades, strict=True):
            filename = unique_filename(f"{safe_filename(name)} feedback.md", used)
            write_private(out_dir / filename, feedback_markdown(name, grade))
        scrub = name_variants(names, self.roster)
        # Only roster students appear by name in the result, where egress tags them. Anyone else
        # (a new student, a name from a file name) is "Essay N": no tag can cover a name the
        # roster does not know, and the real name stays in the feedback file name on the device.
        on_roster = {p.name for p in self.roster.students} if self.roster is not None else set()
        shown = [n if re.sub(r" \(\d+\)$", "", n) in on_roster else f"Essay {i + 1}" for i, n in enumerate(names)]
        return raw_table(shown, grades), class_summary(grades, scrub), "per_student", list(TOPICS_GRADING)

    # generic path

    def _generic(self, job_id: str, instructions: str, docs: list[Doc], synthetic: bool):
        if not docs:
            return "No .md or .txt documents were found in that folder.", None, "free_text", []

        def step(i: int) -> str:
            body = self._model_view(clip(self.index.read(docs[i].id), MAX_DOC_CHARS))
            messages = [
                {"role": "system", "content": MAP_SYSTEM},
                {
                    "role": "user",
                    "content": f"Instructions:\n{instructions}\n\nDocument: {self._model_view(docs[i].title)}\n\n{body}",
                },
            ]
            return answer_of(self._model_step(job_id, f"map:{i + 1}", messages, ANSWER_SCHEMA, synthetic))

        parts = self._each(step, len(docs))
        if len(parts) == 1:
            return self._save_result(job_id, instructions, parts[0]), None, "free_text", []
        share = MAX_REDUCE_CHARS // len(parts)
        joined = "\n\n".join(
            f"### {self._model_view(d.title)}\n{clip(p, share)}" for d, p in zip(docs, parts, strict=True)
        )
        messages = [
            {"role": "system", "content": REDUCE_SYSTEM},
            {
                "role": "user",
                "content": f"Instructions:\n{instructions}\n\nAnswers per document:\n\n{joined}",
            },
        ]
        answer = answer_of(self._model_step(job_id, "reduce", messages, ANSWER_SCHEMA, synthetic))
        return self._save_result(job_id, instructions, answer), None, "free_text", []

    def _save_result(self, job_id: str, instructions: str, answer: str) -> str:
        """The answer with real names, also saved as output/<job id>/result.md for the user to open."""
        restored = self._restore(answer)
        task = " ".join(self._restore(instructions).split())
        write_private(self._job_dir(job_id) / RESULT_FILE, f"# Task result\n\nTask: {task}\n\n{restored}\n")
        return restored

    # model steps

    def _workers(self) -> int:
        return 4 if self.settings.is_cloud_backend else 1

    def _each(self, fn: Callable[[int], Any], n: int) -> list[Any]:
        """fn(0..n-1) in order; in a small pool on a cloud backend. The first error stops the rest."""
        workers = self._workers()
        if workers == 1 or n < 2:
            return [fn(i) for i in range(n)]
        pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="step")
        try:
            futures = [pool.submit(fn, i) for i in range(n)]
            return [f.result() for f in futures]
        finally:
            pool.shutdown(wait=True, cancel_futures=True)

    def _model_step(
        self,
        job_id: str,
        step: str,
        messages: list[dict],
        schema: dict,
        synthetic: bool,
        heavy_kind: str | None = None,
    ) -> Any:
        """One model call. synthetic is True only for marked folders: a cloud model may see those."""
        if self._stop.is_set():
            raise StepError(STOPPED)  # queued steps end at once instead of calling a model
        if heavy_kind and self.heavy is not None:
            started = time.perf_counter()
            try:
                out = self.heavy.run(heavy_kind, messages, schema, synthetic=synthetic)
            except Exception as exc:  # a broken hand-off falls back to this device's Glimmer
                log.warning("heavy step %s failed (%s); running it here", step, type(exc).__name__)
                out = None
            if out is not None:
                self._log_step(job_id, step, started, "heavy")
                return out
        started = time.perf_counter()
        out = self.llm.chat_json(
            messages, schema, synthetic=synthetic, max_tokens=MAX_TOKENS, reasoning=REASONING
        )
        self._log_step(job_id, step, started, "local")
        return out

    def _log_step(self, job_id: str, step: str, started: float, via: str) -> None:
        source = self.heavy if via == "heavy" else None
        model, backend = self.settings.answer_model, self.settings.glimmer_backend
        if source is None:
            # With PRIMARY_MODEL=lfm: LFM3-VL-2B here, or the fallback that took over.
            model = _str_attr(self.llm, "last_used", model)
            backend = _str_attr(self.llm, "last_backend", backend)
        entry = {
            "step": step,
            "model": _str_attr(source, "model", model),
            "backend": _str_attr(source, "backend", backend),
            "device": _str_attr(source, "device", self.settings.device),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "via": via,
        }
        self.jobs.add_model_step(job_id, entry)

    def _job_dir(self, job_id: str) -> Path:
        self.settings.ensure_home()
        out = self.settings.paths.output / job_id
        out.mkdir(mode=0o700, exist_ok=True)
        os.chmod(out, 0o700)
        return out


# helpers


def is_marked(folder: Path, root: Path) -> bool:
    """Whether the folder or a parent up to the workspace root holds the .synthetic marker."""
    return synthetic_marked(folder, root)


def _str_attr(obj: Any, name: str, default: str) -> str:
    value = getattr(obj, name, None) if obj is not None else None
    return value if isinstance(value, str) and value else default


def tag_dict(tagmap: Any) -> dict[str, str]:
    """The tag -> real value mapping from a dict, or from a TagMap with as_dict() or tag_map."""
    if tagmap is None:
        return {}
    if isinstance(tagmap, Mapping):
        return dict(tagmap)
    for attr in ("as_dict", "tag_map"):
        value = getattr(tagmap, attr, None)
        value = value() if callable(value) else value
        if isinstance(value, Mapping):
            return dict(value)
    return {}


def short_error(exc: BaseException) -> str:
    """A reason for the jobs table that never carries document text or local paths."""
    if isinstance(exc, WorkspacePathError):
        return "That folder is outside the workspace."
    if isinstance(exc, CloudBackendRefused):
        return "The cloud model only reads folders marked as invented data (.synthetic), and this one is not."
    if isinstance(exc, FileNotFoundError | NotADirectoryError):
        return "That folder or document is not in the workspace."
    if isinstance(exc, StepError | ScanError):  # both carry fixed text only
        return str(exc)
    name = type(exc).__name__
    if name == "LLMParseError":
        return "The model's answer could not be read as JSON."
    if "timeout" in name.lower():
        return "A model step timed out."
    return f"The job stopped with an error ({name})."


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + " [cut for length]"


def as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value and abs(value) < 1e6:
        return round(value)
    if isinstance(value, str) and re.fullmatch(r"\s*-?\d+(\.\d+)?\s*", value):
        return round(float(value))
    return None


def as_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return clip(value.strip(), limit)


def clean_grade(raw: Any) -> dict[str, Any]:
    """Validate one grading answer and clamp each score to 1..4; total is recomputed as the sum."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("scores"), Mapping):
        raise StepError("A grading step did not return scores.")
    scores: dict[str, int] = {}
    for c in CRITERIA:
        n = as_int(raw["scores"].get(c))
        if n is None:
            raise StepError("A grading step returned a score that is not a number.")
        scores[c] = min(4, max(1, n))
    return {
        "scores": scores,
        "total": sum(scores.values()),
        "strengths": as_text(raw.get("strengths"), 800),
        "next_step": as_text(raw.get("next_step"), 300),
        "feedback": as_text(raw.get("feedback"), 4000),
    }


def answer_of(raw: Any) -> str:
    if not isinstance(raw, Mapping) or not isinstance(raw.get("answer"), str):
        raise StepError("A model step did not return an answer.")
    return raw["answer"].strip()


def student_name(doc: Doc, text: str, roster: Roster | None, n: int) -> str:
    """Roster name in the file name or header, else a "Name:" line, else the file name."""
    stem = PurePosixPath(doc.id).stem
    head = "\n".join(text.splitlines()[:8])
    if roster is not None:
        hay = re.sub(r"[_\-]+", " ", f"{stem}\n{doc.title}\n{head}").lower()
        for person in roster.students:  # hyphens count as spaces on both sides (Moreno-Baptiste)
            if re.sub(r"[_\-]+", " ", person.name).lower() in hay:
                return person.name
    m = re.search(r"^\s*(?:student(?:\s+name)?|name)\s*:\s*(.+?)\s*$", head, re.IGNORECASE | re.MULTILINE)
    if m:
        name = re.sub(r"[*_`#]", "", m.group(1)).strip()[:80]
        if name:
            return name
    words = [w for w in re.split(r"[\s_\-]+", stem) if w and not w.isdigit() and w.lower() not in NAME_NOISE]
    return " ".join(words) if words else f"Essay {n}"


def unique(names: list[str]) -> list[str]:
    seen: Counter[str] = Counter()
    out = []
    for name in names:
        seen[name] += 1
        out.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
    return out


def safe_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w .,'()-]", "", name).strip(" .")
    return cleaned[:80] or "Student"


def unique_filename(filename: str, used: set[str]) -> str:
    stem, suffix = filename.rsplit(".", 1)
    candidate, i = filename, 2
    while candidate.lower() in used:
        candidate, i = f"{stem} {i}.{suffix}", i + 1
    used.add(candidate.lower())
    return candidate


def write_private(path: Path, content: str) -> None:
    """Write a file only this user can read (0600), refusing to follow a symlink."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(path, 0o600)


def _cell(text: str) -> str:
    return re.sub(r"\s+", " ", text).replace("|", "/").strip()


def feedback_markdown(name: str, grade: dict[str, Any]) -> str:
    lines = [f"# Feedback for {name}", "", "| Criterion | Score (1 to 4) |", "|---|---|"]
    lines += [f"| {c.title()} | {grade['scores'][c]} |" for c in CRITERIA]
    lines += [f"| Total | {grade['total']} out of 16 |", ""]
    lines += ["## Strengths", "", grade["strengths"] or "None noted.", ""]
    lines += ["## Next step", "", grade["next_step"] or "None noted.", ""]
    lines += ["## Feedback", "", grade["feedback"] or "None written.", ""]
    return "\n".join(lines)


def raw_table(names: list[str], grades: list[dict[str, Any]]) -> str:
    """Per-student scores and next steps, with real names. Stays on the device until egress tags it."""
    lines = [
        f"Graded {len(grades)} essays against the rubric. Feedback files are saved on this device.",
        "",
        "| Student | Ideas | Organization | Evidence | Conventions | Total |",
        "|---|---|---|---|---|---|",
    ]
    for name, g in zip(names, grades, strict=True):
        s = g["scores"]
        lines.append(f"| {_cell(name)} | {' | '.join(str(s[c]) for c in CRITERIA)} | {g['total']} |")
    lines += ["", "Next steps:"]
    lines += [
        f"- {_cell(name)}: {_cell(g['next_step']) or 'none given'}"
        for name, g in zip(names, grades, strict=True)
    ]
    return "\n".join(lines)


def name_variants(names: list[str], roster: Roster | None) -> list[str]:
    """Full names, name parts and roster nicknames for the students in this job, longest first."""
    names = [n for n in names if not re.fullmatch(r"Essay \d+", n)]
    variants = set(names)
    for name in names:
        variants.update(part for part in re.split(r"[\s()]+", name) if len(part) >= 3 and not part.isdigit())
    if roster is not None:
        for person in roster.students:
            if person.name in names:
                variants.update(n for n in person.nicknames if len(n) >= 2)
    return sorted(variants, key=len, reverse=True)


def scrub_names(text: str, variants: list[str]) -> str:
    for v in variants:
        flags = re.IGNORECASE if " " in v else 0
        text = re.sub(rf"\b{re.escape(v)}\b", "the student", text, flags=flags)
    return text


def class_summary(grades: list[dict[str, Any]], variants: list[str]) -> str:
    """Class averages, score counts and the two most common next steps. No names."""
    n = len(grades)
    lines = [
        f"Class summary for {n} essays, each criterion scored 1 to 4.",
        "",
        "| Criterion | Average | Scored 1 | Scored 2 | Scored 3 | Scored 4 |",
        "|---|---|---|---|---|---|",
    ]
    for c in CRITERIA:
        values = [g["scores"][c] for g in grades]
        dist = Counter(values)
        lines.append(
            f"| {c.title()} | {mean(values):.1f} | {' | '.join(str(dist[k]) for k in (1, 2, 3, 4))} |"
        )
    totals = [g["total"] for g in grades]
    counts = ", ".join(f"{t} ({k})" for t, k in sorted(Counter(totals).items()))
    lines += [
        "",
        f"Average total: {mean(totals):.1f} out of 16 (lowest {min(totals)}, highest {max(totals)}).",
        f"Totals and how many essays got each: {counts}.",
    ]
    common: Counter[str] = Counter()
    shown: dict[str, str] = {}
    for g in grades:
        step = _cell(scrub_names(g["next_step"], variants))
        key = re.sub(r"[^a-z0-9 ]", "", step.lower()).strip()
        if key:
            common[key] += 1
            shown.setdefault(key, step)
    if common:
        lines += ["", "Most common next steps:"]
        lines += [f"- {shown[key]} ({k} of {n} essays)" for key, k in common.most_common(2)]
    return "\n".join(lines)
