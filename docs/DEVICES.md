# Device tests

Can a phone run Muse Glimmer 30B? This branch tests the GGUF files on real phones in the owner's AWS Device Farm and Qualcomm Device Cloud (QDC) accounts, and on the owner's Mac. Per device and file it measures whether the file loads, how much memory it uses, prompt and generation speed per backend, and whether three simple answers come out right. The results decide what the run-locally page's device picker tells phone owners. Today it says phones can't run it (`docs/VIBE_TUNING.md`, the picker's first row).

This is the contract for three builders working in parallel: the kit (with the Mac runner and the results), Device Farm, and QDC. Each part is tested with fakes and fixture output, and the kit also runs for real on this Mac with a 92 MB smoke model. Nothing here calls a cloud while it is being built.

Tags, as in `docs/VIBE_TUNING.md`: **[V]** verified from a source file, a documentation page, a downloaded archive or a run on this Mac; **[I]** inferred, needs a real run; **[R]** reported by a third party.

## What we test and why

- **The question.** A dense 30B model reads every weight for every token, so speed is bounded by memory bandwidth (about 70 to 85 GB/s on a Snapdragon 8 Elite class phone [I]): at best about bandwidth divided by file size, so about 4 tokens a second for a 17 GB file and 8 for a 9 GB one, before any overhead. And the whole file must stay in memory: Android keeps several GB for itself, and its low-memory killer ends processes that use too much.
- **What stands in for our files.** Our tuned files don't exist yet (they need the quantize run and the owner's Hugging Face organization). They have the same shapes as the base model, so public base builds stand in for speed and memory [I]. When tuned files exist, the same runners take a tuned repo instead (`fetchTunedSubjects`).
- **The upper bound.** The kit runs llama.cpp from `adb shell`. A shell process is not an app: Android's low-memory killer treats it differently and an app gets less memory, so a phone result is an upper bound for an app [I].

## The test matrix

| Device | RAM | Files (stand-ins) | Backends | Where |
|---|---|---|---|---|
| Android phone | 12 GB | `bartowski-iq2_xxs` (8.92 GB), as the proof: nothing fits the budget | cpu; gpu and npu on Snapdragon with Android 14 or later | Device Farm: Galaxy S24 Ultra, S25, S25+, S25 Ultra (Snapdragon); Pixel 8 Pro, 9, 10 (CPU only) |
| Android phone | 16 GB | `bartowski-iq2_m` (10.66 GB), then `bartowski-iq2_xxs` | the same | Device Farm: Pixel 9 Pro, 9 Pro XL, 10 Pro, 10 Pro XL (Tensor chips: CPU only); QDC if a target has 16 GB |
| Android phone | 24 GB | `meta-q4_k_m` (16.76 GB), then `bartowski-q3_k_m` (13.96 GB) | the same | QDC if a target has 24 GB (Device Farm lists none) |
| Owner's Mac, M4 Max | 36 GB | `meta-q4_k_m` | gpu (Metal), cpu | This Mac, once about 22 GB of disk is free (13 GB is free today) |
| iPhone | at most 12 GB | none | | Skipped |
| Every device, first | | `smoke-smollm2-135m-q4_0` (92 MB) | all it has | Everywhere, before any large file |

Tuned files, once they exist, follow the same rule: Q3_K_M on 24 GB phones, Q3_K_M as the proof on 16 GB phones, nothing on 12 GB phones, Q4_K_M on this Mac. `bartowski-iq3_xxs` and `bartowski-q4_0` run only when named (`--subjects`): Q4_0 is the layout Adreno and Hexagon run fastest, for a backend comparison.

### How files are picked

`pickSubjects` in `lib/devices/subjects.ts`, a pure function:

1. Round the device's RAM up to the size it is sold with (`marketedRamGiB`: a MemTotal of 11.2 GiB is a 12 GB phone).
2. The budget is a share of that: 70% on Android and Linux, 60% on a Mac. On a Mac, 60% gives exactly the picker's rows in `docs/VIBE_TUNING.md` (24 GB gets Q3_K_M, 32 and 36 GB get Q4_K_M, 48 GB gets Q6_K), so the Mac run checks the picker's own claim. Metal's own limit on this Mac is higher (28,753 MiB of 36 GiB, 78% [V]).
3. A file's run needs its size plus 1.2 GB (KV cache and buffers, the upper end of `docs/VIBE_TUNING.md`'s estimate).
4. Phones get the largest file that fits the budget, then the largest file at most 85% of its size (a real step down, so a failure of the first still leaves an answer). The Mac gets only the largest.
5. When nothing fits, the smallest file still runs once as the proof, if its run fits the phone's whole RAM. Otherwise the phone runs nothing.

Where RAM comes from:

- **Device Farm:** not from ListDevices. Its `memory` field is storage (a 256 GB phone reports 256,000,000,000) and `heapSize` is the Java heap (`devices/devicefarm/fixtures/README.md`). `lib/devices/devicefarm.ts` keeps a table of RAM per model from the makers' spec sheets; a model not in it gets a smoke run first, which reads MemTotal.
- **QDC:** ListTargets has no RAM field [V, SDK source]. A probe job (the smoke subject) on each chipset reads MemTotal and records it in `devices/qdc/targets.json`.
- **The Mac:** `sysctl -n hw.memsize` (38,654,705,664 bytes on this Mac [V]).
- **The kit checks again** on the device: `MM_MIN_RAM_KB` is the file's run need, and the kit stops before copying or loading anything when MemTotal is below it.

### iOS

Skipped, for two reasons. No file fits: iPhones have at most 12 GB of RAM and iOS caps one app well below that [I]. And there is nothing to run: Device Farm's iOS hosts run XCUITest against an app, and a non-jailbroken iPhone can't run a command-line llama.cpp. An iPhone result would need an app of our own, which is out of scope. `pickSubjects` returns nothing for `ios`.

## How a run works

### Everywhere

1. **Smoke first.** Each new device runs the smoke subject on every backend it has, with `KIT_SMOKE`'s short limits: about 5 minutes. It proves the path (copy, check, bench, answers, parsing) before a 17 GB download, and gives the device's MemTotal.
2. **Then the picked files**, one kit run per file, with `KIT_DEFAULTS`.
3. **The kit** (`devices/kit/run.sh`) runs on the device with the model, the llama.cpp build and the prompts already there (or downloads the model itself with `MM_MODEL_URL`), and writes plain text and llama.cpp's own JSONL into one folder (see The kit contract).
4. **The runner** copies that folder back to this Mac, `lib/devices/result.ts` turns it into a `Result`, and the runner writes `devices/results/<cloud>/<device slug>/<subject id>/<UTC stamp>/` with `result.json` and the kit's small files.

### On this Mac

`scripts/devices/local.ts` (kit builder):

1. Downloads the pinned `llama-b11669-bin-macos-arm64.tar.gz` (12 MB) into a cache outside the repo (default `~/.cache/muse-muse-devices`, or `MM_DEVICES_CACHE`) unless it is there, checks its sha256, and extracts only the files `keepLlamaFile` keeps.
2. Gets the model: the smoke subject (92 MB) downloads to the cache; a file over 200 MB only from `--model <path>` (a file already on disk) or with `--download --yes` after checking that free disk is at least the file plus 5 GB. It checks size and sha256 before running.
3. Runs `/bin/sh devices/kit/run.sh` with `kitEnvFor(subject, place, { backends: ["gpu", "cpu"] })`, then parses and writes `devices/results/local/...`, and prints the verdict.

### On AWS Device Farm

Device Farm runs only in us-west-2, and only through the SSO profile `base-test` (account 916979311153). The default IAM user is blocked. The project is `muse-muse-devices` (the runner creates it once if it is missing). The runner calls the `aws` CLI (`aws devicefarm <command> --profile base-test --region us-west-2 --output json`, never `--debug`, which prints signed requests) through an executor that tests replace with a fake.

- **Test type:** `APPIUM_WEB_PYTHON` in a custom environment. It needs no app of our own: ScheduleRun's `appArn` is optional and web tests take none [V, API reference]. The test spec runs our shell commands on an Amazon Linux 2023 host that has adb to the phone. Appium is never started.
- **Uploads:** the test package as `APPIUM_WEB_PYTHON_TEST_PACKAGE` (a `.zip`) and the spec as `APPIUM_WEB_PYTHON_TEST_SPEC` (a `.yml`), each by CreateUpload, an HTTP PUT to the presigned URL it returns, then GetUpload until `SUCCEEDED`.
- **The minimal valid package** (the upload check for Python web packages [V, troubleshooting page]): `requirements.txt` naming pytest 2.8.0 or later, a `tests/` folder with a file named `test_*.py` that `pytest --collect-only` accepts, and a `wheelhouse/` of `-any` wheels that installs exactly `requirements.txt` with `--no-index`. Device Farm's Python 3 instructions leave the wheelhouse out; it is included so the package passes either check. Ours: `tests/test_carrier.py` with one test that does nothing, `requirements.txt` pinning pytest 8.4.2 and its dependencies (iniconfig, packaging, pluggy, pygments), their wheels fetched from PyPI by sha256, and our files under `mm/`:

  ```text
  requirements.txt  tests/test_carrier.py  wheelhouse/*.whl
  mm/host.sh                    the host side, run by the test spec (bash on the host)
  mm/kit/                       devices/kit as it is
  mm/llama-android/             the plain Android build, flat, trimmed by keepLlamaFile
  mm/llama-snapdragon/bin|lib/  the Snapdragon build, trimmed
  mm/plan/<run key>/run.env     MM_PLAN_VERSION=1, MM_RUN=<run key>, MM_SUBJECTS=<id>,<id> (at most 2), MM_TRANSFER_LIMIT=1200 (seconds per copy)
  mm/plan/<run key>/<id>.env    kitEnvLines(kitEnvFor(...)) with the phone's paths
  mm/plan/<run key>/<id>.system the subject's system message, exactly (and <id>.jinja when it has a template)
  ```

  One package serves every run of a batch. Each run's `configuration.environmentVariables` sets `MM_PLAN=<run key>` (at most 32 variables of at most 256 characters each [V]).
