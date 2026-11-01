# 3D spike: Blender, glTF and three.js in a build sandbox (Oct 31, 2026)

Owner request: "Muse muse should be able to use 3d models and renderers to use things like blender and more." Design:
`_plan/3d.md`. This spike answers its "Facts to establish". Nothing was built into the product.

## The answer

**Blender works in a build sandbox, and three of the four facts are settled.** Blender 5.2.3 LTS, the current LTS, starts headless from
the builder snapshot with no missing libraries. Cycles on the CPU with the OIDN denoiser renders a 640x480 still in about 4 s on
4 vCPUs. Workbench and Eevee need one small package (libEGL, 0.6 MB), and then they run on Mesa's software renderer. GLB export,
OBJ and STL conversion and decimation all work. Every GLB loaded in three.js in headless Chromium on SwiftShader, raw and optimized,
with no errors and no requests leaving the sandbox.

**Not done: Muse Code driving Blender.** Meta rejected the `MODEL_API_KEY` in the Vercel development environment ("Invalid or expired
API key"). This spike was told not to read `.env.local`, which is where the Muse Code spike got its key. The wiring was proven for free
(see section 4), so the run is one command once that key is renewed. Meta spend: **$0**.

Three surprises:

1. **download.blender.org refuses the sandbox** with a 403, on the index, the tarball and the sums file. Blender's own mirror redirector,
   `mirror.blender.org` (the link on blender.org's download page), works, at about 270 MB/s.
2. **Cycles beats Eevee on these CPUs.** Eevee runs on Mesa's llvmpipe at 5 to 20 s a still and 6.6 s a turntable frame, against
   Cycles at 2 to 4 s a still and 2 to 2.6 s a frame. It also takes 1.6 to 2.0 GB of memory against Cycles' 0.3 to 0.6 GB.
3. **Muse Code 1.4.14 ships a `blender` skill**, which builds turn off today (`DISABLED_BUNDLED_SKILLS` in `lib/sandbox/setup.ts`).

## Facts to establish

| Fact | Result |
|---|---|
| LTS build | **Blender 5.2.3 LTS** (Oct 22, 2026), `blender-5.2.3-linux-x64.tar.xz`. blender.org also still maintains 4.5 LTS |
| Size | Tarball 385.3 MB. Extracted **1,237.6 MB** in 5,592 files: the binary is 167 MB, `lib/` 446 MB and `5.2/` (Python 3.13.13 and data) 582 MB |
| Install time | Download 1.6 to 2.0 s, sha256 check 0.3 to 2.6 s, extract 11.7 to 14.3 s, libEGL 2.3 to 3.7 s. **About 20 s in all** |
| sha256 | **Pass in all 4 runs.** `78486c01...0a918eec` matched both Blender's sums file on mirror.blender.org and a copy of download.blender.org's file read from the laptop side |
| Runs as shipped | **Yes.** `blender -b --version` exits 0 and `ldd` finds nothing missing. The snapshot already has libX11, libXi, libXxf86vm, libSM, libGL and the rest, from Playwright's `install-deps`. The tarball's `lib/` has none of them. There is no dnf: the image is Ubuntu 26.04.1, apt only |
| Engines with no GPU | **Cycles on the CPU with OIDN: works out of the box. Workbench and Eevee: abort** (exit 134, "Couldn't open libEGL.so.1") until `apt install libegl1 libegl-mesa0`, then both work on Mesa llvmpipe through EGL. Eevee also works on Vulkan through lavapipe, but that's 113 MB more and no faster |
| 640x480 time, 4 vCPUs | Cycles 32 samples with OIDN **4.1 s**. Workbench **1.1 to 1.4 s**. Eevee 32 samples **15.8 to 20.0 s cold, 5.4 to 7.6 s warm**. Add about 1 s for Blender to start |
| GLB in three.js on SwiftShader | **All 12 loaded** (4 models, each raw, meshopt and Draco): no console errors, no external requests, 33 to 205 ms to load, every screenshot not blank |
| Optimizer sizes | gltf-transform 4.5.1 with WebP textures: **Draco 3.0 to 29.5 times smaller, meshopt 2.2 to 5.7 times smaller** (table in section 3) |
| Muse Code driving Blender | **Not measured.** Blocked by the expired key. The firewall broker and Muse Code's endpoint settings were checked for free |
| Licenses | Not re-read here. Blender stays a tool in the sandbox. Its outputs aren't covered by the GPL, and products never ship Blender |

## Method

`run.ts` runs `phase-<name>.sh` scripts in one throwaway sandbox from `BUILDER_SNAPSHOT_ID` (`persistent: false`, named `spike-3d-*`),
copies `/tmp/out` back, and stops it. Each phase names its firewall:

- **open** (`SNAPSHOT_POLICY`, allow-all) only for phase setup, the way the snapshot script installs everything.
- **locked** is `builderNetworkPolicy()` from `lib/sandbox/policy.ts`, called as a build calls it but with no platform host: api.meta.ai
  brokered on Muse Code's routes for this sandbox's placeholder, registry.npmjs.org, and nothing else. Phase render checked it:
  download.blender.org and dl.polyhaven.org fail (curl exit 6), npm answers 200, and api.meta.ai without the placeholder gets the
  firewall's 403.

`creds.sh` pulls the development environment with `vercel env pull` into a mode 600 file in the session scratchpad, the way
`docs/spikes/xr-2026-10-31/run.sh` does. It reads only `VERCEL_OIDC_TOKEN`, `MODEL_API_KEY` and `BUILDER_SNAPSHOT_ID`, and deletes the
file at once. No `.env.local` was read. `cost-ledger.jsonl` records every sandbox's worst-case cost and the proxy's Meta cost, and
`run.ts` refuses to start a run that could pass $0.95 of sandbox or $0.20 of Meta. Every output was scanned for the key, the
placeholder, the stand-in and the OIDC token before it was kept. All clean.

For Muse Code, `proxy.mjs` stands in for the gateway, after the Muse Code spike's pattern (fresh code). It runs as root on
127.0.0.1:8787 and holds the placeholder. It forwards only `muse-spark-1.3-contributor`, refuses `auth: none`, meters Meta's reported
usage at `lib/meta/pricing.ts` prices, and refuses everything past its budget. Muse Code gets a random stand-in key, so a call that
skips the proxy meets the firewall's 403.

Runs (all 4 vCPUs unless marked):

| Run | Phases | What it showed |
|---|---|---|
| 1 | setup | download.blender.org 403. Stopped at once |
| 2 | setup, render, muse, web | Blender, Eevee, Workbench, conversion, web all work. My OIDN check read an attribute Blender 5.2 doesn't have, so Cycles failed. Meta 401 |
| diag1 | muse-diag | The 401 is Meta rejecting the key, not the firewall (section 4) |
| 3 | setup, render, web | Every engine, cold and warm Eevee, turntables. OIDN still off: the denoiser enum reads empty outside a render |
| 4 and 5 | setup, render2, on 4 and on 8 vCPUs | OIDN on, where Eevee's first-render cost goes, scaling |

Hosts were "Intel(R) Xeon(R) Processor @ 2.90GHz", except run 3 on a 2.50GHz part, 2 GB per vCPU. Run 3 is the slow end of
each range below (Cycles with no denoiser 4.0 s there, 2.7 s in run 4), as the VR spike also saw between hosts.

## Results

### 1. Install (phase setup)

- **Source.** `curl` to download.blender.org got 403 for the index, the tarball (a 61 KB page instead) and the sums file, in every
  run. The same request from the laptop side (WebFetch) worked, so it's the sandbox's address or traffic that's refused, not the path.
  `mirror.blender.org/release/Blender5.2/blender-5.2.3-linux-x64.tar.xz` redirected to `mirrors.iu13.net` and gave the whole file in
  1.4 s. Only plain curl was used: varying the user agent to get past the 403 was refused as bot-check circumvention (see "Permission
  denials"), and rightly so.
- **Checksum.** The sums file from mirror.blender.org and the copy of download.blender.org's file both list
  `78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec` for the linux x64 tarball, and the download matched it.
- **Libraries.** None missing for `blender -b`. Workbench and Eevee need `libEGL.so.1`. `libegl1` and `libegl-mesa0` (2 packages,
  0.6 MB installed) fix it. The snapshot already had `libgl1`, `libgl1-mesa-dri`, `libglx-mesa0`, `mesa-libgallium`, `libgbm1` and
  `libvulkan1`. `mesa-vulkan-drivers` (lavapipe) is 113.1 MB and only needed for `--gpu-backend vulkan`.
- **Disk.** 1,237.6 MB for Blender (`du`), 1,255 MB by `df` after the tarball was deleted, on a root filesystem with 5.8 GB used before. A builder snapshot would grow
  by about that much, roughly $0.10 a month at $0.08 per GB-month.

### 2. Rendering (phases render and render2, build firewall)

The scene is made from nothing by `lib/scene.py`: a faceted rock, a tree, a metal ring and a 256 px checker ground, 7 objects and 258
triangles, with a camera and a sun. Times are Blender's render call. "Wall" adds Blender's start and the scene build, about 1 s. Peak
memory is the Blender process's.

| Engine and settings | 4 vCPUs render (wall) | 8 vCPUs render (wall) | Peak memory |
|---|---|---|---|
| Cycles 640x480, 8 samples, OIDN | 2.0 s (2.6) | 1.5 s (2.3) | 0.63 GB |
| **Cycles 640x480, 32 samples, OIDN** | **4.1 s (5.0)** | **2.3 s (3.2)** | 0.64 GB |
| Cycles 640x480, 32 samples, no denoiser | 2.7 to 4.2 s (3.5 to 5.3) | 1.6 s (2.4) | 0.33 GB |
| Cycles 640x480, 128 samples, OIDN | 8.6 s (9.3) | 4.6 s (5.3) | 0.63 GB |
| Cycles 1280x960, 64 samples, OIDN | 26.8 s (27.5) | 14.2 s (14.9) | 1.38 GB |
| Cycles 320x240, 16 samples, no denoiser | 0.6 s (1.7) | | 0.32 GB |
| **Workbench 640x480** | **1.1 to 1.4 s (1.8 to 2.3)** | 1.0 s (1.8) | 0.55 GB |
| Eevee 640x480, 32 samples, Mesa cache cold | 15.8 to 20.0 s (16.7 to 21.1) | 14.9 s (15.8) | 2.0 GB |
| Eevee 640x480, 32 samples, Mesa cache warm | 5.4 to 7.6 s (6.1 to 8.7) | 4.2 s (5.0) | 1.6 GB |
| Eevee, same, `MESA_SHADER_CACHE_DISABLE=true` | 15.2 s (15.9) | 14.3 s (15.2) | 2.0 GB |
| Eevee, same, `--gpu-backend vulkan` (lavapipe), cold then warm | 17.2 s, then 5.6 s | | 0.9 to 1.1 GB |
| Eevee 640x480, 64 samples, warm | 9.9 s | | 1.6 GB |
| Eevee 1280x960, 64 samples | 31.5 s | | 1.8 GB |

24-frame turntables at 640x480, the camera circling once:

| Engine | 4 vCPUs | 8 vCPUs | Per frame (4 vCPUs) | MP4 (H.264, ffmpeg in 0.5 s) |
|---|---|---|---|---|
| Workbench | 4.5 s | | 0.19 s | 57 KB |
| Cycles, 16 samples, no denoiser | 48.7 s | | 2.0 s | 211 KB |
| Cycles, 16 samples, OIDN | 62.0 s | 35.8 s | 2.6 s | |
| Eevee, 16 samples | 158.2 s | | 6.6 s | 190 KB |

- **OIDN is in the build** (`_cycles.with_openimagedenoise` is true; Blender 5.2 has no `build_options.openimagedenoise`) and costs
  about 1.4 s and 300 MB at 640x480. It smooths the picture a little (grain 3.69 down to 3.36 on the same frame). On a scene this simple,
  32 samples were already clean, so the gain will show on harder lighting.
- **Eevee's first-render cost is Mesa's shader cache**, not Blender's: the cold render left 4.3 MB in `~/.cache/mesa_shader_cache` and
  nothing in `~/.cache/blender`, and turning Mesa's cache off brought the 15 s back. A snapshot could carry a warm cache, but Eevee
  compiles shaders per material, so a new scene would still pay for its own materials.
- **8 vCPUs make Cycles 1.7 to 1.9 times faster** (1.3 at 8 samples, where start-up dominates) at twice the rate per second, so about the same cost, sooner. Eevee and Workbench barely
  change: llvmpipe doesn't use the extra cores well.
- Every picture passed the VR spike's blank test. See `results/pictures/` for Cycles, Eevee and Workbench at 640x480 and the Cycles
  turntable.

**Conversion and decimation** (`lib/convert.py`, inputs made outside Blender by `lib/make-meshes.mjs`; the whole script 2.8 to 3.9 s wall):

| Step | In | Out | Time |
|---|---|---|---|
| OBJ to GLB | 3.9 MB, 147,456 triangles | 8.8 MB GLB | import 0.04 to 0.06 s, export 0.26 s |
| Binary STL to GLB | 451 KB, 9,024 triangles | 504 KB GLB | 0.004 s, 0.012 s |
| Decimate to 10% (Decimate modifier, applied) | 147,456 triangles | 14,744 triangles, 1.1 MB GLB | 1.6 to 2.4 s |
| Scene to GLB | 7 objects, 258 triangles, 1 texture | 42.5 KB GLB | 0.62 to 0.66 s |

This build of Blender also imports PLY, USD, Alembic, FBX and glTF.

### 3. GLB in three.js, and gltf-transform (phase web, build firewall)

`three@0.184.0` and `@gltf-transform/cli@4.5.1` installed from npm through the build firewall in 4.4 to 5.8 s (175 packages, 94 MB,
`sharp` 0.35.5 loads, so WebP works). `gltf-transform optimize <in> <out> --compress draco|meshopt --texture-compress webp`:

| Model | Raw GLB | meshopt + WebP | Draco + WebP | Optimize time |
|---|---|---|---|---|
| Scene (258 triangles, 256 px texture) | 42,500 B | 19,676 B (2.2x) | 14,408 B (3.0x) | 0.35 to 0.50 s |
| Sphere from STL (9,024 triangles) | 504,300 B | 105,512 B (4.8x) | 23,976 B (21x) | 0.47 to 0.74 s |
| Decimated torus (14,744 triangles) | 1,096,344 B | 277,556 B (4.0x) | 60,940 B (18x) | 0.39 to 0.65 s |
| Torus from OBJ (147,456 triangles) | 8,847,532 B | 1,557,184 B (5.7x) | 299,968 B (29.5x) | 0.80 to 1.16 s |

`lib/web/shoot.mjs` opened each of the 12 files with `GLTFLoader` (Draco and meshopt decoders served from the `three` package, not a
CDN) in the snapshot's Playwright headless shell, Chromium 156.0.8078.4, with the VR spike's `--enable-unsafe-swiftshader`. The renderer
was "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))". Results: all 12 loaded, 0 console errors, 0 requests off
127.0.0.1, 33 to 205 ms to load (Draco a little slower than meshopt), triangle counts unchanged by the optimizer, every screenshot not
blank. The browser started in 0.4 to 1.0 s, and the 12 shots took 5 to 7 s.

Two things a 3D skill must handle: the metal ring renders black in three.js, because metals need an environment map
(`RoomEnvironment` with PMREM) and the viewer had only lights. And Blender's exporter leaves cameras out unless asked
(`export_cameras=True`), so the viewer framed the model itself.

### 4. Muse Code driving Blender (phase muse): blocked

What happened, all free:

- **M0.** Muse Code 1.4.14 lists `bundled:blender`, off: "Build, edit, animate and render 3D content in Blender with Python (bpy),
  usually headless. Covers modeling objects and assemblies from a description or reference image, recreating a photographed scene,
  laying out environments...". `game-3d-visuals`, `visual-coding` and `web3d` are off too.
- **M1** ran `muse exec` the way a TEST_MODEL build does (`museExecArgs`, Contributor, reminders off, `backgroundModelSetting`), plus
  `endpoint_transport={"base_url":"http://127.0.0.1:8787/v1","auth":"bearer"}` and `telemetry.enabled=false`. Exec accepted the
  settings and asked the proxy for its catalog with the stand-in key, so the wiring works. Meta answered the catalog **401**, and exec
  stopped at once: "failed to fetch model catalog: authentication failed: your API key from META_API_KEY was rejected". So on exec
  1.4.14 a catalog 401 is fatal. The Muse Code spike saw a catalog 403 pass on serve.
- **diag1** sent `GET /muse-code/models` and `GET /v1/models` through the proxy: both **401 `invalid_api_key`, "Invalid or expired API
  key"**, from Meta. The same calls without the placeholder got the firewall's own 403 text. So the firewall swapped the key as
  designed, and Meta refused the key itself.
- No model call reached Meta. **Meta spend $0.** M2 (the mug) and M3 (the mug with the bundled skill on) never started, by design,
  because M1 didn't pass.

To finish it, renew `MODEL_API_KEY` in the Vercel development environment, then (about $0.01 to $0.02 expected on Contributor):

```
PROXY_BUDGET_USD=0.15 docs/spikes/3d-2026-10-31/creds.sh docs/spikes/3d-2026-10-31/run.ts docs/spikes/3d-2026-10-31/results/run6 setup:open muse:locked web:locked
```

Anything else that takes Meta's key from a development pull is broken in the same way.

### 5. Meta's open 3D and depth models (web research, not run)

| Model | What it does | License | GPU | Fit for the lab |
|---|---|---|---|---|
| **SAM 3D Objects** (Nov 2025) | One image to 3D shape, texture and layout. The quick start saves a **Gaussian splat** (`.ply`) | SAM License (code and checkpoints). Hugging Face access is gated | "A NVIDIA GPU with at least 32 Gb of VRAM", 64-bit Linux, CUDA 12.1 builds of PyTorch | Fits an A100 40 GB or 80 GB. Not an A10 (24 GB). GH200 is ARM: not confirmed |
| **SAM 3D Body** | One image to a full-body human mesh (Meta's MHR rig) | SAM License. Checkpoints by request | Not stated | Probably, unconfirmed |
| **VGGT** (Meta and Oxford) | Camera poses, depth maps, point maps and tracks from one or more images | Code under a commercial-use license that excludes military use. `VGGT-1B` non-commercial. `VGGT-1B-Commercial` by application | bf16 needs Ampere or newer. VRAM not stated | Yes on A100 |
| **MapAnything** (Sept 2025) | Metric 3D reconstruction: points, depth, poses, intrinsics | Code Apache 2.0. `facebook/map-anything-apache` Apache 2.0. `facebook/map-anything` CC-BY-NC 4.0 | Not stated (up to 2,000 views on 140 GB) | Yes on A100, and the cleanest license here |
| **HyDen MoGe-v2 metric point** | One image to a metric point map | FAIR Noncommercial Research License, gated | Not stated | Research only |

The SAM License (read from the SAM 3D Objects repo) is royalty-free and worldwide, and says nothing that bars commercial use. It does
require trade-control compliance, bars military, ITAR, nuclear and weapons uses and reverse engineering, requires the license to go
with any copies, and requires an acknowledgement in publications. Meta can change it. This is a reading, not legal advice.

**Confirmed:** the licenses and GPU line above, from the repos and model cards on Oct 31. **Not confirmed:** VRAM for SAM 3D Body,
VGGT and MapAnything; whether SAM 3D Objects exports a mesh or GLB rather than splats; whether any of these build on ARM (the GH200);
and whether Meta released a newer 3D generator in 2026 (a search found none). The lab's GPUs come from `docs/KNOWLEDGE_RUN_LOG.md`.

A splat isn't a mesh: three.js would need a splat renderer, or a conversion step, before a product could show SAM 3D's output.

## What it means for the design

1. **Item 2 (Blender in builds) is ready, with one change of source.** The build firewall blocks download.blender.org and Poly Haven, so
   Blender can't be fetched during a build. It has to be in the snapshot, from mirror.blender.org, with the hash pinned.
2. **Cycles is the default renderer, not Eevee.** On these CPUs Cycles is faster, lighter, and needs no GL. Workbench is the fast
   preview.
3. **Item 3 (render jobs) fits the rules.** A still takes about 5 s and a 24-frame turntable about a minute on 4 vCPUs, in a sandbox
   that starts in 2 to 7 s from the snapshot. No always-on server is needed.
4. **Item 1 (three.js) is proven in the sandbox for GLB too.** The judge and `verify` can screenshot 3D products as the VR spike did,
   provided decoders and assets are served locally.
5. **Item 4 (Meta's 3D models) stays later,** as planned: they need a 32 GB GPU, and SAM 3D's splats need a renderer or a mesh step.
6. **Muse Code's own `blender` skill is the open question.** Whether to turn it on for 3D briefs, or write our own, waits for the
   rerun in section 4.

## Recommendations

**Snapshot, not on-demand.** Add an install step to the snapshot (`lib/sandbox/setup.ts`, next to `installSystemTools`):

1. Download `https://mirror.blender.org/release/Blender5.2/blender-5.2.3-linux-x64.tar.xz` with a pinned sha256 (above) and fail the
   snapshot on a mismatch. Extract to `/opt/blender` and link `/usr/local/bin/blender`. About 16 s and 1.24 GB.
2. `apt-get install --no-install-recommends libegl1 libegl-mesa0` (0.6 MB). Not `mesa-vulkan-drivers` (113 MB, no gain).
3. Check `blender -b --factory-startup --version` and one 64x48 Workbench render in the snapshot script, and record the Blender version
   in `builder.json`.
4. Optional, only if Eevee is offered: render one small Eevee scene at snapshot time to leave a warm Mesa cache (4.3 MB). It saves about
   10 s on a first Eevee render with the same materials.

On-demand install would cost the same 20 s on every build that wants 3D, and needs an egress rule for a mirror the build firewall
doesn't allow today. Not worth it for 1.24 GB of snapshot.

**Default renderer:** Cycles on the CPU, OIDN on, 32 samples, 640x480 for stills (4 s on 4 vCPUs). Workbench for thumbnails, previews
and quick turntables (1 s a still, 0.2 s a frame). Eevee only when a brief needs its look, never the default (15 to 20 s cold, 1.6 to
2 GB of memory, 6.6 s a frame).

**Render job limits** (platform render jobs, item 3; also the 3D skill's advice for builds):

| Limit | Value | Why |
|---|---|---|
| Size | 4 vCPUs. 8 for turntables when speed matters | Cycles halves on 8 vCPUs at the same cost. Nothing else gains |
| Still | Up to 1280x960 and 128 samples. Wall cap 120 s | The largest measured, 1280x960 at 64 samples, took 27.5 s |
| Turntable | Up to 48 frames at 640x480: Cycles at 16 samples or Workbench. Wall cap 300 s | 24 frames took 62 s in Cycles with OIDN, 4.5 s in Workbench |
| Eevee | Off by default. When on, 640x480 and a wall cap of 120 s | 20 s cold, 6.6 s a frame |
| Memory | Expect 0.6 GB for Cycles 640x480, 1.4 GB at 1280x960, 2 GB for Eevee | 8 GB on 4 vCPUs leaves room for one Blender plus a browser |
| Uploads | Convert OBJ, STL, PLY, FBX and glTF to GLB, decimate over 100k triangles, then optimize | 147k triangles converted and decimated in under 4 s |
| Cost | Worst case about $0.011 per minute on 4 vCPUs | Pro rates: $0.128 per vCPU-hour and $0.0212 per GB-hour |

**Asset pipeline:** `gltf-transform optimize --compress draco --texture-compress webp` by default (3 to 30 times smaller here),
meshopt when a model is animated or load time matters more than size. Serve the Draco decoder from the `three` package. Vendor CC0 assets
to Blob (wave 3 unit 4), since builds can't reach Poly Haven.

**The three.js skill:** add an environment map, or metals render black; export cameras from Blender when the framing matters; and
claim only what was measured: a render made in a sandbox says so.

## Spend

| Item | Amount |
|---|---|
| Vercel Sandbox, worst case by the ledger (6 sandboxes, 889 s, every vCPU counted busy) | **$0.195** of the $1 cap |
| Meta | **$0** of the $0.20 cap. No model call reached Meta |
| Snapshots created | None |

Downloads into a sandbox are free on Pro. The real Active CPU bill is lower than the worst case, since only busy CPU time is charged.

**All 6 sandboxes are stopped**: `list.ts` found `spike-3d-mvwtkxx49350`, `-mvwtocmfd44c`, `-mvwtsmj0ae75`, `-mvwtuxkld636`,
`-mvwu5utk18bd` and `-mvwu5utk38e9`, every one "stopped", after the last run.

## Permission denials

- A local `curl` to download.blender.org, to see whether the 403 was the sandbox's alone, was denied by the auto mode classifier. The
  same check was done with WebFetch (the index and sums file came back) and from inside the sandbox.
- A probe script that tried other user agents against download.blender.org was denied as bot-check circumvention. It was dropped.
  Blender's own mirror link, from its download page, is the source instead.

## Not measured

- Muse Code driving Blender, on any model, and so whether the bundled `blender` skill helps (section 4).
- 1920x1080 renders, scenes heavier than 147k triangles, and Cycles with many lights or volumes.
- FBX, PLY, USD and glTF imports (listed as present, not run).
- Whether a warm Mesa cache in a snapshot survives to a new sandbox (it should: it's a file in `$HOME/.cache`).
- Blender 4.5 LTS. Only 5.2.3 was tried.
- SAM 3D or any Meta 3D model on a GPU.

## Files

- `creds.sh` gets the three credentials and runs a script. `run.ts` is the runner, with the firewalls, the ledger and the credential scan.
  `list.ts [--stop]` finds `spike-3d-*` sandboxes. `proxy.mjs` is the metering proxy. `cost-ledger.jsonl` is every run's cost.
- `phase-setup.sh` installs Blender. `phase-render.sh` and `phase-render2.sh` render and convert. `phase-web.sh` optimizes and screenshots.
  `phase-muse.sh` is the Muse Code task, and `phase-muse-diag.sh` the free key check.
- `lib/`: `scene.py` (scene, GLB, render, turntable), `convert.py`, `probe.py`, `make-meshes.mjs`, `png-stats.mjs` (blank test and
  grain), `exec-summary.mjs`, and `web/` (the viewer page, server and screenshot script).
- `results/<run>/phase-*.txt` is each phase's output, with Blender's logs beside it. Rendered images, GLBs and archives were removed
  to keep the repo small, except `results/pictures/`.
