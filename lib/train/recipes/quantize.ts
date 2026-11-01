/**
 * The glimmer-quantize recipe's Python (docs/TRAINING.md, "Local files"): ONE judged glimmer-lora adapter merged into
 * the 16-bit base, converted to GGUF, quantized to the builds its params name, checked, and sent to its own GGUF repo on
 * the Hugging Face Hub, which the platform commits with the GGUF card once the job succeeded. It is a job like every
 * other, in the adapter's region with that cache mounted, as glimmer-serve is. Never put a dollar sign followed by an
 * opening brace, or a backtick, in the Python: this is a template literal.
 *
 * It reuses glimmer-lora's Python as it is (GLIMMER_PY without its docstring and its __main__ block, see
 * glimmerHelpers): the venv the merge runs in (Unsloth, transformers and PEFT at glimmer's pins), the pinned uv, the
 * pinned 4-bit model, the chat template's rendering, student_system and the event relay. Then, on the GPU:
 *
 *   1. Fail fast: no adapter in the cache, a dry run's stand-in, an adapter that targets a vision module, under 300 GB
 *      of local disk, under 180 GiB of RAM, or under 45 minutes left.
 *   2. llama.cpp at one pinned build, each download checked against its sha256 as uv is: the release's Ubuntu CUDA build
 *      and its CUDA runtime (every tool, the checks on the GPU), and the source archive for convert_hf_to_gguf.py and
 *      gguf-py, which run in a small venv of their own on the cache. Meta's template and tokenizer files at a pinned
 *      revision, checked the same way.
 *   3. The merge, in a child on glimmer's venv: the 4-bit base and the adapter, then Unsloth's save_pretrained_merged
 *      with merged_16bit, which downloads the 16-bit base to local disk (never the cache) and merges tensor by tensor
 *      in fp32. Then the merged folder must have the base's 1,436 tensor names and shapes, its 16-bit base must be
 *      MERGE_BASE's shards by their SHA-256, and Meta's template and tokenizer files go into it.
 *   4. convert_hf_to_gguf.py to BF16, llama-quantize to Q8_0 (the closeness reference, never published) and to each
 *      build, each intermediate deleted as soon as nothing needs it.
 *   5. The file checks: each file's architecture, tensor count and embedded template; the closeness of each build to
 *      Q8_0 (llama-perplexity's KL divergence, a build over its limit is left out); and on Q4_K_M under llama-server,
 *      the template (the prompt it renders must be training's, character for character) and the channel (at least 90%
 *      of the held-out prompts must get a final answer under a stock app's prompt), plus how many answers agree with
 *      the adapter's own eval answers.
 *   6. ctx.hub_upload of the builds that passed, with the system message, Ollama's params and, for an adapter trained
 *      before trainChannel, tuned.jinja; then the metrics.
 */
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { glimmerHelpers } from "@/lib/train/recipes/serve";

const QUANT_HEAD = String.raw`"""Muse Glimmer quantize: one judged glimmer-lora adapter merged, converted to GGUF, quantized, checked and sent to the Hub."""

# glimmer-lora's own Python (lib/train/recipes/glimmer.ts) follows as it is, without its docstring and its __main__
# block, for its venv (where the merge runs), the pinned uv and model, the chat template and the event relay. Its
# run(ctx) is replaced below; its child_main is never called.
`;

