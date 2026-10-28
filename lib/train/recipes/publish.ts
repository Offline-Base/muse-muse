/**
 * The glimmer-publish recipe's Python (docs/TRAINING.md, "Hugging Face Hub"): sends ONE trained glimmer-lora adapter
 * from its region's model cache to the Hugging Face Hub's storage, for an adapter that exists only there (trained before
 * publishing existed, or whose job ran out of time to send it). It is a job like every other, in the adapter's region
 * with that cache mounted, the way glimmer-serve is, on the cheapest GPU there: it never loads the model, builds the
 * venv or touches the GPU, so it is the system python and the standard library only. Never put a dollar sign followed
 * by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * It reuses glimmer-lora's Python as it is (GLIMMER_PY without its docstring and its __main__ block, see
 * glimmerHelpers), for the pinned model and revision and fix_adapter_config, so the adapter_config.json it sends is the
 * one glimmer-lora writes now. run(ctx) checks the adapter in <cache>/models/<adapterJobId>/, and when its
 * adapter_config.json has no "revision" (or no usable base_model_name_or_path) stages it in work_dir: a link to each of
 * its files and a fixed copy of the config, so the cache's own files are never changed. Then ctx.hub_upload(folder,
 * for_job=adapterJobId): the platform's /hub route acts for the adapter job named in this job's params, and commits
 * the upload with the model card once this job reports done.
 */
import { glimmerHelpers } from "@/lib/train/recipes/serve";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";

const PUBLISH_HEAD = String.raw`"""Muse Glimmer publish: one trained glimmer-lora adapter from the model cache to the Hugging Face Hub's storage."""

# glimmer-lora's own Python (lib/train/recipes/glimmer.ts) follows as it is, without its docstring and its __main__
# block, for the pinned model and revision and fix_adapter_config. Its run(ctx) is replaced below; nothing here builds
# the venv, loads the model or uses the GPU.
`;

const PUBLISH_BODY = String.raw`

# ---------------------------------------------------------------------------------------------------------------
# glimmer-publish: everything below is this recipe's own.

import re

JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# The weights as PEFT's save_pretrained writes them. Only safetensors go to the Hub (a .bin adapter is a pickle).
ADAPTER_WEIGHTS = "adapter_model.safetensors"
# Where the staged copy goes, under work_dir.
STAGE_DIR = "publish"


def read_publish_params(params):
    """adapter_job_id: the glimmer-lora job whose adapter goes to the Hub, lowercased."""
    adapter = str(params.get("adapterJobId") or "").strip().lower()
    if not JOB_ID_RE.match(adapter):
        raise ValueError("adapterJobId must be the id of a glimmer-lora job, not " + json.dumps(str(params.get("adapterJobId")))[:60])
    return {"adapter_job_id": adapter}


def publish_problem(adapter_dir, adapter_job_id):
    """Why the folder can't be published (no adapter in this region, a dry run's stand-in, no safetensors weights), or
    None when it can."""
    where = "the adapter of job " + adapter_job_id + " in " + adapter_dir
    try:
        with open(os.path.join(adapter_dir, ADAPTER_CONFIG), encoding="utf-8") as f:
            config = json.load(f)
    except OSError:
        return "There is no adapter in the cache at " + adapter_dir + ": job " + adapter_job_id + " saved none in this region"
    except ValueError:
        return "The " + ADAPTER_CONFIG + " of " + where + " isn't JSON"
    if not isinstance(config, dict):
        return "The " + ADAPTER_CONFIG + " of " + where + " isn't a JSON object"
    if config.get("dry_run"):
        return where + " is a dry run's stand-in, not a trained adapter"
    if not os.path.isfile(os.path.join(adapter_dir, ADAPTER_WEIGHTS)):
        return where + " has no " + ADAPTER_WEIGHTS
    return None


def staged_adapter(ctx, adapter_dir, adapter_job_id):
    """(folder, fixed): the folder to upload and the adapter_config.json keys filled in on the way.

    An adapter whose config already has its revision and base model goes from the cache as it is. One saved before
    glimmer-lora wrote them is taken to have trained at MODEL_REVISION, the commit glimmer-lora pins (one from before
    the pin loaded main, which was that commit on 2026-10-27), and is staged in work_dir: a link to each file in its
    root (ctx.hub_upload sends only those, and follows a link to a file), and a copy of adapter_config.json with
    hub_config_fixes applied. The cache's own files are never changed: a demo may be serving them, and the cache keeps
    every adapter as it was saved.
    """
    config_path = os.path.join(adapter_dir, ADAPTER_CONFIG)
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    if not hub_config_fixes(config, MODEL_REVISION, MODEL):
        return adapter_dir, []
    stage = os.path.join(ctx.work_dir, STAGE_DIR, adapter_job_id)
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    for name in sorted(os.listdir(adapter_dir)):
        path = os.path.join(adapter_dir, name)
        if name != ADAPTER_CONFIG and os.path.isfile(path):
            os.symlink(path, os.path.join(stage, name))
    fixed = fix_adapter_config(config_path, MODEL_REVISION, MODEL, target=os.path.join(stage, ADAPTER_CONFIG))
    return stage, fixed


def run(ctx):
    p = read_publish_params(ctx.params)
    adapter_job_id = p["adapter_job_id"]
    if not ctx.cache_dir or not os.path.isdir(ctx.cache_dir):
        raise RuntimeError(
            "The model cache isn't mounted, so the adapter of job " + adapter_job_id + " can't be read. A publish job runs"
            " in its adapter's region, with that cache mounted"
        )
    adapter_dir = os.path.join(ctx.cache_dir, "models", adapter_job_id)
    problem = publish_problem(adapter_dir, adapter_job_id)
    if problem:
        raise RuntimeError(problem)
    folder, fixed = staged_adapter(ctx, adapter_dir, adapter_job_id)
    ctx.log(
        "Sending the adapter of job " + adapter_job_id + " from " + adapter_dir + " to the Hugging Face Hub"
        + (", with " + " and ".join(fixed) + " filled in on a copy of its " + ADAPTER_CONFIG if fixed else "")
    )
    out = ctx.hub_upload(folder, for_job=adapter_job_id)
    if out.get("skipped"):
        raise RuntimeError("The adapter of job " + adapter_job_id + " wasn't sent to the Hugging Face Hub: " + str(out["skipped"]))
    failed = out.get("failed") or []
    if failed:
        lines = [str(f.get("path")) + ": " + str(f.get("error")) for f in failed[:5]]
        raise RuntimeError(
            str(len(failed)) + " file" + ("" if len(failed) == 1 else "s") + " of the adapter of job " + adapter_job_id
            + " didn't reach the Hugging Face Hub's storage:\n" + "\n".join(lines)
        )
    mb = round(float(out.get("bytes") or 0) / 1e6, 1)
    count = out.get("uploaded")
    return {
        "adapter_job_id": adapter_job_id,
        "hub_uploaded": "yes",
        "hub_repo": out.get("repo"),
        "hub_files": count,
        "adapter_mb": mb,
        "config_fixed": ", ".join(fixed) or "none",
        "summary": (
            "Sent the adapter of job " + adapter_job_id[:8] + " to the Hugging Face Hub's storage for " + str(out.get("repo"))
            + ": " + str(count) + " large file" + ("" if count == 1 else "s") + ", " + str(mb) + " MB in all. The"
            " platform commits them with the model card."
        ),
    }
`;

/** The glimmer-publish recipe: glimmer-lora's helpers, then its own run(ctx). */
export const PUBLISH_PY = PUBLISH_HEAD + glimmerHelpers(GLIMMER_PY) + PUBLISH_BODY;
