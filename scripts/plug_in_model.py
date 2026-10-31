"""Plug a local GGUF into Muse Privacy as the device's main model, or undo that.

    uv run python -m scripts.plug_in_model /path/to/model.gguf --check [--draft DRAFT.gguf] [--label NAME]
    uv run python -m scripts.plug_in_model /path/to/model.gguf [--draft DRAFT.gguf] [--draft-n N]
        [--flash-attn on|off|auto] [--reasoning-budget N]
    uv run python -m scripts.plug_in_model --undo

Checks the file first: it reads the GGUF header (architecture, tensor types, parameters, bits per
weight, the KV cache at ANSWER_CTX, vision tensors, the vocabulary), hashes it, compares its tensor
types with what llama.cpp can load, and checks free disk and memory with the drafter included. It
writes eval/reports/model_file_<label>.md and refuses a file that cannot work, with a plain reason.

Then it sets the model's lines in .env: every model on this device, your GGUF for answers and
routing, LFM3-VL-2B for scans and search, plus the drafter and server knobs scripts/start.sh reads
(GLIMMER_DRAFT_GGUF, GLIMMER_DRAFT_N, GLIMMER_FA, GLIMMER_REASONING_BUDGET). The other lines stay
as they are, and the old file is kept as .env.before-plug-in. Restart scripts/start.sh afterwards,
then run scripts.compare_modes to score it. Nothing is downloaded, and no value in .env is printed.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

from base.config import REPO_ROOT, read_dotenv
from scripts import gguf_info

ENV = REPO_ROOT / ".env"
REPORTS = REPO_ROOT / "eval" / "reports"
BACKUP_NAME = ".env.before-plug-in"
MARGIN_GB = 4  # LFM, the embedder, the app and the system, on top of the model
MIN_FREE_GB = 2  # free disk left on the model's volume, for logs, the database and swap
DEFAULT_CTX = 16384  # scripts/start.sh's ANSWER_CTX
GLIMMER_MIN_BUILD = 10353  # Glimmer needs llama.cpp b10353 or newer; every type in gguf_info.TYPES is older
FLASH_ATTN = ("on", "off", "auto")
GIB = 1024**3


def total_memory_gb() -> float | None:
    try:
        if sys.platform == "darwin":
            return int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) / GIB
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / GIB
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def free_disk_gb(path: Path) -> float | None:
    try:
        return shutil.disk_usage(path.parent).free / GIB
    except OSError:
        return None


def gb(n: float | None) -> str:
    return "unknown" if n is None else f"{n / GIB:.2f} GB"


def inspect(
    path: Path,
    memory_gb: float | None,
    *,
    draft: Path | None = None,
    ctx: int = DEFAULT_CTX,
    build: int | None = None,
    free_gb: float | None = None,
    hash_file: bool = True,
) -> tuple[list[str], dict[str, str]]:
    """Plain reasons this file can't be the device's model (empty means it can), and the facts
    about it for the report, as label -> value."""
    facts: dict[str, str] = {}
    files = [("model", path)] + ([("drafter", draft)] if draft else [])
    read: dict[str, gguf_info.GGUF] = {}
    for role, p in files:
        if not p.is_file():
            return [f"No {role} file at {p.name}."], facts
        try:
            read[role] = gguf_info.read(p)
        except gguf_info.GGUFError as exc:
            return [f"The {role} file: {exc}."], facts
    model = read["model"]
    problems = []
    if model.arch == "clip":
        problems.append(f"{path.name} is a vision projector (mmproj), not a model.")
    facts["File"] = path.name
    facts["Size"] = gb(model.file_bytes)
    facts["Architecture"] = model.arch or "not given"
    facts["Quant type (general.file_type)"] = model.file_type or "not given"
    facts["Tensor types"] = ", ".join(f"{name} x{n}" for name, n in sorted(model.type_counts().items()))
    facts["Tensor type ids"] = ", ".join(str(i) for i in sorted({t.type_id for t in model.tensors}))
    facts["Parameters"] = f"{model.params:,} ({model.params / 1e9:.2f} B)"
    bpw = model.bits_per_weight()
    facts["Effective bits per weight"] = "unknown" if bpw is None else f"{bpw:.3f} (file bytes x 8 / parameters)"
    vision = model.vision_tensors
    if vision:
        text = model.bits_per_weight(text_only=True)
        facts["Effective bits per weight, text only"] = "unknown" if text is None else f"{text:.3f}"
    mmproj = sorted(p.name for p in path.parent.glob("mmproj*.gguf") if p != path)
    facts["Vision"] = (f"{len(vision)} vision tensors in the file" if vision else "no vision tensors in the file") + (
        f"; a vision projector sits next to it ({len(mmproj)} mmproj file(s))" if mmproj else "; no mmproj file next to it"
    )
    facts["Vocabulary"] = "not given" if model.vocab_size is None else f"{model.vocab_size:,} tokens"
    template = model.metadata.get("tokenizer.chat_template")
    if isinstance(template, str):
        mentions = "yes" if "reasoning_strength" in template else "no"
        facts["Chat template"] = f"present, sha256 {hashlib.sha256(template.encode()).hexdigest()[:16]}, mentions reasoning_strength: {mentions}"
    else:
        facts["Chat template"] = "none in the file"
    if hash_file:
        facts["sha256"] = gguf_info.sha256(path)

    kv = model.kv_cache_bytes(ctx)
    window = model.arch_value("attention.sliding_window")
    facts[f"KV cache at {ctx:,} tokens"] = gb(kv) + (
        f" (at most: the model has a {window}-token sliding window)" if window else ""
    ) + ("" if kv is not None else " (the file does not say its layers and heads)")
    need = model.file_bytes + (kv or 0)

    for role, g in read.items():
        bad = g.bad_types()
        if bad:
            listed = ", ".join(f"{name} (id {i})" for i, name in sorted(bad.items()))
            built = f"llama.cpp build {build}" if build else "llama.cpp"
            problems.append(f"The {role} file uses tensor types {built} cannot load or this check does not know: {listed}.")
        short = g.short_tensors()
        if short:
            problems.append(f"The {role} file is shorter than its tensor table says ({short} tensors cut off). Copy it again.")

    if draft:
        drafter = read["drafter"]
        dkv = drafter.kv_cache_bytes(ctx)
        need += drafter.file_bytes + (dkv or 0)
        facts["Drafter"] = f"{draft.name}, {gb(drafter.file_bytes)}, architecture {drafter.arch or 'not given'}, KV cache {gb(dkv)}"
        if model.vocab_size and drafter.vocab_size and model.vocab_size != drafter.vocab_size:
            problems.append(
                f"The drafter's vocabulary ({drafter.vocab_size:,} tokens) does not match the model's ({model.vocab_size:,}), so it cannot draft for it."
            )
        if not (model.vocab_size and drafter.vocab_size):
            facts["Drafter fits"] = "cannot tell: a file does not list its vocabulary"
        else:
            facts["Drafter fits"] = "vocabulary matches" if model.vocab_size == drafter.vocab_size else "no"

    facts["llama-server build"] = str(build) if build else "not found (set LLAMA_SERVER_BIN); types checked against the table only"
    if build and build < GLIMMER_MIN_BUILD:
        problems.append(f"The installed llama-server is build {build}; Glimmer needs b{GLIMMER_MIN_BUILD} or newer.")

    facts["Free disk on its volume"] = "unknown" if free_gb is None else f"{free_gb:.1f} GB (needs {MIN_FREE_GB} GB)"
    if free_gb is not None and free_gb < MIN_FREE_GB:
        problems.append(f"Only {free_gb:.1f} GB of disk is free on the model's volume. Free at least {MIN_FREE_GB} GB first.")

    total = need / GIB + MARGIN_GB
    facts["Memory needed"] = f"{total:.1f} GB (model, drafter and KV cache, plus {MARGIN_GB} GB for LFM, the app and the system)"
    facts["Memory on this device"] = "unknown" if memory_gb is None else f"{memory_gb:.0f} GB"
    if memory_gb is not None and total > memory_gb:
        problems.append(
            f"{path.name} needs about {total:.1f} GB with its KV cache{' and drafter' if draft else ''} and {MARGIN_GB} GB for everything else, more than this device's {memory_gb:.0f} GB of memory."
        )
    return problems, facts


def check_model(path: Path, memory_gb: float | None, **kw) -> list[str]:
    """Plain reasons this file can't be the device's model. Empty means it can."""
    return inspect(path, memory_gb, **kw)[0]


def safe_label(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", label).strip("._") or "model"


def report_command(argv: list[str]) -> str:
    """The command as typed, with every file named by its base name only (no folders, no home)."""

    def short(arg: str) -> str:
        flag, eq, value = arg.partition("=") if arg.startswith("--") else ("", "", arg)
        if "/" in value or os.sep in value:
            value = Path(value).name
        return f"{flag}{eq}{value}"

    return "uv run python -m scripts.plug_in_model " + shlex.join(short(a) for a in argv)


def write_report(label: str, command: str, problems: list[str], facts: dict[str, str], out_dir: Path = REPORTS) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"model_file_{safe_label(label)}.md"
    lines = [
        f"# Model file check: {label}",
        "",
        f"Command: `{command}`",
        "",
        f"Date: {date.today().isoformat()}. Read from the file's header; no model was loaded or called.",
        "",
        "| What | Value |",
        "|---|---|",
        *(f"| {k} | {v.replace('|', '/')} |" for k, v in facts.items()),
        "",
        "Result: " + ("can be plugged in." if not problems else "refused."),
        *(f"- {p}" for p in problems),
        "",
    ]
    path.write_text("\n".join(lines))
    return path


def with_lines(text: str, values: dict[str, str]) -> str:
    """`text` (a .env file) with each key set: replaced where it is, added at the end if new."""
    left = dict(values)
    out = []
    for line in text.splitlines():
        key = line.split("=", 1)[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in left:
            out.append(f"{key}={left.pop(key)}")
        else:
            out.append(line)
    if left:
        out += ["", "# Set by scripts/plug_in_model.py", *(f"{k}={v}" for k, v in left.items())]
    return "\n".join(out) + "\n"


def plug_in(
    model: Path,
    env_path: Path = ENV,
    *,
    draft: Path | None = None,
    draft_n: int | None = None,
    flash_attn: str | None = None,
    reasoning_budget: int | None = None,
) -> dict[str, str]:
    """Set the model's lines in the .env at `env_path`, keeping a backup. Returns what was set.
    A drafter always goes with the model it was checked with: without `draft`, an earlier
    GLIMMER_DRAFT_GGUF line is emptied. The other knobs change only when given."""
    current = env_path.read_text() if env_path.is_file() else ""
    backup = env_path.with_name(BACKUP_NAME)
    if not backup.exists():  # the first backup is the one to go back to
        backup.write_text(current)
        os.chmod(backup, 0o600)
    env = read_dotenv(env_path)
    values = {
        "DEVICE_ONLY": "1",
        "PRIMARY_MODEL": "glimmer",
        "GLIMMER_BACKEND": "llama_server",
        "GLIMMER_GGUF": str(model.resolve()),
        "CHECKER_BACKEND": "lfm",
    }
    server = env.get("LLAMA_SERVER_BIN") or env.get("CHECKER_SERVER_BIN")
    if server:
        values["LLAMA_SERVER_BIN"] = server
    if draft is not None:
        values["GLIMMER_DRAFT_GGUF"] = str(draft.resolve())
    elif "GLIMMER_DRAFT_GGUF" in env:
        values["GLIMMER_DRAFT_GGUF"] = ""
    if draft_n is not None:
        values["GLIMMER_DRAFT_N"] = str(draft_n)
    if flash_attn is not None:
        values["GLIMMER_FA"] = flash_attn
    if reasoning_budget is not None:
        values["GLIMMER_REASONING_BUDGET"] = str(reasoning_budget)
    env_path.write_text(with_lines(current, values))
    os.chmod(env_path, 0o600)
    return values


def undo(env_path: Path = ENV) -> bool:
    backup = env_path.with_name(BACKUP_NAME)
    if not backup.is_file():
        return False
    shutil.copy2(backup, env_path)
    os.chmod(env_path, 0o600)
    backup.unlink()
    return True


def server_binary(env_path: Path = ENV) -> str | None:
    """The llama-server start.sh would use: LLAMA_SERVER_BIN, CHECKER_SERVER_BIN, then PATH."""
    env = {**read_dotenv(env_path), **os.environ}
    return env.get("LLAMA_SERVER_BIN") or env.get("CHECKER_SERVER_BIN") or shutil.which("llama-server")


def context_size(env_path: Path = ENV) -> int:
    value = {**read_dotenv(env_path), **os.environ}.get("ANSWER_CTX", "")
    return int(value) if value.isdigit() else DEFAULT_CTX


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model", nargs="?", type=Path, help="the .gguf file")
    p.add_argument("--check", action="store_true", help="check the file, write its report and change nothing in .env")
    p.add_argument("--undo", action="store_true", help="put .env back as it was before plugging in")
    p.add_argument("--draft", type=Path, help="a DFlash drafter .gguf for speculative decoding (GLIMMER_DRAFT_GGUF)")
    p.add_argument("--draft-n", type=int, help="tokens drafted per step (GLIMMER_DRAFT_N; start.sh's default is 15)")
    p.add_argument("--flash-attn", choices=FLASH_ATTN, help="llama-server -fa (GLIMMER_FA; default auto)")
    p.add_argument("--reasoning-budget", type=int, help="llama-server --reasoning-budget: -1 unrestricted, 0 none (GLIMMER_REASONING_BUDGET)")
    p.add_argument("--ctx", type=int, help="context size for the KV estimate (default: ANSWER_CTX, else 16384)")
    p.add_argument("--label", help="the report's name: eval/reports/model_file_<label>.md (default: the file's name)")
    p.add_argument("--out", type=Path, default=REPORTS, help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    if args.undo:
        print("Put .env back. Restart scripts/start.sh." if undo(ENV) else "Nothing to undo.")
        return 0
    if args.model is None:
        p.error("give the path to a .gguf file, or --undo")
    if args.draft_n is not None and args.draft_n < 1:
        p.error("--draft-n must be 1 or more")
    if args.reasoning_budget is not None and args.reasoning_budget < -1:
        p.error("--reasoning-budget must be -1 (unrestricted), 0 or more")
    problems, facts = inspect(
        args.model,
        total_memory_gb(),
        draft=args.draft,
        ctx=args.ctx or context_size(ENV),
        build=gguf_info.llama_build(server_binary(ENV)),
        free_gb=free_disk_gb(args.model),
    )
    for label, value in facts.items():
        print(f"{label}: {value}")
    if facts:
        label = args.label or args.model.stem
        report = write_report(label, report_command(argv), problems, facts, args.out)
        print(f"Report: {report.relative_to(REPO_ROOT) if report.is_relative_to(REPO_ROOT) else report.name}")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    if args.check:
        print(f"{args.model.name} can be plugged in.")
        return 0
    plug_in(args.model, ENV, draft=args.draft, draft_n=args.draft_n, flash_attn=args.flash_attn, reasoning_budget=args.reasoning_budget)
    print(f"Plugged in {args.model.name}{' with its drafter' if args.draft else ''}. Next:")
    print("  1. Stop scripts/start.sh with Ctrl-C and start it again.")
    print("  2. uv run python -m scripts.device_smoke --name my_model")
    print("  3. uv run python -m scripts.compare_modes --name my_model")
    print("Undo with: uv run python -m scripts.plug_in_model --undo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