const QUANT_BODY = String.raw`

# ---------------------------------------------------------------------------------------------------------------
# glimmer-quantize: everything below is this recipe's own.

import re
import signal
import socket
import subprocess
import urllib.error

JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SLUG_MAX = 40
# The builds a job may ask for, in order (QUANT_LEVELS in lib/train/local-files.ts). The platform writes the levels
# param itself, and anything else in it is refused here too.
QUANT_LEVELS = ("Q3_K_M", "Q4_K_M", "Q6_K")
# Each build's limit on its mean KL divergence from Q8_0 (QUANT_KL_MAX in lib/train/logic.ts).
QUANT_KL_MAX = {"Q3_K_M": 0.08, "Q4_K_M": 0.03, "Q6_K": 0.005}
# The share of held-out prompts Q4_K_M must answer with a final answer (QUANT_CHANNEL_MIN in lib/train/logic.ts).
QUANT_CHANNEL_MIN = 0.9
# The reference every build is measured against, and the build the template and channel checks run on.
REFERENCE_LEVEL = "Q8_0"
CHECK_LEVEL = "Q4_K_M"

# llama.cpp at one pinned build: b11669, which the v0.7.0 release names (its nightly-tag.txt), published 2026-10-15, at
# or after b10353, the first build that knows Muse Glimmer. From that build on the release has an Ubuntu CUDA 12.8 x64
# build (b10353's had none), so every tool runs from llama.cpp's own CUDA binaries, with the CUDA runtime the release
# ships beside them: nothing is compiled, and no container is needed. Each asset's sha256 is the "digest" GitHub's
# releases API gives for it (GET https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b11669, read on
# 2026-10-28). The source archive has no API digest: its sha256 is of the archive below as GitHub served it, the same
# on two downloads on 2026-10-28.
LLAMACPP_TAG = "b11669"
LLAMACPP_COMMIT = "620d2225cc436ab0b001e3200e590e3b286ef9ab"
LLAMACPP_RELEASE_URL = "https://github.com/ggml-org/llama.cpp/releases/download/" + LLAMACPP_TAG + "/"
# (asset, sha256, the folder it unpacks into)
LLAMACPP_BUILD = ("llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz", "4703ed1a3cd6e8504affb6cb9866f501e96d634d68a002dc9a8251c9e2819b49", "llama-b11669")
LLAMACPP_CUDART = ("cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz", "ab3eda89a82096bcba00b6448218c3c11eec2016b0f38d64884dc29736549f26", "cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64")
LLAMACPP_SOURCE = ("https://github.com/ggml-org/llama.cpp/archive/refs/tags/b11669.tar.gz", "e06ba4fa263e30fdb9f0e65f00a8965202ddaa0c51f548a67e1f9b2164d04efc", "llama.cpp-b11669")
# Of the source, only the converter and gguf-py are unpacked.
LLAMACPP_SOURCE_PARTS = ("convert_hf_to_gguf.py", "conversion/", "gguf-py/")

# The converter's own small venv on the cache, next to glimmer's: the direct packages of the source's
# requirements/requirements-convert_hf_to_gguf.txt, pinned to what uv resolved them to on 2026-10-28 for Python 3.12
# on x86_64 Linux. Changing a line makes a new venv.
CONVERT_INSTALL = (
    "torch==2.11.0+cpu --index-url https://download.pytorch.org/whl/cpu",
    "numpy==2.2.6 sentencepiece==0.2.2 transformers==4.57.6 protobuf==4.25.9 tqdm==4.70.1 pyyaml==6.0.3 requests==2.34.2",
)
CONVERT_TRANSFORMERS = "4.57.6"
CONVERT_CHECK = (
    "import torch, numpy, sentencepiece, transformers, google.protobuf, yaml, tqdm, requests; "
    "print('MUSE_CONVERT transformers=' + transformers.__version__)"
)
CONVERT_READY_LINE = "MUSE_CONVERT transformers=" + CONVERT_TRANSFORMERS

# Meta's base model at the revision whose template and tokenizer files go into the merged model, so every GGUF file
# embeds Meta's current template, not Unsloth's older copy (main on 2026-10-28, the revision ggml-org's own conversion
# used). Each file's sha256 at that revision: the Hub's LFS oid for tokenizer.json, the bytes' own for the rest, read
# on 2026-10-28 and checked against the tree's git oids.
META_REPO = "meta-models/Muse-Glimmer-30B"
META_REVISION = "cec94fcfd6512f2cfe708138c32533b346ea4f69"
META_URL = "https://huggingface.co/" + META_REPO + "/resolve/" + META_REVISION + "/"
META_FILES = (
    ("chat_template.jinja", "cfc67e5f349f37690dfd31ed1f18bc4442a9dd32fe39a648f993cb4eb3cae678"),
    ("tokenizer.json", "c9dbee66967b58f31a7c27f723c3760da3526ccd0427578e8905b0abb0031c4d"),
    ("tokenizer_config.json", "781e6c74f571642c71202167b67d9255b28cc439bdda1582ff31346182f5a9c5"),
    ("processor_config.json", "97e2a486dd9866b81f40cf4b8bc0c9ced9a7cd8a5bc65aa4cc2f4de0712dae77"),
    ("generation_config.json", "1fa51889b1f8d3659802dedaa27e005b81e5c58483f13ecf13f2d97306bc6e35"),
)
META_TEMPLATE = "chat_template.jinja"
# tuned.jinja, for an adapter trained before trainChannel: Meta's template with its default reasoning strength low and a
# generation prompt that opens the final channel, the way this adapter's answers start. Each change is found exactly
# once, and the result has this sha256 (TUNED_TEMPLATE_SHA256 in lib/train/hub-cards.ts).
TUNED_EDITS = (
    ("else 'high' -%}", "else 'low' -%}"),
    (
        "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant' -}}\n{%- endif -%}",
        "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant to=user<|message|>' -}}\n{%- endif -%}",
    ),
)
TUNED_TEMPLATE = "tuned.jinja"
TUNED_TEMPLATE_SHA256 = "ee7766876b1317a7b95caec088aca7905399ce8b7117745921643e931b476b13"

# The 16-bit base Unsloth merges into: MERGE_BASE is the merged BF16 of Muse Muse's 2026-knowledge Glimmer (r30b), the
# repo MODEL is the nf4 quantization of. Unsloth's merged_16bit reads the base from the model's config._name_or_path
# through its own name mapper, which knows only its own repos: MODEL's name would come back unchanged, as an nf4 base,
# and the merge would refuse it. So merge_child_main points _name_or_path at MERGE_BASE before saving. Unsloth takes no
# revision for that download and fetches MERGE_BASE's main, so the check below holds the shards to their SHA-256, not to
# a commit; a merge that fetched anything else leaves no record of these 13 shards and fails, and nothing is published.
# BASE_SHARDS are its 13 shards by the SHA-256 the Hub gives them at MERGE_BASE_REVISION (the training session's list,
# Oct 31 2026), which nothing downloads by: it records where the list came from. The weights were the same at e2b33cce,
# its main after that, and base_shards_problem records whichever commit the merge downloaded.
MERGE_BASE = "OfflineBase/Glimmer-30B-2026-Knowledge"
MERGE_BASE_REVISION = "c06e38ccbb512f350e5c383944f1bbfb96f14248"
BASE_SHARDS = (
    ("model-00001-of-00013.safetensors", "8741fd4122ec9b66592a9b93b69406081fbaea062fc4e1dfd6eefa03266e7750"),
    ("model-00002-of-00013.safetensors", "5bccadafbdc50e2edcf9c6312843e832a60216f26e12555ba4276555c410fcc6"),
    ("model-00003-of-00013.safetensors", "7307b08d0e0f171fcd24d78cdbcdb4936877038dadbcbcb61e68e58ec8edfb6c"),
    ("model-00004-of-00013.safetensors", "0130118dad489d83f0c07acb5d0792f7494c7f3d1a6f7410204ec265d7ac36ad"),
    ("model-00005-of-00013.safetensors", "1783e68c69e1be51b25d370b3198da59399e944015e20211295ec1a91bee9108"),
    ("model-00006-of-00013.safetensors", "9ccd6e302c31d28c63c2e984c05004abbc48afcb7290691e987604cc506f00e7"),
    ("model-00007-of-00013.safetensors", "62664e3c24be5477888ac4cbbd1f0e3711b2828e68d0570499222a9e8c7e64cb"),
    ("model-00008-of-00013.safetensors", "b648ffd3f084152556d95c5354f32060d7572cf69e093b1decdf6c4765f836b5"),
    ("model-00009-of-00013.safetensors", "163fc9f9271f471d179905b9ce1559d3fa473195541061c2c333cec43ef9adac"),
    ("model-00010-of-00013.safetensors", "fc679e0c03dd806b6c5d546ba54319cdd948fe5a871e3f750069731a165efedd"),
    ("model-00011-of-00013.safetensors", "3c9797afa45d8b06c03d455f4f26143851bcc644c392c75b1d73d4633bfcf1be"),
    ("model-00012-of-00013.safetensors", "7fe46ae2be34ff2c3f490a913e05c100d5a1d8dd88818ca630f798374014ba78"),
    ("model-00013-of-00013.safetensors", "910398ccd9b33dbf354589e7dcbff5019c9d97eca10dba20ad712f2730a20991"),
)
# Meta's checkpoint has 1,436 tensors, and this is the sha256 of their sorted "name:shape" lines (a shape as 6656x202048),
# from its two shards' safetensors headers. MERGE_BASE has the same names and shapes (read from its 13 shards' headers on
# Oct 31 2026), and the merged folder must have them too.
BASE_TENSORS = 1436
BASE_TENSORS_SHA256 = "526660e0862cf74a8f319a2b9040d4dfdd79fa2f91760f41130c7e3c137694d4"
# The text model's GGUF: its architecture, and its tensor count, as ggml-org's conversion of the same base revision logged.
GGUF_ARCH = "muse-glimmer"
GGUF_TENSORS = 731
GGUF_MAGIC = b"GGUF"

# The machine and the clock. The merge needs about 60 GB of RAM and, with the downloads and the files, up to about 150 GB
# of local disk; each stage needs this long left before ctx.deadline to start, so a job that can't finish fails early.
MIN_DISK_BYTES = 300 * 10 ** 9
MIN_RAM_BYTES = 180 * 1024 ** 3
MIN_START_SECONDS = 45 * 60
NEED_MERGE_SECONDS = 40 * 60
NEED_CONVERT_SECONDS = 30 * 60
NEED_QUANTIZE_SECONDS = 25 * 60
NEED_CHECKS_SECONDS = 18 * 60
NEED_UPLOAD_SECONDS = 8 * 60
# What a command's timeout leaves for the report back after it.
FINISH_RESERVE_SECONDS = 240

# The closeness check: llama-perplexity over the held-out prompts and their references as plain text (it reads no
# chat-template token in its text), in chunks of KL_CTX tokens. Less held-out text than this can't fill two chunks.
KL_CTX = 512
KL_TEXT_MIN_CHARS = 6000
KL_MEAN_RE = re.compile(r"Mean\s+KLD:\s*([-+0-9.eE]+)")
KL_P99_RE = re.compile(r"99\.0%\s+KLD:\s*([-+0-9.eE]+)")
TOP_TOKEN_RE = re.compile(r"Same top p:\s*([-+0-9.eE]+)")

# The template and channel checks: llama-server on Q4_K_M, local only, 4 slots, an 8K context in all, answering each
# held-out prompt greedily with 1,024 new tokens. It gets this long to load and to answer one prompt.
SERVER_CTX = 8192
SERVER_SLOTS = 4
SERVER_START_SECONDS = 600
SERVER_ANSWER_SECONDS = 300
CHANNEL_MAX_TOKENS = 1024
# With tuned.jinja the final channel is already open, so a message that ends or a new one ends the answer.
TUNED_STOPS = ["<|eom|>", "<|start|>"]
# An answer with these in it shows the format leaked: it isn't a final answer.
LEAKED = ("<|start|>", "to=self<|message|>", "<|message|>")
# Agreement: how many answers start with the same this-many characters as the adapter's own eval answers.
AGREE_CHARS = 200
# The repo's small files, as the platform checks them (ggufSystemLine and ggufParams in lib/train/hub-cards.ts).
REASONING_LINE = "Reasoning strength: low."
SYSTEM_FILE = "system"
PARAMS_FILE = "params"
STOPS_CHANNEL = ["<|eot|>", "<|end_of_text|>"]
STOPS_TUNED = ["<|eot|>", "<|eom|>", "<|end_of_text|>", "<|start|>"]


def read_quant_params(params):
    """adapter_job_id (lowercased), levels (QUANT_LEVELS the levels param names, in order), slug, train_channel (0 or 1)
    and publish. Anything that isn't one of those is refused, so a caller can't choose a build or a name."""
    adapter = str(params.get("adapterJobId") or "").strip().lower()
    if not JOB_ID_RE.match(adapter):
        raise ValueError("adapterJobId must be the id of a glimmer-lora job, not " + json.dumps(str(params.get("adapterJobId")))[:60])
    asked = [s.strip() for s in str(params.get("levels") or "").split(",") if s.strip()]
    if not asked or any(level not in QUANT_LEVELS for level in asked):
        raise ValueError("levels must name builds from " + ", ".join(QUANT_LEVELS) + ", not " + json.dumps(str(params.get("levels")))[:80])
    if CHECK_LEVEL not in asked:
        raise ValueError("levels must include " + CHECK_LEVEL + ", the build the template and channel checks run on")
    slug = str(params.get("slug") or "")
    if len(slug) > SLUG_MAX or not SLUG_RE.match(slug):
        raise ValueError("slug must be lowercase words and single dashes, at most " + str(SLUG_MAX) + " characters, not " + json.dumps(slug)[:60])
    channel = number(params, "trainChannel", 0)
    if channel not in (0, 1):
        raise ValueError("trainChannel must be 0 or 1")
    return {
        "adapter_job_id": adapter,
        "levels": [level for level in QUANT_LEVELS if level in asked],
        "slug": slug,
        "train_channel": int(channel),
        "publish": number(params, "publish", 1) != 0,
    }


def gguf_name(slug, level):
    """A build's file name on the Hub (ggufFileName in lib/train/hub-cards.ts)."""
    return "muse-glimmer-30b-" + slug + "-" + level + ".gguf"


def level_key(level):
    """A build's prefix in the metrics: q4_k_m for Q4_K_M."""
    return level.lower()


def safetensors_header(path):
    """The JSON header of a safetensors file: {name: {"dtype", "shape", "data_offsets"}, "__metadata__": ...}. Read from
    its first 8 bytes (the header's length) and the header itself, never the tensors."""
    with open(path, "rb") as f:
        size = int.from_bytes(f.read(8), "little")
        if size <= 0 or size > 100 * 1024 * 1024:
            raise ValueError(path + " isn't a safetensors file")
        header = json.loads(f.read(size).decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError(path + " has no safetensors header")
    return header


def tensors_of(folder):
    """{name: shape} of every tensor in a folder's safetensors files (an adapter's own files left out)."""
    out = {}
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".safetensors") or name.startswith("adapter_"):
            continue
        for key, value in safetensors_header(os.path.join(folder, name)).items():
            if key != "__metadata__" and isinstance(value, dict):
                out[key] = [int(n) for n in value.get("shape") or []]
    return out


def tensors_digest(tensors):
    """The sha256 of the sorted "name:shape" lines of {name: shape}, as BASE_TENSORS_SHA256 is made."""
    lines = sorted(name + ":" + "x".join(str(n) for n in shape) for name, shape in tensors.items())
    return hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()


def merged_problem(folder):
    """Why a merged folder isn't the base with the adapter folded in, or None: it must have the base's 1,436 tensor names
    and shapes, and none of a LoRA's or a 4-bit model's own."""
    tensors = tensors_of(folder)
    leftovers = [n for n in sorted(tensors) if "lora_" in n or ".base_layer." in n or "absmax" in n or "quant_state" in n or "quant_map" in n]
    if leftovers:
        return "The merged model still has an adapter's or a 4-bit model's tensors, such as " + ", ".join(leftovers[:3])
    if len(tensors) != BASE_TENSORS or tensors_digest(tensors) != BASE_TENSORS_SHA256:
        return (
            "The merged model has " + str(len(tensors)) + " tensors whose names and shapes aren't the base's " + str(BASE_TENSORS)
            + " (digest " + tensors_digest(tensors)[:12] + ", not " + BASE_TENSORS_SHA256[:12] + ")"
        )
    return None


def vision_problem(adapter_dir, config):
    """Why an adapter touches the vision tower, or None: adapter_config.json's target_modules (a list, or the regex
    PEFT matches whole names against) must match no module of the tower, and its weights must have no tensor of it."""
    weights = os.path.join(adapter_dir, "adapter_model.safetensors")
    names = [n for n in safetensors_header(weights) if n != "__metadata__"]
    vision = [n for n in names if "vision" in n]
    if vision:
        return "The adapter has weights for the vision tower, such as " + vision[0] + ", and local files are text only"
    targets = config.get("target_modules")
    probes = (
        "model.vision_tower.encoder.layers.0.self_attn.q_proj",
        "model.vision_tower.encoder.layers.0.mlp.fc1",
        "model.vision_adapter.fc1",
        "model.vision_projection",
    )
    if isinstance(targets, str):
        try:
            hits = [m for m in probes if re.fullmatch(targets, m)]
        except re.error:
            return "The adapter's target_modules isn't a pattern this job can read"
    elif isinstance(targets, list):
        hits = [t for t in targets if isinstance(t, str) and "vision" in t]
    else:
        hits = []
    if hits:
        return "The adapter's target_modules reach the vision tower (" + str(hits[0]) + "), and local files are text only"
    return None


def quant_adapter_problem(adapter_dir, adapter_job_id):
    """Why the adapter in the cache can't be merged (none in this region, a dry run's stand-in, no safetensors weights, or
    one that reaches the vision tower), or None when it can."""
    where = "the adapter of job " + adapter_job_id + " in " + adapter_dir
    try:
        with open(os.path.join(adapter_dir, ADAPTER_CONFIG), encoding="utf-8") as f:
            config = json.load(f)
    except OSError:
        return "There is no adapter in the cache at " + adapter_dir + ": job " + adapter_job_id + " saved none in this region"
    except ValueError:
        return "The " + ADAPTER_CONFIG + " of " + where + " isn't JSON"
    if not isinstance(config, dict) or config.get("dry_run"):
        return where + " is a dry run's stand-in, not a trained adapter"
    if not os.path.isfile(os.path.join(adapter_dir, "adapter_model.safetensors")):
        return where + " has no adapter_model.safetensors"
    try:
        return vision_problem(adapter_dir, config)
    except (OSError, ValueError) as e:
        return "The weights of " + where + " couldn't be read: " + str(e)[:200]


def total_ram_bytes():
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return 0


def machine_problem(work_dir, disk=None, ram=None):
    """Why this machine can't make the files, or None: local disk under MIN_DISK_BYTES free, or RAM under MIN_RAM_BYTES."""
    free = shutil.disk_usage(work_dir).free if disk is None else disk
    memory = total_ram_bytes() if ram is None else ram
    if free < MIN_DISK_BYTES:
        return "Only " + str(round(free / 1e9)) + " GB of local disk is free, and making the files needs " + str(MIN_DISK_BYTES // 10 ** 9) + " GB"
    if memory < MIN_RAM_BYTES:
        return "This machine has " + str(round(memory / 1024 ** 3)) + " GiB of RAM, and the merge needs " + str(MIN_RAM_BYTES // 1024 ** 3) + " GiB"
    return None


def left(ctx, started):
    return job_deadline(ctx, started) - time.time()


def need(ctx, started, seconds, what):
    """Raises unless at least seconds are left before the job's deadline, so a job that couldn't finish fails now."""
    have = left(ctx, started)
    if have < seconds:
        raise RuntimeError("Only " + minutes(have) + " are left before the job's time limit, too few to " + what + " (it needs " + minutes(seconds) + ")")


def timeout_for(ctx, started):
    """A command's timeout: the time left, less what the report back needs."""
    return int(max(60, left(ctx, started) - FINISH_RESERVE_SECONDS))


def quant_system(ctx):
    """(role, how): the one-line system message the adapter trained under ("You are " and its dataset's title, see
    student_system), from the first train page of the adapter job's dataset, which the platform's dataset route serves
    a glimmer-quantize job. An error status fails the job: the files would be checked under the wrong line."""
    page = ctx.get_json("/dataset?part=train&page=0")
    page = page if isinstance(page, dict) else {}
    items = page.get("items") if isinstance(page.get("items"), list) else []
    title = page.get("title") if isinstance(page.get("title"), str) else None
    role = student_system(title, shared_system(train_examples(items)))
    return role, "the system message " + json.dumps(role, ensure_ascii=False) + ", made from the dataset " + json.dumps(title, ensure_ascii=False)


def held_out(items):
    """The held-out prompts with their references and the adapter's own tuned answers (which the dataset route adds for a
    glimmer-quantize job), at most EVAL_MAX."""
    out = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("prompt"), str) and item["prompt"].strip():
            out.append({"prompt": item["prompt"], "reference": str(item.get("reference") or ""), "tuned": str(item.get("tuned") or "")})
    return out[:EVAL_MAX]


def system_line(role):
    """The system message a local app gets (the repo's system file): the role, a blank line, the reasoning line."""
    return role + "\n\n" + REASONING_LINE


def params_file(train_channel):
    """Ollama's params file for the repo (ggufParams in lib/train/hub-cards.ts, byte for byte)."""
    stops = STOPS_CHANNEL if train_channel == 1 else STOPS_TUNED
    return json.dumps({"temperature": 0, "num_ctx": 8192, "stop": stops}, indent=2) + "\n"


def tuned_template(meta_text):
    """tuned.jinja from Meta's template: each of TUNED_EDITS applied, each found exactly once, and the result checked
    against TUNED_TEMPLATE_SHA256."""
    text = meta_text
    for old, new in TUNED_EDITS:
        if text.count(old) != 1:
            raise RuntimeError("Meta's chat template doesn't have exactly one " + json.dumps(old[:40]) + ", so tuned.jinja can't be made from it")
        text = text.replace(old, new)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != TUNED_TEMPLATE_SHA256:
        raise RuntimeError("tuned.jinja came out with sha256 " + digest + ", not the pinned " + TUNED_TEMPLATE_SHA256)
    return text


def pinned_fetch(url, sha256, path, what):
    """Downloads url to path (3 tries) and keeps it only when its sha256 is the pinned one, as uv_binary does."""
    fetch(url, path)
    digest = sha256_of(path)
    if digest != sha256:
        os.remove(path)
        raise RuntimeError("The " + what + " download has sha256 " + digest + ", not the pinned " + sha256)
    return path


def unpack(archive, folder, top, parts=None):
    """Unpacks a checked tar.gz into folder and returns folder/top. Every member must sit under top, and so must every
    link's target; parts, when given, picks the members to unpack (paths under top)."""
    os.makedirs(folder, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        members = []
        for m in tar.getmembers():
            name = m.name.rstrip("/")
            if name.startswith("/") or ".." in name.split("/") or not (name == top or name.startswith(top + "/")):
                raise RuntimeError("The archive " + os.path.basename(archive) + " has a member outside " + top + ": " + name[:120])
            if (m.issym() or m.islnk()) and (m.linkname.startswith("/") or ".." in m.linkname.split("/")):
                raise RuntimeError("The archive " + os.path.basename(archive) + " has a link out of its folder: " + name[:120])
            rest = name[len(top) + 1:]
            if parts is None or name == top or any(rest == p.rstrip("/") or rest.startswith(p) for p in parts):
                members.append(m)
        if hasattr(tarfile, "data_filter"):
            tar.extractall(folder, members=members, filter="data")
        else:
            tar.extractall(folder, members=members)
    return os.path.join(folder, top)


def llamacpp_tools(ctx, folder):
    """The pinned llama.cpp in folder (on local disk): its CUDA build's bin folder, the converter and gguf-py, and the
    env every tool runs with (the CUDA runtime beside it). Every download is checked against its sha256 first."""
    os.makedirs(folder, exist_ok=True)
    ctx.log("Downloading llama.cpp " + LLAMACPP_TAG + ": its CUDA build, its CUDA runtime and its source, each checked against its sha256")
    archives = {}
    for name, sha256, _top in (LLAMACPP_BUILD, LLAMACPP_CUDART):
        archives[name] = pinned_fetch(LLAMACPP_RELEASE_URL + name, sha256, os.path.join(folder, name), "llama.cpp " + name)
    source = pinned_fetch(LLAMACPP_SOURCE[0], LLAMACPP_SOURCE[1], os.path.join(folder, "source.tar.gz"), "llama.cpp " + LLAMACPP_TAG + " source")
    bin_dir = unpack(archives[LLAMACPP_BUILD[0]], os.path.join(folder, "cuda"), LLAMACPP_BUILD[2])
    runtime = unpack(archives[LLAMACPP_CUDART[0]], os.path.join(folder, "cudart"), LLAMACPP_CUDART[2])
    src = unpack(source, os.path.join(folder, "src"), LLAMACPP_SOURCE[2], LLAMACPP_SOURCE_PARTS)
    for path in list(archives.values()) + [source]:
        os.remove(path)
    return {
        "bin": bin_dir,
        "convert": os.path.join(src, "convert_hf_to_gguf.py"),
        "gguf_py": os.path.join(src, "gguf-py"),
        "env": {"LD_LIBRARY_PATH": bin_dir + ":" + runtime + (":" + os.environ["LD_LIBRARY_PATH"] if os.environ.get("LD_LIBRARY_PATH") else "")},
    }


def tool(tools, name):
    return os.path.join(tools["bin"], name)


def cuda_devices(ctx, tools):
    """The GPU llama.cpp's CUDA build sees (llama-server --list-devices), or a RuntimeError: without it every check would
    run on the CPU for hours."""
    out = ctx.run(shlex.quote(tool(tools, "llama-server")) + " --list-devices", timeout=120, env=tools["env"])
    found = [line.strip() for line in (out.stdout or "").splitlines() if line.strip().startswith("CUDA")]
    if out.returncode != 0 or not found:
        raise RuntimeError("llama.cpp's CUDA build found no GPU, so the checks can't run: " + last_lines(out, 8))
    head = found[0].split(":", 1)[-1].strip()
    return head.split(" (", 1)[0].strip() or head


def meta_files(ctx, folder):
    """Meta's template and tokenizer files at META_REVISION in folder, each checked against its sha256. {name: path}."""
    os.makedirs(folder, exist_ok=True)
    ctx.log("Downloading Meta's chat template and tokenizer files at " + META_REPO + "@" + META_REVISION[:12])
    return {name: pinned_fetch(META_URL + name, sha256, os.path.join(folder, name), META_REPO + " " + name) for name, sha256 in META_FILES}


def install_meta_files(merged_dir, files):
    """Puts Meta's files into the merged folder in place of the ones Unsloth saved, so the converter embeds Meta's
    template: chat_template.json goes (a stray copy the converter would read), and so does any chat_template key a saved
    tokenizer_config.json had, since Meta's has none and the converter reads that key first."""
    for name, path in files.items():
        shutil.copyfile(path, os.path.join(merged_dir, name))
    stray = os.path.join(merged_dir, "chat_template.json")
    if os.path.exists(stray):
        os.remove(stray)
    with open(os.path.join(merged_dir, "tokenizer_config.json"), encoding="utf-8") as f:
        if "chat_template" in json.load(f):
            raise RuntimeError("Meta's tokenizer_config.json has a chat_template key, which would replace its chat_template.jinja")


def downloaded_shards(merged_dir):
    """{shard: (commit, sha256)} of the BASE_SHARDS that snapshot_download(local_dir=merged_dir) fetched, from the record
    huggingface_hub keeps beside them: .cache/huggingface/download/<shard>.metadata holds the commit, the etag and the
    time, and an LFS file's etag is its SHA-256. The shards themselves are merged in place, so only this says what
    they were."""
    out = {}
    for name, _sha in BASE_SHARDS:
        path = os.path.join(merged_dir, ".cache", "huggingface", "download", name + ".metadata")
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        if len(lines) >= 2:
            etag = lines[1].strip()
            out[name] = (lines[0].strip(), (etag[2:] if etag.startswith("W/") else etag).strip('"'))
    return out


def cached_shards(hf_home):
    """{shard: (revision, sha256)} of the BASE_SHARDS one snapshot of an HF cache under hf_home holds: each a link to a
    blob the cache names by its SHA-256."""
    snapshots = os.path.join(hf_home, "hub", "models--" + MERGE_BASE.replace("/", "--"), "snapshots")
    try:
        revisions = sorted(os.listdir(snapshots))
    except OSError:
        return {}
    for revision in revisions:
        found = {}
        for name, _sha in BASE_SHARDS:
            path = os.path.join(snapshots, revision, name)
            if os.path.exists(path):
                found[name] = (revision, os.path.basename(os.path.realpath(path)))
        if len(found) == len(BASE_SHARDS):
            return found
    return {}


def base_shards_problem(merged_dir, hf_home):
    """(revision, problem): the commit of MERGE_BASE whose 16-bit shards the merge used, and why they aren't
    BASE_SHARDS, or None. Unsloth downloads them with snapshot_download(local_dir=merged_dir), which records each one's
    commit and SHA-256 beside it (downloaded_shards), or copies them from an HF cache under hf_home (cached_shards).
    Each must have BASE_SHARDS' SHA-256, and all one commit. Unsloth asks for whatever MERGE_BASE's main is, so a base
    that changed upstream fails here. No record in either place fails too: the files are published as MERGE_BASE with
    the adapter folded in, and the card names its shards only because this check passed."""
    found = downloaded_shards(merged_dir)
    if len(found) != len(BASE_SHARDS):
        found = cached_shards(hf_home)
    if len(found) != len(BASE_SHARDS):
        return None, (
            "The merge left no record of which " + MERGE_BASE + " shards it downloaded, so its 16-bit base can't be checked"
            " against its pinned SHA-256, and nothing is published"
        )
    for name, sha in BASE_SHARDS:
        if found[name][1] != sha:
            return None, "The 16-bit base's " + name + " isn't " + MERGE_BASE + "'s shard: its SHA-256 is " + found[name][1][:16]
    revisions = sorted({commit for commit, _sha in found.values()})
    if len(revisions) != 1 or not re.match(r"^[0-9a-f]{40}$", revisions[0]):
        return None, "The 16-bit base's shards don't come from one commit of " + MERGE_BASE + ": " + ", ".join(r[:12] for r in revisions)
    return revisions[0], None


def ensure_convert_venv(ctx, base, started):
    """The converter venv's python and whether it was reused: one job in the region builds it, holding its lock, while
    the others wait and reuse it, as ensure_venv does for glimmer's venv."""
    name = "llamacpp-" + hashlib.sha256("\n".join((PYTHON, UV_VERSION) + CONVERT_INSTALL).encode("utf-8")).hexdigest()[:12]
    venv = os.path.join(base, "venvs", name)
    python = os.path.join(venv, "bin", "python")
    tag = str(ctx.job_id or "job")[:8]
    if venv_ready(venv):
        mark_used(venv)
        return python, True
    os.makedirs(os.path.dirname(venv), exist_ok=True)
    lock = venv + ".lock"
    waiting = False
    while True:
        try:
            os.mkdir(lock)
        except FileExistsError:
            if venv_ready(venv):
                ctx.log("Another job in the region installed the converter's venv while this one waited")
                mark_used(venv)
                return python, True
            age = age_of(lock)
            if age is not None and age >= LOCK_STALE_SECONDS:
                ctx.log("Breaking the converter venv's build lock " + lock + ", untouched for " + minutes(age))
                aside = lock + ".stale-" + tag + "-" + str(int(time.time()))
                try:
                    os.rename(lock, aside)
                    shutil.rmtree(aside, ignore_errors=True)
                except OSError:
                    pass
                continue
            if not waiting:
                waiting = True
                ctx.progress(message="Waiting for another job in the region to finish installing llama.cpp's converter")
            need(ctx, started, MIN_START_SECONDS, "wait for another job's converter venv")
            time.sleep(LOCK_POLL_SECONDS)
            continue
        with open(os.path.join(lock, "owner"), "w") as f:
            f.write(json.dumps({"job": str(ctx.job_id or "job"), "at": int(time.time())}))
        break
    keeper = LockKeeper(lock)
    keeper.start()
    try:
        reused = venv_ready(venv) or build_convert_venv(ctx, base, venv, tag, started)
    finally:
        keeper.stop()
        if lock_owner(lock) in (str(ctx.job_id or "job"), None):
            shutil.rmtree(lock, ignore_errors=True)
    mark_used(venv)
    remove_leftovers(os.path.dirname(venv))
    return python, reused


def build_convert_venv(ctx, base, venv, tag, started):
    """Builds the converter venv aside with the pinned uv, checks it and renames it into place. True when another job's
    venv got there first."""
    ctx.progress(message="Installing llama.cpp's converter into a venv")
    uv = uv_binary(ctx, base)
    building = venv + ".building-" + tag
    shutil.rmtree(building, ignore_errors=True)
    env = {
        "UV_PYTHON_INSTALL_DIR": os.path.join(base, "uv", "python"),
        "UV_CACHE_DIR": os.path.join(ctx.work_dir, "uv-cache"),
        "UV_LINK_MODE": "copy",
    }
    q = shlex.quote
    try:
        cap = lambda seconds: int(min(seconds, max(60, left(ctx, started) - NEED_MERGE_SECONDS)))
        ctx.run(q(uv) + " venv --relocatable --python-preference only-managed --python " + PYTHON + " " + q(building), timeout=cap(VENV_TIMEOUT_SECONDS), check=True, env=env, stall_seconds=STALL_SECONDS)
        target = q(os.path.join(building, "bin", "python"))
        for i, line in enumerate(CONVERT_INSTALL):
            flags = " --compile-bytecode" if i == len(CONVERT_INSTALL) - 1 else ""
            ctx.run(q(uv) + " pip install" + flags + " --python " + target + " " + line, timeout=cap(INSTALL_TIMEOUT_SECONDS), check=True, env=env, stall_seconds=STALL_SECONDS)
        out = ctx.run(target + " -c " + q(CONVERT_CHECK), timeout=cap(VENV_TIMEOUT_SECONDS), check=True, env={"PYTHONDONTWRITEBYTECODE": "1"}, stall_seconds=STALL_SECONDS)
        if CONVERT_READY_LINE not in (out.stdout or ""):
            raise RuntimeError("The converter's venv doesn't have " + CONVERT_READY_LINE + ": " + (out.stdout or "")[-300:])
        with open(os.path.join(building, READY_MARKER), "w") as f:
            f.write(json.dumps({"install": CONVERT_INSTALL, "python": PYTHON, "uv": UV_VERSION, "at": int(time.time())}))
    except BaseException:
        shutil.rmtree(building, ignore_errors=True)
        raise
    return settle_venv(building, venv, tag)


def link_cached_model(cache_hf, local_hf):
    """Links the cache's 4-bit model into the local HF_HOME, so the merge loads it from the cache while everything it
    downloads (the 16-bit base) lands on local disk. False when the cache doesn't have it yet."""
    folder = "models--" + MODEL.replace("/", "--")
    source = os.path.join(cache_hf, "hub", folder)
    link = os.path.join(local_hf, "hub", folder)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if not os.path.isdir(source):
        return False
    if not os.path.lexists(link):
        os.symlink(source, link)
    return True


def remove_local_hf(local_hf):
    """Deletes the local HF_HOME (the 16-bit base download), first taking out the link to the cache's 4-bit model, so
    nothing of the cache is ever touched."""
    folder = os.path.join(local_hf, "hub", "models--" + MODEL.replace("/", "--"))
    if os.path.islink(folder):
        os.unlink(folder)
    shutil.rmtree(local_hf, ignore_errors=True)


def gguf_meta(ctx, tools, python, path):
    """{"architecture", "tensors", "chat_template_sha256"} of a GGUF file, read with gguf-py in the converter's venv."""
    if not os.path.isfile(path):
        raise RuntimeError("There is no " + os.path.basename(path))
    with open(path, "rb") as f:
        if f.read(4) != GGUF_MAGIC:
            raise RuntimeError(os.path.basename(path) + " doesn't start with the GGUF magic")
    cmd = shlex.quote(python) + " -I " + shlex.quote(os.path.abspath(__file__)) + " --gguf-meta " + shlex.quote(path) + " " + shlex.quote(tools["gguf_py"])
    out = ctx.run(cmd, timeout=600, env={"PYTHONDONTWRITEBYTECODE": "1"})
    for line in reversed((out.stdout or "").splitlines()):
        if line.startswith("MUSE_GGUF "):
            return json.loads(line[len("MUSE_GGUF "):])
    raise RuntimeError("gguf-py couldn't read " + os.path.basename(path) + ": " + last_lines(out, 8))


def gguf_problem(meta, name):
    """Why a GGUF file isn't Muse Glimmer's text model with Meta's template in it, or None."""
    if meta.get("architecture") != GGUF_ARCH:
        return name + " has the architecture " + json.dumps(meta.get("architecture")) + ", not " + GGUF_ARCH
    if meta.get("tensors") != GGUF_TENSORS:
        return name + " has " + str(meta.get("tensors")) + " tensors, not the text model's " + str(GGUF_TENSORS)
    if meta.get("chat_template_sha256") != META_FILES[0][1]:
        return name + " doesn't carry Meta's chat template at " + META_REVISION[:12]
    return None


def heldout_text(evals):
    """The held-out prompts and their reference answers as plain text, for llama-perplexity."""
    return "".join(e["prompt"].strip() + "\n\n" + e["reference"].strip() + "\n\n" for e in evals)


def kl_of(ctx, tools, model, base_path, started, text_path=None):
    """llama-perplexity on model: with text_path, writes the KL divergence reference to base_path; else the mean and
    99th-percentile KL divergence and the top-token agreement (in percent) against it. The lines are read as they come,
    since the log keeps only a command's last lines."""
    seen = {}

    def on_line(line):
        for key, pattern in (("mean", KL_MEAN_RE), ("p99", KL_P99_RE), ("top", TOP_TOKEN_RE)):
            m = pattern.search(line)
            if m:
                seen[key] = float(m.group(1))

    cmd = shlex.quote(tool(tools, "llama-perplexity")) + " -m " + shlex.quote(model) + " -c " + str(KL_CTX) + " --kl-divergence-base " + shlex.quote(base_path)
    cmd += " -f " + shlex.quote(text_path) if text_path else " --kl-divergence"
    out = ctx.run(cmd, timeout=timeout_for(ctx, started), env=tools["env"], on_line=on_line, stall_seconds=STALL_SECONDS)
    if out.returncode != 0:
        raise RuntimeError("llama-perplexity failed on " + os.path.basename(model) + ":\n" + last_lines(out))
    if text_path:
        if not os.path.isfile(base_path):
            raise RuntimeError("llama-perplexity wrote no KL divergence reference for " + os.path.basename(model))
        return None
    if "mean" not in seen:
        raise RuntimeError("llama-perplexity reported no mean KL divergence for " + os.path.basename(model) + ":\n" + last_lines(out))
    return seen


class LlamaServer:
    """llama-server on one GGUF file, on 127.0.0.1 at a free port, with its output in a log file. Used with "with": it is
    stopped (SIGTERM, then SIGKILL) however the block ends."""

    def __init__(self, ctx, tools, model, args, log_path):
        self.ctx, self.tools, self.model, self.args, self.log_path = ctx, tools, model, args, log_path
        self.proc = None
        self.port = None

    def __enter__(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        self.port = probe.getsockname()[1]
        probe.close()
        cmd = [tool(self.tools, "llama-server"), "-m", self.model, "--host", "127.0.0.1", "--port", str(self.port)] + self.args
        env = dict(os.environ)
        env.update(self.tools["env"])
        self.log = open(self.log_path, "wb")
        self.ctx.log("$ " + " ".join(shlex.quote(c) for c in cmd))
        self.proc = subprocess.Popen(cmd, stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, start_new_session=True)
        until = time.time() + SERVER_START_SECONDS
        while time.time() < until:
            if self.proc.poll() is not None:
                raise RuntimeError("llama-server stopped before it was ready:\n" + self.tail())
            try:
                status, _ = self.call("GET", "/health", None, 5)
                if status == 200:
                    return self
            except (OSError, urllib.error.URLError, ValueError):
                pass
            time.sleep(2)
        raise RuntimeError("llama-server wasn't ready within " + minutes(SERVER_START_SECONDS) + ":\n" + self.tail())

    def __exit__(self, *exc):
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except OSError:
                    pass
        self.log.close()
        return False

    def tail(self, size=3000):
        try:
            with open(self.log_path, "rb") as f:
                return f.read()[-size:].decode("utf-8", "replace")
        except OSError:
            return ""

    def call(self, method, path, body, timeout):
        """(status, parsed JSON or None). Straight to 127.0.0.1, never through a proxy."""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request("http://127.0.0.1:" + str(self.port) + path, data=data, method=method, headers={"Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as res:
                raw = res.read()
                return res.status, json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw.decode("utf-8")) if raw else None
            except ValueError:
                return e.code, None


def template_problem(server, system, prompt, expected, bos):
    """Why the prompt llama-server renders for system and prompt isn't the one training used, character for character,
    or None. A leading bos is the tokenizer's and doesn't count."""
    status, body = server.call("POST", "/apply-template", {"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}, 60)
    got = body.get("prompt") if isinstance(body, dict) else None
    if status != 200 or not isinstance(got, str):
        return "llama-server didn't render the prompt (HTTP " + str(status) + ")"
    if bos and got.startswith(bos):
        got = got[len(bos):]
    if got == expected:
        return None
    at = next((i for i, (a, b) in enumerate(zip(got, expected)) if a != b), min(len(got), len(expected)))
    return (
        "The prompt the files render isn't training's: they differ at character " + str(at) + ", where the files have "
        + json.dumps(got[max(0, at - 30):at + 40], ensure_ascii=False) + " and training had " + json.dumps(expected[max(0, at - 30):at + 40], ensure_ascii=False)
    )


def final_text(body):
    """The final answer in a chat completion's answer, or None when it has none: an empty answer, one cut off by the token
    budget, or one that shows the format leaked."""
    choice = (body.get("choices") or [None])[0] if isinstance(body, dict) else None
    message = choice.get("message") if isinstance(choice, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip() or choice.get("finish_reason") != "stop":
        return None
    if any(token in content for token in LEAKED):
        return None
    return content.strip()


def channel_check(server, system, evals, tuned, stop_at):
    """(finals, answers): how many held-out prompts get a final answer under the prompt a stock app sends, each answered
    greedily with CHANNEL_MAX_TOKENS new tokens, SERVER_SLOTS at a time, and each answer (None when it had none)."""
    answers = [None] * len(evals)
    lock = threading.Lock()
    queue = list(range(len(evals)))
    failures = []

    def worker():
        while True:
            with lock:
                if not queue or failures:
                    return
                i = queue.pop(0)
            if time.time() > stop_at:
                with lock:
                    failures.append("the job's time limit came before every held-out prompt was answered")
                return
            body = {
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": evals[i]["prompt"]}],
                "temperature": 0,
                "max_tokens": CHANNEL_MAX_TOKENS,
                "stream": False,
                "chat_template_kwargs": {"reasoning_strength": "low"},
            }
            if tuned:
                body["stop"] = TUNED_STOPS
            try:
                status, answer = server.call("POST", "/v1/chat/completions", body, SERVER_ANSWER_SECONDS)
            except (OSError, urllib.error.URLError, ValueError) as e:
                with lock:
                    failures.append("held-out prompt " + str(i + 1) + " got no answer: " + type(e).__name__)
                return
            if status != 200:
                with lock:
                    failures.append("held-out prompt " + str(i + 1) + " got HTTP " + str(status))
                return
            answers[i] = final_text(answer)

    threads = [threading.Thread(target=worker, name="muse-channel", daemon=True) for _ in range(SERVER_SLOTS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if failures:
        raise RuntimeError("The channel check didn't finish: " + failures[0])
    return sum(1 for a in answers if a), answers


def agreement(answers, evals):
    """(same, total): of the adapter's finished eval answers, how many the files' answers start the same way as."""
    same = total = 0
    for answer, e in zip(answers, evals):
        own = e.get("tuned") or ""
        if not own.strip() or own.startswith("[Unfinished"):
            continue
        total += 1
        if answer and answer[:AGREE_CHARS].strip() == own.strip()[:AGREE_CHARS].strip():
            same += 1
    return same, total


def remove(path):
    """Deletes a file or folder that nothing needs any more, so local disk never holds more than a stage at a time."""
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.lexists(path):
        os.remove(path)


def run_merge(ctx, python, cfg, env, started):
    """Runs the merge child on glimmer's venv and returns its result, or raises with how it ended."""
    config_path = os.path.join(ctx.work_dir, "merge-config.json")
    with open(config_path, "w") as f:
        json.dump(cfg, f)
    cmd = shlex.quote(python) + " -u " + shlex.quote(os.path.abspath(__file__)) + " --merge " + shlex.quote(config_path)
    seen = set()
    out = run_child(ctx, cmd, timeout_for(ctx, started), env, seen)
    result = read_result(cfg["result_path"])
    if result is None or not result.get("merged"):
        ended = "timed out" if getattr(out, "timed_out", False) else "exited with " + str(out.returncode)
        missing = "ModuleNotFoundError" in (out.stdout or "")
        if out.returncode != 0 and "imported" not in seen and missing:
            mark_broken(ctx, os.path.dirname(os.path.dirname(python)))
        raise RuntimeError("The merge " + ended + " before the merged model was saved:\n" + last_lines(out))
    return result


def upload(ctx, out_dir, adapter_job_id):
    """Sends the folder to the GGUF repo's storage (ctx.hub_upload) and returns what it says, or raises: the files exist
    only on this GPU, so files that didn't all arrive fail the job."""
    out = ctx.hub_upload(out_dir)
    if out.get("skipped"):
        raise RuntimeError("The local files of job " + adapter_job_id[:8] + " weren't sent to the Hugging Face Hub: " + str(out["skipped"]))
    failed = out.get("failed") or []
    if failed:
        lines = [str(f.get("path")) + ": " + str(f.get("error")) for f in failed[:5]]
        raise RuntimeError(str(len(failed)) + " of the local files didn't reach the Hugging Face Hub's storage:\n" + "\n".join(lines))
    return out


def run(ctx):
    started = time.time()
    p = read_quant_params(ctx.params)
    adapter_job_id = p["adapter_job_id"]
    base, cache_used = base_dir(ctx)
    if not cache_used:
        raise RuntimeError(
            "The model cache isn't mounted or isn't writable, so the adapter of job " + adapter_job_id + " can't be read. A"
            " local files job runs in its adapter's region, with that cache mounted"
        )
    adapter_dir = os.path.join(base, "models", adapter_job_id)
    problem = quant_adapter_problem(adapter_dir, adapter_job_id) or machine_problem(ctx.work_dir)
    if problem:
        raise RuntimeError(problem)
    need(ctx, started, MIN_START_SECONDS, "merge the adapter and make, check and upload the files")
    role, how = quant_system(ctx)
    evals = held_out(ctx.dataset("eval"))
    text = heldout_text(evals)
    if len(evals) < 2 or len(text) < KL_TEXT_MIN_CHARS:
        raise RuntimeError("The adapter's dataset holds out too little to check the files with: " + str(len(evals)) + " prompts, " + str(len(text)) + " characters")
    tuned = p["train_channel"] == 0
    system = system_line(role)
    ctx.log(
        "Making the local files of job " + adapter_job_id + " (" + ", ".join(p["levels"]) + "), checked under " + how
        + (", with tuned.jinja, since the adapter was trained before trainChannel" if tuned else "")
    )
    metrics = {"adapter_job_id": adapter_job_id, "llamacpp": LLAMACPP_TAG, "llamacpp_commit": LLAMACPP_COMMIT, "levels": ",".join(p["levels"])}

    began = time.time()
    tools = llamacpp_tools(ctx, os.path.join(ctx.work_dir, "llamacpp"))
    meta = meta_files(ctx, os.path.join(ctx.work_dir, "meta"))
    with open(meta[META_TEMPLATE], encoding="utf-8") as f:
        tuned_text = tuned_template(f.read())
    metrics["gpu"] = cuda_devices(ctx, tools)
    convert_python, convert_reused = ensure_convert_venv(ctx, base, started)
    python, venv_reused = ensure_venv(ctx, base)
    metrics["cached_venv"] = "yes" if venv_reused and convert_reused else "no"
    metrics["setup_seconds"] = round(time.time() - began, 1)

    # The merge: the 4-bit model from the cache, the 16-bit base downloaded to local disk.
    need(ctx, started, NEED_MERGE_SECONDS, "merge the adapter")
    local_hf = os.path.join(ctx.work_dir, "hf")
    cache_hf = os.path.join(base, "hf")
    os.makedirs(cache_hf, exist_ok=True)
    remove_stale_hf_locks(ctx, cache_hf)
    linked = link_cached_model(cache_hf, local_hf)
    merged = os.path.join(ctx.work_dir, "merged")
    remove(merged)
    ctx.progress(message="Merging the adapter into the 16-bit base")
    began = time.time()
    result = run_merge(
        ctx,
        python,
        {
            "model": MODEL,
            "revision": MODEL_REVISION,
            "merge_base": MERGE_BASE,
            "max_seq_length": MAX_SEQ_LENGTH,
            "adapter_dir": adapter_dir,
            "adapter_job_id": adapter_job_id,
            "merged_dir": merged,
            "system": role,
            "prompt": evals[0]["prompt"],
            "result_path": os.path.join(ctx.work_dir, "merge-result.json"),
        },
        {"HF_HOME": local_hf, "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false", "PYTHONDONTWRITEBYTECODE": "1"},
        started,
    )
    metrics["merge_seconds"] = round(time.time() - began, 1)
    metrics["cached_weights"] = "yes" if linked else "no"
    revision, problem = base_shards_problem(merged, local_hf)
    problem = problem or merged_problem(merged)
    if problem:
        raise RuntimeError(problem)
    metrics["merge_base"] = MERGE_BASE
    # Only ever a commit whose shards matched BASE_SHARDS: the card names the base's shards only with it.
    metrics["merge_base_revision"] = revision
    metrics["tensors"] = BASE_TENSORS
    install_meta_files(merged, meta)
    remove_local_hf(local_hf)

    # BF16, then Q8_0 and each build, every intermediate deleted once nothing needs it.
    need(ctx, started, NEED_CONVERT_SECONDS, "convert the merged model to GGUF")
    work = os.path.join(ctx.work_dir, "gguf")
    out_dir = os.path.join(ctx.work_dir, "out")
    for folder in (work, out_dir):
        remove(folder)
        os.makedirs(folder)
    bf16 = os.path.join(work, "bf16.gguf")
    ctx.progress(message="Converting the merged model to GGUF")
    began = time.time()
    convert = (
        shlex.quote(convert_python) + " " + shlex.quote(tools["convert"]) + " " + shlex.quote(merged) + " --outtype bf16 --outfile "
        + shlex.quote(bf16) + " --model-name " + shlex.quote("muse-glimmer-30b-" + p["slug"])
    )
    out = ctx.run(convert, timeout=timeout_for(ctx, started), env={"PYTHONDONTWRITEBYTECODE": "1"}, stall_seconds=STALL_SECONDS)
    if out.returncode != 0 or not os.path.isfile(bf16):
        raise RuntimeError("convert_hf_to_gguf.py failed:\n" + last_lines(out))
    metrics["convert_seconds"] = round(time.time() - began, 1)
    remove(merged)

    need(ctx, started, NEED_QUANTIZE_SECONDS, "quantize the files")
    began = time.time()
    reference = os.path.join(work, REFERENCE_LEVEL + ".gguf")
    paths = {level: os.path.join(out_dir, gguf_name(p["slug"], level)) for level in p["levels"]}
    for level, path in [(REFERENCE_LEVEL, reference)] + [(level, paths[level]) for level in p["levels"]]:
        ctx.progress(message="Quantizing to " + level)
        cmd = shlex.quote(tool(tools, "llama-quantize")) + " " + shlex.quote(bf16) + " " + shlex.quote(path) + " " + level
        out = ctx.run(cmd, timeout=timeout_for(ctx, started), env=tools["env"], stall_seconds=STALL_SECONDS)
        if out.returncode != 0 or not os.path.isfile(path):
            raise RuntimeError("llama-quantize failed for " + level + ":\n" + last_lines(out))
    metrics["quantize_seconds"] = round(time.time() - began, 1)
    remove(bf16)

    # The file checks.
    need(ctx, started, NEED_CHECKS_SECONDS, "check the files")
    began = time.time()
    for path in [reference] + [paths[level] for level in p["levels"]]:
        problem = gguf_problem(gguf_meta(ctx, tools, convert_python, path), os.path.basename(path))
        if problem:
            raise RuntimeError(problem)
    text_path = os.path.join(work, "heldout.txt")
    with open(text_path, "w", encoding="utf-8") as f:
        f.write(text)
    kld_base = os.path.join(work, "reference.kld")
    ctx.progress(message="Measuring how close each build is to " + REFERENCE_LEVEL)
    kl_of(ctx, tools, reference, kld_base, started, text_path)
    remove(reference)
    passed = []
    for level in p["levels"]:
        seen = kl_of(ctx, tools, paths[level], kld_base, started)
        key = level_key(level)
        metrics[key + "_kl_mean"] = round(seen["mean"], 6)
        if "p99" in seen:
            metrics[key + "_kl_p99"] = round(seen["p99"], 6)
        if "top" in seen:
            metrics[key + "_top_token_pct"] = round(seen["top"], 3)
        ok = seen["mean"] <= QUANT_KL_MAX[level]
        metrics[key + "_passed"] = "yes" if ok else "no"
        if ok:
            passed.append(level)
        else:
            ctx.log(level + " isn't published: its mean KL divergence from " + REFERENCE_LEVEL + " is " + str(round(seen["mean"], 6)) + ", over its limit of " + str(QUANT_KL_MAX[level]))
    remove(kld_base)

    # Template and channel, on Q4_K_M under the prompt a stock app sends (tuned.jinja for an old adapter).
    tuned_path = os.path.join(out_dir, TUNED_TEMPLATE)
    if tuned:
        with open(tuned_path, "w", encoding="utf-8") as f:
            f.write(tuned_text)
    args = ["--jinja", "-c", str(SERVER_CTX), "-np", str(SERVER_SLOTS), "--no-mmproj", "--no-webui"]
    if tuned:
        args += ["--chat-template-file", tuned_path, "--skip-chat-parsing", "--reasoning", "off"]
    expected = (result.get("expected_prompt") or "") + (FINAL_CHANNEL if tuned else "")
    ctx.progress(message="Checking the template and the answers on " + CHECK_LEVEL)
    with LlamaServer(ctx, tools, paths[CHECK_LEVEL], args, os.path.join(ctx.work_dir, "llama-server.log")) as server:
        problem = template_problem(server, system, evals[0]["prompt"], expected, result.get("bos") or "")
        if problem:
            raise RuntimeError(problem)
        metrics["template_check"] = "passed"
        finals, answers = channel_check(server, system, evals, tuned, job_deadline(ctx, started) - NEED_UPLOAD_SECONDS)
    metrics["channel_final"] = finals
    metrics["channel_total"] = len(evals)
    same, total = agreement(answers, evals)
    metrics["agreement"] = same
    metrics["agreement_total"] = total
    if finals < QUANT_CHANNEL_MIN * len(evals):
        metrics["channel_passed"] = "no"
        raise RuntimeError(
            "The local files keep thinking instead of answering: " + CHECK_LEVEL + " gave a final answer to " + str(finals) + " of "
            + str(len(evals)) + " held-out prompts, under the " + str(int(QUANT_CHANNEL_MIN * 100)) + "% the files need, so nothing is published"
        )
    metrics["channel_passed"] = "yes"
    for level in p["levels"]:
        if level not in passed:
            remove(paths[level])
    if not passed:
        raise RuntimeError("No build passed its closeness check, so nothing is published")
    metrics["checks_seconds"] = round(time.time() - began, 1)
    metrics["published_levels"] = ",".join(passed)
    metrics["checks_passed"] = "yes"

    # The repo's small files, then the upload.
    with open(os.path.join(out_dir, SYSTEM_FILE), "w", encoding="utf-8") as f:
        f.write(system)
    with open(os.path.join(out_dir, PARAMS_FILE), "w", encoding="utf-8") as f:
        f.write(params_file(p["train_channel"]))
    metrics["system"] = role
    metrics["train_channel"] = p["train_channel"]
    metrics["tuned_template"] = "yes" if tuned else "no"
    digests = {}
    if p["publish"]:
        need(ctx, started, NEED_UPLOAD_SECONDS, "upload the files")
        began = time.time()
        sent = upload(ctx, out_dir, adapter_job_id)
        digests = sent.get("sha256") or {}
        metrics["upload_seconds"] = round(time.time() - began, 1)
        metrics["hub_uploaded"] = "yes"
        metrics["hub_repo"] = str(sent.get("repo"))
        metrics["hub_files"] = int(sent.get("files") or 0)
    else:
        metrics["hub_uploaded"] = "no"
        ctx.log("publish is 0 for this job, so the files were checked and nothing was uploaded; they are gone once the GPU shuts down")
    gb = 0.0
    for level in passed:
        key = level_key(level)
        size = os.path.getsize(paths[level])
        metrics[key + "_bytes"] = size
        metrics[key + "_sha256"] = digests.get(os.path.basename(paths[level])) or sha256_of(paths[level])
        gb += size / 1e9
    left_out = [level for level in p["levels"] if level not in passed]
    metrics["summary"] = (
        "Local files of job " + adapter_job_id[:8] + ": " + ", ".join(passed) + " (" + str(round(gb, 2)) + " GB)"
        + (" passed their checks" if p["publish"] else " passed their checks and weren't uploaded (publish 0)")
        + ("; " + ", ".join(left_out) + " left out over its closeness limit" if left_out else "")
        + ". " + CHECK_LEVEL + " answered " + str(finals) + " of " + str(len(evals)) + " held-out prompts in a stock app's prompt."
    )
    return metrics


# ---------------------------------------------------------------------------------------------------------------
# The merge child: runs inside glimmer's venv, with the GPU.


def merge_child_main(config_path):
    with open(config_path) as f:
        cfg = json.load(f)
    # Unsloth patches transformers and peft, so it is imported first, as in glimmer-lora's child.
    from unsloth import FastModel
    import torch
    from peft import PeftModel

    emit("imported")
    result = {"merged": False}
    emit("phase", message="Loading " + cfg["model"] + " and the adapter of job " + cfg["adapter_job_id"])
    model, tokenizer = FastModel.from_pretrained(model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"])
    model = PeftModel.from_pretrained(model, cfg["adapter_dir"], is_trainable=False)
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""
    # The prompt as training rendered it, with training's own template, for the template check to hold llama.cpp's to.
    head = [{"role": "system", "content": cfg["system"]}]
    result["expected_prompt"] = render(tokenizer, head + [{"role": "user", "content": cfg["prompt"]}], True, bos)
    result["bos"] = bos
    result["gpu"] = torch.cuda.get_device_name(0)
    write_result(cfg["result_path"], result)
    # Unsloth's own 16-bit merge: it downloads the 16-bit base and folds the adapter into it tensor by tensor in fp32.
    # Never the 4-bit merge, and never PEFT's merge of the 4-bit model itself, which would bake its rounding in.
    save = getattr(model, "save_pretrained_merged", None)
    if save is None:
        from unsloth.save import patch_saving_functions

        patch_saving_functions(model, vision=True)
        save = model.save_pretrained_merged
    # Unsloth finds the 16-bit base from the config's _name_or_path (see MERGE_BASE): name r30b's BF16 repo, not the
    # nf4 build that was loaded.
    model.config._name_or_path = cfg["merge_base"]
    emit("phase", message="Merging the adapter into the 16-bit base " + cfg["merge_base"])
    save(cfg["merged_dir"], tokenizer, save_method="merged_16bit")
    result["merged"] = True
    write_result(cfg["result_path"], result)


# ---------------------------------------------------------------------------------------------------------------
# Reading a GGUF file's metadata: runs inside the converter's venv, with gguf-py from the pinned source.


def gguf_meta_main(path, gguf_py):
    sys.path.insert(0, gguf_py)
    import gguf

    reader = gguf.GGUFReader(path)

    def text(key):
        field = reader.get_field(key)
        return field.contents() if field is not None else None

    template = text("tokenizer.chat_template")
    out = {
        "architecture": text("general.architecture"),
        "tensors": len(reader.tensors),
        "chat_template_sha256": hashlib.sha256(template.encode("utf-8")).hexdigest() if isinstance(template, str) else None,
    }
    sys.stdout.write("MUSE_GGUF " + json.dumps(out) + "\n")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--merge":
        merge_child_main(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "--gguf-meta":
        gguf_meta_main(sys.argv[2], sys.argv[3])
    else:
        sys.stderr.write("usage: recipe.py --merge config.json | recipe.py --gguf-meta file.gguf gguf-py\n")
        sys.exit(2)
`;

/** The glimmer-quantize recipe: glimmer-lora's helpers, then the merge, the files, their checks and its run(ctx). */
export const QUANT_PY = QUANT_HEAD + glimmerHelpers(GLIMMER_PY) + QUANT_BODY;