- **The test spec:** `version: 0.1`, `android_test_host: amazon_linux_2023`, each phase one command, `bash "$DEVICEFARM_TEST_PACKAGE_PATH/mm/host.sh" <install|pre_test|test|post_test>`, and `artifacts: [$DEVICEFARM_LOG_DIR]`. A non-zero exit in `test` marks the test failed; `post_test` always runs [V].
- **`host.sh`**, for each subject of the run in order:
  1. reads MemTotal with `adb -s "$DEVICEFARM_DEVICE_UDID" shell cat /proc/meminfo`; when it is under the subject's `MM_MIN_RAM_KB`, skips the copy and runs the kit anyway (it records the skip);
  2. checks the phone's free space (`df -kP /data/local/tmp`) for the file plus 1 GiB;
  3. downloads the file on the host with `curl -fL --retry 8 --retry-all-errors -C -`, checks size and sha256 with `sha256sum`, then `adb push`es it to `/data/local/tmp/mm/model/`. When the host lacks the space (its disk size is not documented), it streams instead: `curl -fL <url> | adb exec-in 'cat > <file>'`, one try. Each copy is bounded by `MM_TRANSFER_LIMIT` with coreutils `timeout`;
  4. runs the kit: `adb shell 'cd /data/local/tmp/mm && set -a && . plan/<run>/<id>.env && set +a && sh kit/run.sh'`. The kit ignores SIGHUP, so if the adb session drops, host.sh polls `out/<id>/run.txt` for `finished=` until the kit's own limits plus 5 minutes;
  5. pulls `out/<id>` into `$DEVICEFARM_LOG_DIR/mm/<id>/`, writes `host-<id>.txt` there (key=value: how it was copied, the seconds, whether the host's sha256 matched), and deletes the model on the phone.

  `pre_test` keeps the screen on (`svc power stayon true`), pushes `mm/kit` and both builds, and marks the binaries executable; `post_test` pulls anything left, restores the screen setting and deletes `/data/local/tmp/mm`.
- **Scheduling:** one run per phone, with that phone's 1 or 2 files: `deviceSelectionConfiguration` `{ filters: [{ attribute: "ARN", operator: "IN", values: [<device ARN>] }], maxDevices: 1 }`, `executionConfiguration` `{ jobTimeoutMinutes, videoCapture: false }` (video can reach 1 GB of artifacts), and `billingMethod` `METERED` unless GetAccountSettings shows unmetered Android slots.
- **Results:** poll GetRun every 60 s until `COMPLETED`. Then for each job, ListArtifacts with type `FILE` gives `CUSTOMER_ARTIFACT` (the zip of `$DEVICEFARM_LOG_DIR`) and type `LOG` gives `TESTSPEC_OUTPUT` (the spec's console). Download both by their presigned URLs, unzip, and parse each `mm/<id>/` folder.
- **Limits** [V]: a run has a 150-minute hard limit; `jobTimeoutMinutes` sets the per-device limit (5 at least); 5 phones run at once by default; customer artifacts over 1 GB in all are dropped entirely; runs stay queued for 24 hours at most.

### On Qualcomm Device Cloud

The phones are Qualcomm reference designs (QRD, MTP), cleaned after every job [V, FAQ]. llama.cpp's CI runs on SM8850 (Snapdragon 8 Elite Gen 5), SM8750 (8 Elite) and SM8650 (8 Gen 3) [R]; those are the chipsets we ask for. Each runs all three backends.

- **The SDK:** `qualcomm_device_cloud_sdk` 0.2.3, the wheel inside Qualcomm's zip (both pinned in `QDC_SDK`), in a uv venv with Python 3.12 outside the repo. It needs requests, httpx under 0.28, attrs and python-dateutil [V, wheel metadata]. Every call goes to `https://apigwx-aws.qualcomm.com/saga/v1/public/qdc` with the key in the `Authorization` header and `X-QCOM-TokenType: apikey` [V, SDK source]. In 0.2.3, a call that answers other than 200 raises (its `try_call`), although the docstrings say None.
- **The split:** `scripts/devices/qdc.ts` plans and builds the zips with `lib/devices/subjects.ts` and parses results with `lib/devices/result.ts`. `devices/qdc/submit.py` only talks to QDC: list targets, upload a zip, submit, poll, download the logs into a folder. The key never passes through TypeScript.
- **A job:** `submit_job`, called with keyword arguments (the docs' signature has a `wait_for_cookie_file` argument the 0.2.3 wheel lacks [V]), with `TestFramework.APPIUM`, `JobType.AUTOMATED`, `JobMode.APPLICATION`, the timeout in minutes, `job_artifacts=[<zip id>]` (uploaded with `upload_file_v2` as `ArtifactType.TESTSCRIPT`, no APK, as llama.cpp's CI does), `job_parameters=[WIFIENABLED, SCREENALWAYSON]`, a name under 32 characters (`mm <chipset> <stamp>`), and `external_job_id` the run key. One job per chipset and file, since a 17 GB download on the phone can take most of an hour.
- **The zip**, which QDC extracts under `/qdc/appium/` on a host with adb to the phone, installs `requirements.txt` and runs pytest [V for the package rules, QDC docs; the path from llama.cpp's CI]:

  ```text
  requirements.txt  pytest.ini (addopts = --junitxml=results.xml -s)
  tests/conftest.py     an Appium session for the job's length, as llama.cpp's CI keeps one (UiAutomator2, 127.0.0.1:4723/wd/hub)
  tests/test_mm.py      one test: runs mm_carrier.main() and fails only when the kit couldn't run
  tests/mm_carrier.py   the carrier: adb push, run the kit, collect
  mm/kit/  mm/llama-android/  mm/llama-snapdragon/  mm/plan/run.env  mm/plan/<id>.env  mm/plan/<id>.system
  ```

- **The carrier:** pushes `/qdc/appium/mm` to `/data/local/tmp/mm`, marks the binaries executable, and runs the kit for the job's file with `MM_MODEL_URL` set, so the phone downloads the model with its own curl (llama.cpp's CI does the same with `curl -L` [R]). Then it copies every file of `out/<id>/` to `/data/local/tmp/QDC_logs/` as `mm__<id>__<file>.log`, flat, because QDC collects that folder [R, llama.cpp's CI] and it is unknown whether it keeps subfolders or other extensions. It deletes the model.
- **Results:** poll `get_job_status` every 30 s until `Completed` or `Canceled`, then `get_job_log_upload_status` until `Completed`, `Failed` or `NoLogs`, then `get_job_log_files` and `download_job_log_files_v2` per file. Some come back zipped and some raw [R, llama.cpp's CI]. Files named `mm__<id>__*.log` are put back as `out/<id>/*` (the prefix and the added `.log` removed) and parsed.
- **The probe:** before the first real job on a chipset, a smoke job records its MemTotal, model, Android version and SoC in `devices/qdc/targets.json`, which `plan` reads for `pickSubjects`.
- **Targets:** ListTargets gives `target_id`, `chipset_name`, `chipset_marketing_name`, `chipset_platform_name`, `chipset_category` (Mobile, Compute, IOT, Automotive), `os`, `os_version` and `state` (AvailableNow, DevicesBusy, Unavailable) [V, SDK models]. Only Mobile targets with Android are used.

## The kit contract

`devices/kit/run.sh` is one POSIX sh script. It runs under Android's mksh with toybox, under dash and bash on Linux, and under macOS's `/bin/sh` and `/bin/dash`. Runners copy `devices/kit/` (the script and `prompts/`) next to the llama.cpp builds and the model, and run it.

### Inputs

Environment variables only, built by `kitEnvFor` and written by `kitEnvLines` (lib/devices/subjects.ts). Values never hold spaces or quotes (`isSafeKitValue`); lists are comma-separated.

| Variable | Needed | What | Default |
|---|---|---|---|
| `MM_OUT` | yes | The run's output folder. The kit creates it; it must not exist or be empty. | |
| `MM_SUBJECT` | yes | The subject id, recorded in run.txt. | |
| `MM_MODEL` | yes | The GGUF file on this device. | |
| `MM_MODEL_BYTES`, `MM_MODEL_SHA256` | yes | Its exact size and lowercase sha256. | |
| `MM_MODEL_URL` | no | When set and `MM_MODEL` is missing, the kit downloads it with curl. A public URL; never a token. | |
| `MM_MIN_RAM_KB` | no | The file's run need. When MemTotal is lower, the kit stops before the download and the check. | |
| `MM_SYSTEM_FILE` | yes | The system message, exactly. | |
| `MM_TEMPLATE_FILE` | no | A chat template file, passed with `--chat-template-file` (old tuned adapters' tuned.jinja). | |
| `MM_PROMPTS` | no | Prompt ids; each is `<kit folder>/prompts/<id>.txt`. | `capital,sum,color` |
| `MM_BACKENDS` | yes | Among `cpu`, `gpu`, `npu`, in bench order. | |
| `MM_LLAMA_CPU`, `MM_LLAMA_GPU`, `MM_LLAMA_NPU` | per backend | The build folder for each backend, flat or with `bin/` and `lib/` (the kit looks for `bin/llama-bench`). | |
| `MM_NPU_SESSIONS` | no | Hexagon sessions (`npuSessions`): `GGML_HEXAGON_DEVICES` and HTP0 to HTP<n-1>. | 1 |
| `MM_THREADS` | no | llama.cpp's `-t`. | llama.cpp's own |
| `MM_CTX` | no | `-c` for answers. | 4096 |
| `MM_BENCH_PROMPT`, `MM_BENCH_GEN`, `MM_BENCH_REPS` | no | llama-bench `-p`, `-n`, `-r`. | 128, 16, 2 |
| `MM_ANSWER_TOKENS` | no | `-n` for answers. | 192 |
| `MM_SAMPLE_SECONDS` | no | Seconds between memory samples. | 2 |
| `MM_LIMIT_FETCH`, `MM_LIMIT_CHECK`, `MM_LIMIT_BENCH`, `MM_LIMIT_ANSWER`, `MM_LIMIT_TOTAL` | no | Seconds: the download, the check, one bench, one answer, and everything after the download. | 3600, 600, 900, 420, 2400 |

The defaults are `KIT_DEFAULTS` in `lib/devices/types.ts`; `KIT_SMOKE` shortens them for smoke runs.

### What it does, in order

1. **Start.** `trap '' HUP`, so a dropped adb session doesn't stop it. Unset `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `QDC_API_KEY` and the `AWS_*` credentials (llama-bench reads `HF_TOKEN` [V]). Check the needed variables; on a problem, print one line and exit 2 without writing anything. Create `MM_OUT` and write run.txt's first lines.
2. **Device facts** into device.txt.
3. **RAM.** When `MM_MIN_RAM_KB` is set and the device's RAM in kB is below it: status `skipped`, exit 0.
4. **Download**, only when `MM_MODEL` is missing and `MM_MODEL_URL` is set: free space for the file plus 1 GiB (`df -kP`), then `curl -fL --retry 5 --retry-delay 10 -C - -o "$MM_MODEL.part"` under `MM_LIMIT_FETCH`, then rename. No curl, no space or a failed download: status `failed`, exit 3.
5. **Check:** the size (`stat -c %s` on Android and Linux, `stat -f %z` on macOS, `wc -c` when that fails; toybox's `stat -f` means something else [V]), then the sha256 (the first of `sha256sum`, `toybox sha256sum`, `shasum -a 256`, `openssl dgst -sha256`) under `MM_LIMIT_CHECK`. A missing file or a wrong size or sha256: status `failed`, every later step skipped with `why=model`, exit 3. No tool: `check=no_tool`, and the run goes on (the runner notes whether its host checked the file).
6. **Benches**, each backend in `MM_BACKENDS` order:
   - no build folder or no llama-bench in it: skipped, `why=nobuild`;
   - gpu or npu on Android below API 34 (the Snapdragon build targets Android 14 [V]): skipped, `why=android_sdk`;
   - gpu or npu: `llama-bench --list-devices` with the step's environment (60 s at most) into `list-<backend>.txt`. Every device name must appear as a line `  <name>: ...`; otherwise skipped, `why=unavailable`;
   - run llama-bench (see Backends) under the watchdog and the memory sampler, with the limit `MM_LIMIT_BENCH` or what is left of `MM_LIMIT_TOTAL`, whichever is less.
7. **Answers.** Rank the backends by their bench's generation speed (the `avg_ts` of the JSONL line with `"n_gen"` above 0), fastest first. A backend with no such line gets none (`why=noload`). For each ranked backend and each prompt, run llama-completion under the watchdog and the sampler, with the limit `MM_LIMIT_ANSWER` or what is left, whichever is less.

   Before every bench and answer: with under 30 s of `MM_LIMIT_TOTAL` left, that step and every later one is skipped with `why=time`, and the status is `cut`.
8. **Finish:** run.txt `finished=`, `seconds=`, `status=done` (or `cut`), exit 0. A failed step is data, not a kit failure.

**The watchdog**, for every step: start the tool in the background with its stdin from `/dev/null`, keep its pid, and start `( sleep <limit>; touch <marker>; kill -TERM <pid>; sleep 10; kill -KILL <pid> ) >/dev/null 2>&1 &`, where the marker is `<MM_OUT>/.timeout-<step>`. Then `wait <pid>`, kill the watchdog, and delete the marker once the step's end is recorded. The redirection matters: a background `sleep` holding the adb pipe would keep `adb shell` from returning.

**The memory sampler**, for every bench and answer step: one sample with `t=0` just before the tool starts, then `while kill -0 <pid>; do <one sample>; sleep $MM_SAMPLE_SECONDS; done` into `mem-<step>.txt`, killed after the step.

**How a step ended** (`end=` and `why=` in steps.txt):

| Exit | end | why |
|---|---|---|
| 0 | `ok` | |
| the watchdog's marker exists and the exit isn't 0 | `timeout` | `limit` |
| 137 (SIGKILL) without the marker | `killed` | `lmk` when `logcat -d -b main,system,events` has a lowmemorykiller, lmkd or killinfo line naming the pid (kept in `lmk-<step>.txt`); else `signal9` |
| above 128 otherwise | `crashed` | `signal<N>`, N = exit minus 128 (SIGSEGV 11, SIGBUS 7, SIGABRT 6) |
| 1 to 128 | `error` | (the log has the message) |

### Backends

| Backend | Android | macOS | Environment |
|---|---|---|---|
| `cpu` | plain build: `-dev none -ngl 0` | `-dev none -ngl 0` | Android: `LD_LIBRARY_PATH=<lib>` |
| `gpu` | Snapdragon build: `-dev GPUOpenCL -ngl 99` | `-dev MTL0 -ngl 99` | Android: `LD_LIBRARY_PATH=<lib> ADSP_LIBRARY_PATH=<lib>` |
| `npu` | Snapdragon build: llama-bench `-dev HTP0/HTP1/...`, llama-completion `-dev HTP0,HTP1,...`, `-ngl 99 -ub 1024` | none | as gpu, plus `GGML_HEXAGON_DEVICES=<MM_NPU_SESSIONS>` |

- `<lib>` is the build folder (flat) or its `lib/`. Neither Android build sets a library path in its binaries, so `LD_LIBRARY_PATH` is needed [V, `objdump -p` and llama.cpp's `docs/android.md`]. The macOS build finds its libraries by `@loader_path` [V].
- llama-bench separates several devices with `/` (a comma starts another test); llama-completion takes commas [V, source].
- Without `GGML_HEXAGON_DEVICES` the NPU backend opens one session, HTP0, which maps about 3.1 GiB of weights at a time; larger files are remapped during every graph. `npuSessions` gives one session per 3 GB, at most 16. The backend forces one session on v73 chips (8 Gen 2) [V, source]. `GGML_HEXAGON_EXPERIMENTAL` is not read by b11669 [V]; `-ub 1024` follows llama.cpp's own Snapdragon runner.
- **llama-bench**, every backend: `-m "$MM_MODEL" -p $MM_BENCH_PROMPT -n $MM_BENCH_GEN -r $MM_BENCH_REPS -o jsonl -v`, plus the backend's flags and `-t` when set. `jsonl` prints one line per test as it finishes [V], so a kill keeps the tests already done. Flash attention stays on llama.cpp's `auto`.
- **llama-completion**, every answer: `-m "$MM_MODEL" --jinja -st -sysf "$MM_SYSTEM_FILE" -f <prompt file> -n $MM_ANSWER_TOKENS --temp 0 --seed 42 --no-display-prompt --simple-io --perf -sp -c $MM_CTX -fit off`, plus the backend's flags, `-t` when set and `--chat-template-file` when `MM_TEMPLATE_FILE` is set. `--jinja` is off by default in llama-completion and `--perf` too [V, b11669 README]; `-sp` prints the control tokens, so the parser can find the final channel; `-fit off` keeps llama.cpp from changing settings to fit memory, so a file that doesn't fit fails visibly.
- On this Mac with the smoke model [V]: llama-bench printed one JSONL line per test (CPU: pp64 2,897 t/s and tg16 682 t/s; Metal: pp64 6,978 t/s), and llama-completion printed `17 + 25 = 42.<|im_end|> [end of text]` with its timings on stderr (`prompt eval time = 12.97 ms / 45 tokens (... 3468.48 tokens per second)`, `eval time = 29.53 ms / 11 runs (... 372.53 tokens per second)`). A cut answer has no `[end of text]`.

### The output folder

Everything is UTF-8 text with `\n` line ends. "key=value lines" means one `key=value` per line, the key `[a-z0-9_]+`, the value the rest of the line with carriage returns and newlines turned into spaces. The kit writes no JSON of its own.

```text
<MM_OUT>/
  kit.log                          the kit's own progress lines, also printed to stdout
  run.txt                          key=value lines: kit (KIT_VERSION), subject, platform, backends, prompts, ctx, bench_prompt,
                                   bench_gen, bench_reps, answer_tokens, npu_sessions, threads, limit_fetch, limit_check,
                                   limit_bench, limit_answer, limit_total, started (epoch s), finished, seconds,
                                   status (done|cut|skipped|failed), why (when not done: ram|disk|no_curl|fetch|model)
  device.txt                       key=value lines (below)
  model.txt                        key=value lines: path, bytes_expected, bytes, sha256_expected, sha256,
                                   check (ok|size|sha256|missing|no_tool|skipped), tool, seconds, fetched (0|1), fetch_seconds
  steps.txt                        one line per step, space-separated codes:
                                   name=<fetch|check|list|bench|answer> backend=<cpu|gpu|npu|-> prompt=<id|-> start=<epoch s>
                                   seconds=<n> limit=<n> rc=<n|-> end=<ok|error|timeout|killed|crashed|skipped> why=<code|->
  list-<backend>.txt               llama-bench --list-devices (gpu and npu)
  bench-<backend>.jsonl            llama-bench's stdout
  bench-<backend>.log              its stderr without the lines that start with create_tensor, llama_graph_n_input_tensors
                                   or ggml_metal_library_compile, capped
  answer-<backend>-<prompt>.txt    llama-completion's stdout, capped at 64 KiB
  answer-<backend>-<prompt>.log    its stderr, capped
  mem-<step>.txt                   one sample per line, space-separated: t=<s since the step began> and what the platform has:
                                   Android and Linux avail_kb free_kb cached_kb swap_free_kb (/proc/meminfo) rss_kb hwm_kb anon_kb
                                   file_kb (/proc/<pid>/status) temp_mc (the hottest /sys/class/thermal zone);
                                   macOS rss_kb (ps -o rss=) level (kern.memorystatus_level)
  thermal-<step>.txt               Android: key=value lines before= and after= (dumpsys thermalservice's status, 0 to 6)
  lmk-<step>.txt                   Android, after a kill: the matching logcat lines
```

`<step>` is `bench-<backend>` or `answer-<backend>-<prompt>`. "Capped" means a file over 256 KiB keeps its first 192 KiB and its last 64 KiB with a line `[... cut by the kit ...]` between (`head -c`, `tail -c`); answers keep 48 KiB and 16 KiB.

device.txt keys:

- **every platform:** `platform` (android, macos or linux), `kernel` (`uname -r`), `arch` (`uname -m`), `ram_kb`, `cores`, `disk_free_kb` (the model's folder);
- **Android** (getprop): `manufacturer` (ro.product.manufacturer), `model`, `brand`, `device`, `android` (ro.build.version.release), `sdk`, `soc_manufacturer`, `soc_model`, `board` (ro.board.platform), `hardware`, `abi`, plus `cpuset` (/proc/self/cpuset), `thermal_status` and `battery_temp_dc` (dumpsys battery, tenths of a degree);
- **macOS:** `hw_model` (hw.model), `macos` (sw_vers -productVersion), `chip` (machdep.cpu.brand_string), `perf_cores` (hw.perflevel0.physicalcpu), `memorystatus_level`;
- **Linux:** `os_release` (PRETTY_NAME), `cpu` (the first "model name").

No serial number, IMEI, UDID or environment dump is ever written.

### Rules for run.sh

- POSIX sh. No `[[ ]]`, arrays, `function`, `source`, `echo -e` or `echo -n` (use `printf`), process substitution, `pipefail` or `$RANDOM`. `local` is allowed (mksh, dash and bash all have it).
- **mksh's arithmetic is signed 32-bit** [V, mksh(1)]. Do arithmetic only in seconds and kB (17 GB is 16.6 million kB); compare byte sizes as strings.
- Tools: `cat cp mv rm mkdir ls touch date sleep kill env grep sed cut tr head tail sort wc uname df stat ps`, plus `getprop logcat dumpsys` on Android, `sysctl sw_vers` on macOS, one sha256 tool and, for the download only, `curl`. Never `awk`, `seq`, `timeout`, `time`, `readlink -f`, `xargs`, `jq`, `bc` or a scripting language: they are missing or differ on some phones [I].
- Platform: `getprop` on PATH means Android; `uname -s` = Darwin means macOS; anything else is Linux.
- Exit codes: 0 when it ran (see run.txt), 2 for bad inputs (nothing written), 3 when the model is missing or wrong.

## Results and the verdict

### result.json

`Result` in `lib/devices/types.ts`, schema 1: the device's facts, the subject, the llama.cpp build, the times, the status, the model check, one `BackendRun` per backend, one `Completion` per answer, the verdict and notes. It sits next to the kit's files in `devices/results/<cloud>/<device slug>/<subject id>/<UTC stamp>/` (`resultDir`, `deviceSlug`, `utcStamp`). Models and builds are never committed: `devices/.gitignore` keeps out `*.gguf`, `*.part`, `*.tar.gz`, `*.zip` and `*.whl`.

### Parsing rules (lib/devices/result.ts)

- **Speeds:** the bench JSONL line with `n_prompt` above 0 and `n_gen` 0 gives `promptTps` (its `avg_ts`); the line with `n_gen` above 0 and `n_prompt` 0 gives `genTps`. `loaded` is true when the file has any line.
- **Answers' speeds** from the `.log`: `prompt eval time = <ms> ms / <n> tokens (... <t> tokens per second)`, `eval time = <ms> ms / <n> runs (... <t> tokens per second)` (not the prompt line) and `load time = <ms> ms`. The lines carry a log prefix (`0.00.739.738 I common_perf_print:`), so match anywhere in the line.
- **Memory:** `peakRssBytes` is the largest `hwm_kb` (Android, Linux) or `rss_kb` (macOS) times 1024; `minAvailableBytes` the smallest `avail_kb` times 1024; `availDropBytes` the `t=0` sample's `avail_kb` minus the smallest, times 1024 (GPU and NPU drivers' memory shows here, not in RSS [I]); `maxTempC` the largest plausible `temp_mc` (above 0 and under 150,000) divided by 1000. From the bench log: `offloaded N/M layers` and every `<name> model|KV|compute buffer size = <x> MiB`.
- **The final answer:** take the raw stdout. If it has `to=user<|message|>`, keep what follows the last one; otherwise, if it has `<|message|>` but no `to=user`, the model never answered (an empty answer); otherwise keep it all. Cut at the first `<|eot|>`, `<|eom|>`, `<|end_of_text|>`, `<|im_end|>`, `<|start|>` or `[end of text]`, drop any other `<|...|>`, and trim. `finished` is true when the raw output has `[end of text]`. `right` is the prompt's `expect` pattern on the answer.
- **Errors:** the first line of the step's log, or of its stdout, matching `error|failed|unable|GGML_ASSERT|out of memory|cannot|not found`, at most 300 characters.
- **Device facts:** device.txt, plus what the runner passes (the cloud, `cloudId`, a display name); `marketedRamGiB` from `ram_kb`.

### The verdict

`verdictFor` in result.ts, in this order:

1. **failed** when the model download or check failed. A run skipped for RAM is **unusable**: "the phone has X GB of RAM and the file's run needs Y GB".
2. **failed** when no backend loaded: "it didn't load on any backend", with the first error.
3. A backend **counts** when it has a generation speed, at least 2 of its answers are right (`ANSWERS_NEEDED`), and none of its steps was killed. Every backend that doesn't count gets one reason ("gpu: 0 of 3 answers right", "cpu: killed by the low-memory killer", "npu: answers not asked, out of time").
4. No backend counts: **unusable**.
5. The fastest counting backend decides: at least 4 generated tokens a second (`USABLE_GEN_TPS`) is **usable**, from 1 (`SLOW_GEN_TPS`) is **slow**, below 1 is **unusable**.

When the deciding backend's prompt speed is under 10 tokens a second, a note says a 500-token prompt takes over 50 s. The rating doesn't change.

Why these numbers: 4 tokens a second is about 3 words a second, close to reading speed, so a 150-token answer takes under 40 s. From 1, a short answer still arrives in a minute or two, which works for a question but not a chat. Below 1, every answer takes minutes. A fast backend with wrong answers is no use, so answers gate the speed; one miss of three is allowed because a 2-bit file can slip on one prompt, and the report shows which. A kill is the phone saying no, whatever the speed was before it.

### From the verdict to the picker

- **usable:** "Runs", with the measured speed.
- **slow:** "Runs slowly".
- **unusable or failed:** "Won't run here: use Try it live".

A phone tier (12, 16 or 24 GB) changes in the picker only when its best file is usable or slow on every phone tested in that tier. Since an app gets less memory than an adb process, the owner decides how much margin to leave; the report gives one line per tier with the evidence. Smoke results only show that the path works, so the report leaves them out of the tier lines.

## Costs and caps

- **Device Farm:** metered at $0.17 a device minute; a one-time trial of 1,000 minutes; unmetered slots at $250 a month [V, pricing page, Oct 28]. The owner's account has no unmetered slots and 620.25 trial minutes left (devices/devicefarm/fixtures/README.md). Runs and jobs report `deviceMinutes` (total, metered, unmetered).
  - **Caps:** `--max-devices` (default 3, never above 5, the default concurrency); at most 2 files per run (a phone with more gets more runs); each run's `jobTimeoutMinutes` = 5 + for each of its files (`MM_TRANSFER_LIMIT` + `limitCheck` + `limitTotal`) in minutes, 145 for two files with the defaults, never above 150; and `--max-usd` (default 60), which refuses a plan whose worst case (every run's `jobTimeoutMinutes` times $0.17) costs more.
  - **The estimate** prints, per phone and in all: the expected minutes (3 to start, the copy at 25 MB/s, the check at 250 MB/s, 8 minutes per backend) and the worst case (`jobTimeoutMinutes`), each in dollars, and the trial minutes left. Expected [I]: a smoke run about 5 minutes ($0.85); a 16 GB Pixel with IQ2_M and IQ2_XXS about 35 minutes ($6); a 12 GB Galaxy with the proof file on three backends about 35 minutes ($6).
- **QDC:** free, with minutes provisioned per user or organization, counted only once a job's test starts (waiting and device setup don't count) [V, FAQ]. Caps: `--max-jobs` (default 3), each job's timeout = 15 + (`limitFetch` + `limitCheck` + `limitTotal`) in minutes, at most 150. The estimate prints the expected and worst-case minutes.
- **The Mac:** free. A download over 200 MB needs `--download --yes` and free disk of the file plus 5 GB.
- **Nothing is scheduled without `--yes`.** Without it, every runner prints the plan, the estimate and the exact command to run, and exits 0.

## Secrets

- **AWS:** the runner calls the `aws` CLI with `--profile base-test --region us-west-2` and never reads, prints or stores a credential. Presigned URLs (CreateUpload's, ListArtifacts') are credentials while they last: never logged, stored or written to a result, and anything saved from Device Farm's own output has every URL with `X-Amz-Signature` or `X-Amz-Credential` removed.
- **QDC:** `devices/qdc/submit.py` reads `QDC_API_KEY` from `~/.config/qdc/api.env` itself (and refuses a file anyone but the owner can read), sends it only in the SDK's header, and replaces it with `[QDC key]` in any error it prints.
- **Hugging Face:** every download is public and needs no token. No runner passes `HF_TOKEN` anywhere, and the kit unsets it.
- **The device never gets a token.** No secret goes into a package, a zip, a plan, a log, a result or a commit. Tests check the built package and zip for the test values of each secret.

## What the owner does once

1. `aws sso login --profile base-test` before a Device Farm run (the session expires; the runner says so and stops).
2. In QDC: Users, Settings, API Keys, make a key. Save it:

   ```sh
   mkdir -p ~/.config/qdc && chmod 700 ~/.config/qdc
   printf 'QDC_API_KEY=%s\n' '<the key>' > ~/.config/qdc/api.env && chmod 600 ~/.config/qdc/api.env
   ```

3. For this Mac's Q4_K_M run: free about 22 GB of disk.
4. For tuned files: the quantize run and the Hugging Face organization (`docs/VIBE_TUNING.md` build order steps 0 and 1).

## Who builds what

Three builders work at the same time in this worktree. Each edits only its own files. Tests run with `npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/*.test.ts` and `npx tsc --noEmit` must pass.

### Shared files

`docs/DEVICES.md`, `lib/devices/types.ts` and `lib/devices/subjects.ts` belong to no builder. Change them only with small edits in a block of your own, never a rewrite. In this file, each builder fills only its own "How to run" heading; the kit builder also fills "Reading results".

### The kit

`devices/kit/**` (run.sh, `prompts/capital.txt`, `prompts/sum.txt`, `prompts/color.txt` holding `FIXED_PROMPTS`' texts with no trailing newline), `devices/.gitignore`, `lib/devices/result.ts`, `lib/devices/report.ts`, `scripts/devices/local.ts`, `scripts/devices/report.ts`, and their tests under `lib/devices/__tests__/` (kit, result, report, local) with fixtures in `lib/devices/__tests__/fixtures/`. The results format and `devices/results/local/`.

Tests: run.sh under `/bin/sh` and `/bin/dash` with fake `llama-bench` and `llama-completion` scripts (canned output, a slow one for the watchdog, one that is killed, one that crashes, a wrong sha256, no curl, a RAM skip, the total limit) checking the layout above line by line; the prompt files equal `FIXED_PROMPTS`; the parser on those outputs and on fixtures for an Android run with three backends, a low-memory kill and Glimmer's channel output; the verdict at its edges; then a real smoke run on this Mac, skipped when the cached build or model is missing.

### Device Farm

`lib/devices/devicefarm.ts` (the RAM table by model, choosing phones per tier, the plan, the package's file list, `schedule-run` arguments, the estimate and caps, reading run, job and artifact JSON, all pure, with the `aws` executable injected), `scripts/devices/devicefarm.ts` (`plan`, `run --yes`, `fetch <run ARN>`, `stop <run ARN>`), `devices/devicefarm/**` (`host.sh`, `testspec.yml`, the carrier in `carrier/requirements.txt` and `carrier/tests/test_carrier.py`, the existing `fixtures/`), and their tests (`lib/devices/__tests__/devicefarm*.test.ts`; host.sh under bash with fake `adb`, `curl` and `sha256sum` on PATH). `devices/results/devicefarm/`.

### QDC

`devices/qdc/**` (`submit.py`; the carrier in `carrier/requirements.txt`, `carrier/pytest.ini`, `carrier/tests/test_mm.py`, `carrier/tests/conftest.py` and `carrier/tests/mm_carrier.py`, which become the zip's root; `submit-requirements.txt` pinned with hashes; `targets.json`), `lib/devices/qdc.ts` and `scripts/devices/qdc.ts` (`targets`, `probe --chipset <name>`, `plan`, `run --yes`, `fetch <job id>`), and their tests: TypeScript tests for the plan and the zip, and Python tests run from a TypeScript test with `python3.12 -I`, against a fake SDK package on `PYTHONPATH` and a fake `adb` on PATH. `devices/results/qdc/`.

### Interfaces between the parts

The cloud builders call the kit builder's functions with exactly these signatures (and may stub them in tests until they land):

```ts
// lib/devices/result.ts
export interface KitContext {
  cloud: Cloud;
  runId: string;
  stamp: string;
  subject: Subject;
  /** What the runner knows: name, cloudId, or the planned RAM when device.txt lacks it. */
  device?: Partial<DeviceFacts>;
  notes?: string[];
}
/** Reads a kit output folder. Throws only when run.txt is missing or its kit= isn't KIT_VERSION. */
export function parseKitOutput(dir: string, context: KitContext): Result;
export function verdictFor(result: Omit<Result, "verdict">): Verdict;
export function finalAnswer(raw: string): { answer: string; finished: boolean };
/** Copies every file of the kit's folder (the kit already capped them) and writes result.json into resultDir(...) under repoRoot; returns that folder. */
export function writeResult(repoRoot: string, result: Result, kitOutDir: string): string;

// lib/devices/report.ts
export function reportRows(results: Result[]): ReportRow[];
export function reportMarkdown(rows: ReportRow[]): string;
```

From the shared files: `pickSubjects`, `kitEnvFor`, `kitEnvLines`, `isSafeKitValue`, `keepLlamaFile`, `npuSessions`, `subjectUrl`, `repoFileUrl`, `fetchTunedSubjects`, `deviceSlug`, `resultDir`, `utcStamp`, `marketedRamGiB`, `LLAMA_ASSETS`, `llamaAsset`, `STAND_INS`, `SMOKE`, `KNOWN_SUBJECTS`, `subjectById`, `FIXED_PROMPTS`, `DEFAULT_SYSTEM`, `QDC_SDK`, `KIT_DEFAULTS`, `KIT_SMOKE`.

Device paths on Android, for both clouds: `/data/local/tmp/mm/` holding `kit/`, `llama-android/`, `llama-snapdragon/`, `plan/`, `model/<file>`, `out/<subject id>/`.

## Facts this design rests on

| Fact | Tag | Source |
|---|---|---|
| Both Android archives match their pinned sha256. The plain one is flat: llama-bench, llama-completion, libllama, libllama-common, libggml, libggml-base, libggml-rpc and seven CPU variants (armv8.0 to armv9.2), built for API 28 with GGML_BACKEND_DL. The Snapdragon one has bin/ and lib/ with libggml-cpu, libggml-opencl, libggml-hexagon and libggml-htp-v73, v75, v79 and v81, built for API 34 with `-march=armv8.7a+fp16+dotprod+i8mm`. | V | downloads and listings in the scratchpad; `.github/workflows/release.yml`, `docs/backend/snapdragon/CMakeUserPresets.json` in the b11669 source |
| No Android binary has a RUNPATH; llama.cpp's own docs say to set LD_LIBRARY_PATH. Its Snapdragon runner sets `LD_LIBRARY_PATH` and `ADSP_LIBRARY_PATH` to the lib folder. | V | `objdump -p`; `docs/android.md`; `scripts/snapdragon/run.py` |
| Device names: `GPUOpenCL`, `HTP0` and up, `MTL0`; `none` keeps everything on the CPU. | V | ggml-opencl.cpp, ggml-hexagon.cpp, `--list-devices` on this Mac |
| The Hexagon backend's matrix products take Q4_0, Q4_1, Q8_0, IQ4_NL, MXFP4, Q2_K to Q6_K and F16, not IQ2 or IQ3; OpenCL's take Q4_0, Q4_1, Q5_0, Q5_1, MXFP4, IQ4_NL, Q4_K, Q5_K and Q6_K (the vocabulary-sized K-quant weight falls back to the CPU on A7x GPUs). Meta's Q4_K_M has only Q4_K, Q5_K, Q6_K and F32 tensors. | V | the b11669 source; Meta's GGUF header (first 24 MB, by range request) |
| Glimmer's GGUF names `<\|end_of_text\|>` as EOS and `<\|eot\|>` as EOT, and no EOM, so a reasoning message's `<\|eom\|>` doesn't end the turn. Meta's template adds "Reasoning strength: high." unless the system message has a reasoning line, and uses "You are a helpful AI assistant." when there is no system message. | V | the GGUF header; `meta_chat_template.jinja` from the vibe research |
| The Android builds have HTTPS (BoringSSL), but look for CA certificates only in `/etc/ssl` and similar paths, which Android doesn't have, so `-hf` and `-mu` downloads on a phone would need `SSL_CERT_FILE` pointed at a bundle. The kit doesn't use them. | V (compiled in), I (fails on a phone) | `release.yml`; strings in libllama-common.so; cpp-httplib's `load_system_certs` |
| llama-bench and llama-completion flags and output, as used above. | V | b11669 `tools/llama-bench/llama-bench.cpp`, `common/arg.cpp`, the READMEs; runs on this Mac |
| Device Farm: custom test environments, test spec phases, the Android hosts and their software, the environment variables, the 150-minute limit, 5 devices at once, the 1 GB artifact cap, ListDevices' filters (no RAM), the artifact types, $0.17 a device minute. | V | the Device Farm developer guide and API reference pages named above, Oct 28 |
| Device Farm's `memory` is storage, and the account has no unmetered slots and 620.25 trial minutes. | V (read in the fixture), not checked by this designer | `devices/devicefarm/fixtures/` |
| QDC: free minutes counted from the test's start; Appium packages are tests/ plus requirements.txt run by pytest; the SDK's calls, enums and target fields. | V | qdc.qualcomm.com FAQ and test package pages; the SDK wheel |
| QDC extracts the zip under `/qdc/appium/`, collects `/data/local/tmp/QDC_logs`, and its phones have curl and Wi-Fi. | R | llama.cpp's own QDC CI (`scripts/snapdragon/qdc`) |
| mksh, Android's sh, does arithmetic in signed 32 bits. | V | mksh(1), quoted in Red Hat bug 794749 |
| This Mac: M4 Max, 36 GiB, macOS 26.5.1, Metal's working set 30,150.67 MB, `/sbin/sha256sum`, no `timeout`, `/bin/dash`. | V | runs on this Mac |

## Open questions the first runs answer

1. Whether Device Farm's upload check takes our carrier package (the wheelhouse rule for Python 3 packages), and whether a test spec upload's name must end in `.yml` (the API page says `.zip` for everything that isn't an app).
2. How much disk a Device Farm host has (it decides between downloading on the host and streaming), and how fast `adb push` is to its phones.
3. Which files QDC returns from `QDC_logs` (other extensions, subfolders), how long a job may run, and its quotas; how fast a QRD downloads from the Hub.
4. The RAM of QDC's phones (the probe), and of Device Farm's newest phones (Pixel 11 series, Galaxy S26 series).
5. Whether the Snapdragon build's OpenCL and Hexagon backends start from `adb shell` on retail Galaxy phones, and whether OpenCL needs `GGML_OPENCL_ADRENO_USE_LARGE_BUFFER` for a 17 GB file.
6. Which toybox commands each phone has (`stat -c`, `df -P`, `sha256sum`); the kit has fallbacks for each.
7. Whether Glimmer at "Reasoning strength: low." answers the three prompts within 192 tokens, or spends them thinking.
8. How the low-memory killer treats a 10 to 17 GB adb process on 12, 16 and 24 GB phones.

## How to run

### Mac

`scripts/devices/local.ts` runs the kit on this Mac. It needs nothing but the repo: no AWS, no QDC key, no Hugging Face token.

1. **Smoke:** `npx tsx scripts/devices/local.ts`. The first time, it downloads the pinned `llama-b11669-bin-macos-arm64.tar.gz` (12 MB) from the llama.cpp release and the smoke model (92 MB) from the Hub into the cache (`~/.cache/muse-muse-devices`, or `MM_DEVICES_CACHE`), checks both by size and sha256, and keeps the 29 files of the archive that `keepLlamaFile` keeps. Then it runs `/bin/sh devices/kit/run.sh` on Metal and on the CPU with `KIT_SMOKE`'s limits, writes `devices/results/local/<device>/<subject>/<stamp>/` and prints the verdict: about 15 seconds after the downloads.
2. **This Mac's own file:** `npx tsx scripts/devices/local.ts --subject pick` takes what `pickSubjects` gives a 36 GB Mac, `meta-q4_k_m` (16.76 GB, whose run needs 18.0 GB of the 23.2 GB budget). A file over 200 MB never downloads without asking: the command prints the plan and the exact command, then stops. `--download --yes` downloads it when the disk has the file plus 5 GB free (21.8 GB; this Mac had 10 GB free on Oct 28), resuming a partial download. `--model <path>` uses a copy already on disk instead, after checking its size and sha256.
3. **A tuned repo:** `--tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8>` reads the repo from the public Hub (its head commit, its files and its `system` file) and runs the file `pickSubjects` gives this Mac: Q4_K_M on 36 GB.
4. **Then** `npx tsx scripts/devices/report.ts` (see Reading results).

More flags: `--subject <id>` (any id in `lib/devices/subjects.ts`), `--backends gpu,cpu` (the default, in bench order; a Mac has no NPU backend), `--settings smoke|default` (by default `KIT_SMOKE` for the smoke subject and `KIT_DEFAULTS` for the rest), `--threads <n>`, `--remove-model` (deletes a file this script downloaded once the result is written) and `--keep-run` (keeps the kit's own folder in `<cache>/runs/`).

What it holds to: the kit gets only its own `MM_*` variables plus `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LANG`, `HOME` and `TMPDIR`, so no token in the shell reaches llama.cpp. Downloads send no credential and never print a URL, and a file of the wrong size or sha256 is never kept. In the result folder, the cache is written as `<cache>`, the repo as `<repo>` and the home folder as `~`.

Measured on Oct 28 [V, this Mac, `devices/results/local/apple-mac16-5-36gb/smoke-smollm2-135m-q4_0/20261029T031655Z/`]: Metal pp128 16,136 and tg16 461 tokens a second, the CPU tg16 252. An earlier run that night gave 485 and 326: another workflow shared the Mac, so speeds move between runs. Metal's first device listing took 6 s while it compiled its kernels, and none after. SmolLM2 answered "Paris" and "17 + 25 = 42." on both backends and called blue and yellow "a shade of blue", so 2 of 3 answers were right: usable. Its memory peaks mean little, since a smoke step ends before the 2 s sampler's second sample.

The kit on its own, anywhere: put `devices/kit/` next to a llama.cpp build and run it with the variables `kitEnvFor` gives (`kitEnvLines` writes them as a file sh can source): `set -a && . ./<id>.env && set +a && sh kit/run.sh`.

Tests: `npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/kit.test.ts lib/devices/__tests__/result.test.ts lib/devices/__tests__/report.test.ts lib/devices/__tests__/local.test.ts`. kit.test.ts runs run.sh under /bin/sh and /bin/dash with fake llama.cpp and Android tools and a PATH of nothing but the tools the kit may use. local.test.ts ends with a real smoke run when the cache has the build and the smoke model (set `MM_DEVICES_CACHE` when the cache isn't the default); it writes into a temporary folder, not the repo, and reaches no network.

Not checked here: the kit under Android's mksh (this Mac has none; dash and bash in POSIX mode stand in for it, and the arithmetic stays in seconds and kB), and the 17 GB Q4_K_M run, which waits for disk space.

### Device Farm

`scripts/devices/devicefarm.ts` reaches Device Farm only through `aws devicefarm <command> ... --profile base-test --region us-west-2 --output json`. Log in first with `aws sso login --profile base-test`: the runner never logs in, and when the session has expired it stops with that command.

1. **Look, with no AWS call:** `npx tsx scripts/devices/devicefarm.ts plan --dry-run` plans from `devices/devicefarm/fixtures/`, builds the test package and the spec into the cache (`~/.cache/muse-muse-devices/devicefarm/<stamp>/`, or under `MM_DEVICES_CACHE`), and prints the plan, the estimate and the exact command that would run it. The first build downloads the two pinned Android builds (75 and 60 MB) and the carrier's 7 wheels from PyPI, each checked by sha256; the builds are trimmed by `keepLlamaFile`. The package is about 88 MB in 63 files.
2. **See the phones:** `npx tsx scripts/devices/devicefarm.ts devices` lists the Android phones by RAM tier with their chip, backends and availability, and names the ones whose RAM is only reported (Galaxy S26 and Pixel 11 phones: 12 GB at 256 GB per retailer listings [R]).
3. **Smoke first:** `npx tsx scripts/devices/devicefarm.ts run --smoke --yes` runs the 92 MB smoke model on one phone, the newest Snapdragon one (a Galaxy S26, so the run also measures its MemTotal): about 5 minutes ($0.90), at worst 27 minutes ($4.59). `--smoke --probe` smokes the phones whose RAM is only reported, 3 by default. A run of large files refuses to start until a Device Farm smoke result exists that finished and loaded the model on some backend (`--skip-smoke-check` overrides).
4. **The real run:** `npx tsx scripts/devices/devicefarm.ts plan` prints the plan with the account's billing and trial minutes (it only reads: ListDevices and GetAccountSettings), and `run --yes` schedules it. The default plan on Oct 28: Galaxy S25 (12 GB, `bartowski-iq2_xxs` as the proof, cpu, gpu and npu), Pixel 10 Pro XL (16 GB, `bartowski-iq2_m` then `bartowski-iq2_xxs`, cpu) and Galaxy S24 Ultra (12 GB, the proof, three backends): expected 100 minutes ($17.07), at worst 295 minutes ($50.15), inside the 620.25 trial minutes. Once a smoke run has measured an S26, the S26 takes the S25's place.
5. **Results:** `run --yes` reads every run once a minute. When one is `COMPLETED` it downloads the job's customer artifact and console, parses each `mm/<id>/` with `lib/devices/result.ts`, and writes `devices/results/devicefarm/<device>/<subject>/<stamp>/` (result.json, the kit's files and `host-<id>.txt`). `--detach` schedules and returns; then `fetch <run ARN> --wait`. `stop <run ARN>...` stops runs. Then `npx tsx scripts/devices/report.ts`.

Choosing: `--device <name or ARN>` (repeatable; the printed command pins the chosen phones by ARN), `--subjects <id,id>`, `--tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8>` (pickSubjects over that repo's files, read from the public Hub), `--backends cpu,gpu,npu`, `--copy auto|push|stream`, `--from <list-devices JSON>`. Caps: `--max-devices` (default 3, 1 for a smoke run, at most 5) and `--max-usd` (default 60, against the worst case). A plan over a cap is refused before anything is uploaded. One phone of each model per batch, since results are filed by model, subject and the batch's stamp.

How a file reaches the phone: the host downloads it from the Hub (public URL, no token) into its largest disk-backed folder, checks its size and sha256, and pushes it with adb, all within `MM_TRANSFER_LIMIT` (1,200 s; 300 s for the smoke model). That needs the file plus 2 GiB on the host. When the host has less, it streams the Hub's bytes straight into the phone (`curl | adb exec-in 'cat >> <file>.part'`), resuming from what the phone has after a cut, up to 8 tries, and the kit's own sha256 check is the only check. The phone's own downloader is not used here: retail phones' toybox has no curl [I] (QDC's reference phones do). The model never goes into `$DEVICEFARM_LOG_DIR`, so the artifacts stay far under 1 GB.

Billing safety: from the first ScheduleRun on, an error, Ctrl-C or SIGTERM stops every unfinished run (StopRun), and a run that waits 6 hours for its phone or runs 20 minutes past its job timeout is stopped too. If even StopRun fails (an expired session), the runner prints the `stop` command to run after logging in. `<cache>/devicefarm/<stamp>/batch.json` keeps each run's ARN, phone and files for `fetch` and `stop`. Uploads are named `mm-devices-<stamp>.zip` and `.yml` (a test spec's name must end in `.yml` or `.yaml` [V, the UpdateUpload reference]). The package is refused if any text file in it matches a secret pattern or any file holds the value of one of this shell's secret variables.

What a run adds beyond the shared contract: run.env's `MM_COPY` (auto, push or stream) and each subject's `<id>.url` (its public download URL) in the plan folder, and `host-<id>.txt` next to the kit's files: `copy` (push, stream, present, ram_skip, no_space or failed, with `copy_why`), `mem_total_kb`, `min_ram_kb`, `phone_free_kb`, `host_free_kb`, `download_seconds`, `host_sha256` (ok, mismatch or skipped), `push_seconds` or `stream_seconds` and `stream_attempts`, `kit_rc`, `kit_seconds`, `kit_finished`, and `adb_dropped` when the adb session dropped while the kit ran. If `MM_PLAN` doesn't reach the host, host.sh uses the package's plan when it has only one (a smoke batch).

Checked on this Mac without AWS: the dry run above, a local copy of the upload check on the built package (pip installs exactly requirements.txt from `wheelhouse/` with `--no-index`, and `pytest --collect-only tests` collects one test), host.sh under this Mac's bash 3.2 with fake adb, curl and phone tools (`lib/devices/__tests__/devicefarm-host.test.ts`), and the runner against canned Device Farm answers (`devicefarm-cli.test.ts`).

### QDC

Two ways in. Automated jobs (`scripts/devices/qdc.ts`) need a QDC API key, and the owner's account has only an SSH Keys section so far, so they wait for Qualcomm to turn API access on. The adb path (`scripts/devices/adb.ts`) works today, through a QDC interactive session.

**Automated jobs**

1. **The key:** make it in QDC (Users, Settings, API Keys) and save it as "What the owner does once" says. `npx tsx scripts/devices/qdc.ts check` says whether `submit.py` can use it, with no QDC call. On Oct 28 `~/.config/qdc/api.env` existed with mode 600, but its value had spaces or characters a key doesn't have, so `check` refused it.
2. **Look:** `npx tsx scripts/devices/qdc.ts plan` prints the batch from `devices/qdc/targets.json`, the minutes and the exact command, and calls nothing. `targets` lists QDC's Android phones with their chipsets, states and probes. The first command that talks to QDC makes the submitter's venv in the cache (`<cache>/qdc/venv-0.2.3`, `<cache>` is `~/.cache/muse-muse-devices` or `MM_DEVICES_CACHE`): Qualcomm's SDK zip and its wheel checked against `QDC_SDK`, then `uv pip install --require-hashes -r devices/qdc/submit-requirements.txt` and the wheel with `--no-deps`, with Python 3.12 (about 3 s once the packages are cached).
3. **Probes first:** `targets.json` starts empty, so the first `run --yes` sends the smoke probe to SM8850, SM8750 and SM8650: 3 jobs of about 9 minutes, 42 at most. Each records the phone's MemTotal, model, Android version and SoC in `targets.json`. (`probe --chipset <name> --yes` sends one.)
4. **The files:** the next `run --yes` gives each chipset what `pickSubjects` gives its RAM, a rank at a time across chipsets, at most `--max-jobs` (3, at most 10) per batch: a 24 GB phone gets `meta-q4_k_m`, then `bartowski-q3_k_m` in a later batch; 16 GB gets `bartowski-iq2_m`, then `bartowski-iq2_xxs`; 12 GB gets `bartowski-iq2_xxs` as the proof. About 45 minutes each, 125 at most. Pairs that already have a result are left out (`--again` runs them anyway).
5. **Results:** each job's kit folder is parsed with `lib/devices/result.ts` into `devices/results/qdc/qdc-<chipset>-<RAM>gb/<subject>/<stamp>/` (`cloudId` is `<chipset>/<target id>`), with notes on how the job and the carrier went. `fetch <job id>` downloads a job's logs again and writes its results. Then `npx tsx scripts/devices/report.ts`.

More flags: `--chipsets SM8850,SM8750`, `--subjects <id>,<id>` (instead of the picks), `--tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8>`, `--backends cpu,gpu,npu`, `--keep-zips`.

How a job goes: one chipset, one file, one zip of about 86 MB (the carrier, `devices/kit`, both pinned Android builds trimmed by `keepLlamaFile`, 342 MB unpacked, and the job's `mm/plan/`), packed once per batch. `submit.py` uploads it with `upload_file_v2` as a `TESTSCRIPT`, picks the chipset's Android phone target (an available one first) and calls `submit_job` with keyword arguments: `APPIUM`, `AUTOMATED`, `APPLICATION`, the timeout, `[WIFIENABLED, SCREENALWAYSON]`, the name `mm <chipset> <stamp>` and the run key as `external_job_id`. On the phone the carrier pushes `mm/` to `/data/local/tmp/mm`, starts the kit with HUP ignored (it downloads the model with the phone's curl and checks it), echoes the kit's lines, stops it past its own limits plus 5 minutes, and copies `out/<id>/` to `QDC_logs` as `mm__<id>__<file>.log`, with `host.txt` (how it ran the kit) and `stdout.txt`. `submit.py` reads each job's state every 30 s, aborts one still waiting for a phone after 6 hours or running 20 minutes past its timeout, waits up to 30 minutes for the log upload, downloads every log file (zipped or raw; a storage error page counts as a failure and is tried 3 times), and puts the flat names back as `out/<id>/`. Ctrl-C, SIGTERM or a failure aborts every job it started that hasn't ended. Its files stay in `<cache>/qdc/runs/<stamp>/`: the manifest, and per job `job.json`, `logs/` and `out/`.

What it holds to: the key is read only by `submit.py`, from `QDC_API_KEY` or the key file (refused when group or others can read it), and goes only into the SDK's header for `apigwx-aws.qualcomm.com`. Errors show it as `[QDC key]`, every printed URL loses its query, `job.json` keeps no user name or org id, and a zip that holds the key is never uploaded; the TypeScript side refuses to build a zip that holds any token from its own environment. The 0.2.3 SDK sets no timeouts (its httpx client has none and its presigned uploads and downloads use requests with none), so `submit.py` gives API calls 120 s and transfers 30 s to connect and 300 s between bytes.

**Over adb: a QDC session, or a USB phone**

1. In QDC, start an interactive session on an Android phone in "SSH only" mode with the owner's SSH key. QDC shows a tunnel command: `ssh -i <key> -L <port>:sa<session id>.sa.svc.cluster.local:5037 -N sshtunnel@ssh.qdc.qualcomm.com`.
2. `npx tsx scripts/devices/adb.ts check --tunnel '<that command>'` opens the tunnel, checks the server's version and prints the phone's facts (`--record-probe SM8850` also writes its RAM into `targets.json` for the automated planner). `plan --ram-gb 24` prints what a run does without touching anything.
3. `npx tsx scripts/devices/adb.ts run --yes --tunnel '<that command>'` runs the smoke file, then the files for the phone's MemTotal: on a 24 GB phone about 6, 45 and 42 minutes. `--session <id> --key <path>` does the same as `--tunnel`; `--port <n>` uses a tunnel or adb server already on that port.

The rules it keeps, from the first live session: it never uses local port 5037, where the owner's own adb server is (5038 by default; a pasted command's 5037 is replaced and the runner says so). It starts ssh itself with a known_hosts file of its own (`<cache>/adb/known_hosts`, the host key recorded on first use, never `~/.ssh/known_hosts`), `BatchMode`, `ExitOnForwardFailure` and keepalives, reopens it when it drops and stops it at the end. Before every adb command it sends a raw `host:version` request to `127.0.0.1:<port>` and compares the answer with this Mac's `adb version`, and stops on a mismatch, because a mismatched adb client kills the server it talks to, and on QDC that is the session's [V, AOSP adb source]. adb runs with `ADB_SERVER_SOCKET=tcp:127.0.0.1:<port>` (and `ANDROID_ADB_SERVER_PORT`), which adb doesn't count as local, so with the tunnel down it says "cannot start server on remote host" instead of starting a server that would claim this Mac's USB phones [V, AOSP source, and adb 37.0.1 on this Mac]. The phone's serial is read once, goes with every command, and is never printed or written.

How a run goes: it reads `getprop`, `/proc/meminfo`, `df` and whether the phone has curl and a sha256 tool; pushes the kit and both pinned builds to `/data/local/tmp/mm` (a model already there stays); and for each file starts the kit in the background with HUP ignored and `MM_MODEL_URL` set, so the phone downloads and checks the model itself. It polls every 10 s, echoes the kit's lines, and pulls `out/<id>/` after every step that ends (and every 2 minutes during a long one), because a session can end at any minute. When the kit ends it writes the result at once; when the phone stops answering for 10 minutes (`--reconnect-minutes`) it writes what the last pull holds, with a note, and leaves the later files for another session. Ctrl-C stops the kit, pulls and writes what there is. Each model is deleted after its run (`--keep-model` keeps them) and the folder at the end. Results go to `devices/results/qdc/qdc-<chipset>-<RAM>gb/<subject>/<stamp>/` with `cloudId` `<chipset>/session`, so the automated planner counts them as done. A phone of the owner's on USB: the runner won't use 5037, so give it a server on another port (`adb kill-server && adb -P 5038 start-server`, and the usual one again after) and run with `--usb --port 5038`; its results go to `devices/results/local/`.

Measured by hand on Oct 28, before these runners [V, `devices/qdc/tests/fixtures/sm8850-session/`]: an SM8850 reference phone with Android 16 (SDK 36), MemTotal 23,760,480 kB (24 GB) and curl, sha256sum, tar and gzip in `/system/bin`; Hub downloads at 11 to 24 MB/s. The Snapdragon build ran CPU, GPUOpenCL (Adreno 840) and HTP0 (Hexagon v81) from `adb shell`. bartowski Q3_K_M on the CPU: pp128 5.6 and tg32 3.0 tokens a second, lowest MemAvailable 13.2 GB; on the GPU pp 5.8 and tg 2.1, lowest MemAvailable 6.5 GB; the HTP0 bench never finished. By `pickSubjects`, that phone gets `meta-q4_k_m` and then `bartowski-q3_k_m`.

Tests: `npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/qdc.test.ts lib/devices/__tests__/qdc-cli.test.ts lib/devices/__tests__/qdc-python.test.ts lib/devices/__tests__/adb.test.ts lib/devices/__tests__/adb-run.test.ts`. qdc-cli runs the runner with an executor in place of `submit.py` that writes job.json and kit folders from the Oct 28 output. qdc-python runs `devices/qdc/tests/test_submit.py` (a fake SDK with the 0.2.3 wheel's modules, signatures and enums) and `test_carrier.py` (a fake adb, a stand-in kit and a fake Appium client) with `python3.12 -I`, and `test_submit_real_sdk.py` against the real wheel in the submitter's venv when there is one (`MM_QDC_VENV_PYTHON`), with QDC's API faked under httpx and its storage under requests. adb-run runs the real kit on a folder standing in for the phone, with stand-in tools printing the Oct 28 output, a fake adb server for the version check, and this Mac's real adb client against that server.

Checked on this Mac without QDC: every plan above, `check` refusing the key file, a real job zip built from the pinned archives (`unzip -t` and Python's zipfile read it with its file modes, the carrier accepts its plan and parses as Python 3.8), the submitter's venv made with the real SDK, and `submit.py` driving that SDK through upload, submission, polling, logs and an abort against the faked API. Not checked: anything on QDC's side (the job's host, its Appium server, what `QDC_logs` returns, its quotas), the carrier on a real host, and the adb runner on a real phone.

## Reading results

Every run is a folder `devices/results/<cloud>/<device slug>/<subject id>/<UTC stamp>/`: `result.json` (a `Result`, from `writeResult`) with the kit's own files beside it.

**The summary.** `npx tsx scripts/devices/report.ts` prints the report for every result.json under `devices/results/`. `--write` also writes `devices/results/report.md` and `devices/results/picker.json`, and `--dir <folder>` reads another folder. Both files carry the newest result's stamp rather than the time, so the same results always give the same files.

- **report.md:** first "What the picker says", one line per phone tier (12, 16 and 24 GB, and any other RAM tested) and per Mac RAM size that ran a real file, with the evidence. Then every run in a table (device, where, RAM, file, rating, best backend, generation and prompt speed, answers right, peak memory, lowest MemAvailable, each backend in a few words, a link to its folder), why each run got its rating, and the smoke runs apart.
- **picker.json**, for the device picker: `{ schema: 1, results, newest, tiers }`. Each tier has `os`, `ramGiB`, `changes`, `rating`, `words`, `line`, `subjectId`, `kind` (`base` for a stand-in, `tuned` for our own file), `quant`, `fileBytes`, `genTps` (the slowest device's), `devices` and `evidence`. `changes` is true only when the tier's best file ran usable or slow on every device tested in it, by each device's newest run of that file; `words` is then "Runs" or "Runs slowly", and `line` adds the speed ("Runs slowly: about 3.01 tokens a second (Q3_K_M)"). Otherwise the picker keeps "Won't run here: use Try it live", and `rating` is null when nothing was tested.

**One run, in this order:**

1. `result.json`'s `verdict`: the rating, the backend that decided it, its speeds, how many of its answers were right of those asked, and `reasons`, one per backend that didn't count and then the rating's own. `notes` has the rest: a sha256 left unchecked, fewer Hexagon sessions than asked, a kit that a host or a signal stopped.
2. `steps.txt`: one line per step with its `end` and `why` (the table in "How a step ended"). A timeout's `rc` says how it ended: 143 when TERM stopped it, 137 when it needed the KILL 10 s later. `why=lmk` comes with `lmk-<step>.txt`, the logcat lines that name the process; `why=signal9` is a SIGKILL with no such line. Backends with no generation speed get their skipped answers listed before the others' answers.
3. `kit.log` for the timeline, then `run.txt` (the settings), `device.txt` and `model.txt`.
4. The tools' own output. `bench-<b>.jsonl` is llama-bench's: the line with `n_prompt` above 0 is the prompt speed, the one with `n_gen` above 0 the generation speed. `bench-<b>.log` (with `-v`) has `offloaded N/M layers` and the buffer sizes; result.json adds up a load's model buffers of one name. `answer-<b>-<prompt>.txt` is the raw output with its control tokens: Glimmer's answer is what follows the last `to=user<|message|>`, up to `<|eot|>`, and an output with `to=self` but no `to=user` never answered. Its `.log` has the timings.
5. Memory: `mem-<step>.txt`, one sample every 2 s. On a phone, trust `availDropBytes` over `peakRssBytes` for the GPU and the NPU, whose drivers' memory isn't in the process's RSS. On the SM8850 phone with Q3_K_M [V, by hand before the kit existed]: the CPU bench's RSS peaked at 5,493 MiB while MemAvailable fell from about 19,000 MiB to 13,232 MiB; the GPU bench's RSS peaked at 7,440 MiB while MemAvailable fell to 6,522 MiB. On a Mac, RSS is sampled with `ps`, so a step shorter than the interval has no real peak.

**What the kit writes beyond the contract**, so the other parts can rely on it: run.txt's `layout_<backend>` (flat, bin-lib or missing), `npu_sessions_used` when the NPU backend lists fewer Hexagon sessions than `MM_NPU_SESSIONS` (the kit then runs on those it lists rather than skipping the NPU), `why=time` or `why=signal` with `status=cut`, and `cleanup` and `removed` with `MM_CLEANUP=model` (an optional input: the kit deletes the model when it ends; no runner sets it, since they delete the model themselves). model.txt's `check=timeout`: the size matched but the sha256 didn't finish within `MM_LIMIT_CHECK`, so the run goes on unverified, as with `no_tool` (`ModelCheck` in types.ts has it). `fetch.log`: curl's errors when the kit downloaded the model, with every URL's query taken out. A fetch whose curl ended well but with the wrong size is `end=error why=size`, and its partial file is deleted. On INT or TERM the kit exits 130 or 143 after writing run.txt; the step that was running gets no line, and result.ts reads it and every later step as skipped, `why=stopped`. The kit ignores SIGPIPE as well as SIGHUP, so a dropped adb pipe can't stop it at its next progress line.

**The first phone numbers** [V, by hand on Oct 28: QDC's SM8850 reference phone, Android 16, 24 GB, the b11669 Snapdragon build; the outputs are in `lib/devices/__tests__/fixtures/android-sm8850-q3_k_m/`]: `bartowski-q3_k_m` (13.96 GB, its sha256 checked in 5 s) read prompts at 5.6 tokens a second and generated 3.0 on the CPU, 5.8 and 2.1 on the GPU with every layer on it (2.5 with 36 layers), and the NPU printed nothing before the session ended. No Glimmer answer has been asked on a phone yet. If its answers come out right, a 24 GB phone with Q3_K_M rates slow (from 1 to 4 tokens a second), and that tier becomes "Runs slowly" once every 24 GB phone tested agrees.
