# A QDC phone, by hand (Oct 28, 2026)

Real llama.cpp b11669 output from a QDC interactive session ("SSH only", adb over the SSH tunnel) on a Snapdragon 8 Elite Gen 5 (SM8850) reference phone: Android 16 (SDK 36), MemTotal 23,760,480 kB, MemAvailable about 19.6 GB idle. It ran the android-arm64-snapdragon build from `/data/local/tmp` with `LD_LIBRARY_PATH` and `ADSP_LIBRARY_PATH` set to its `lib/`, by hand, not through the kit, so these are llama.cpp's own files with the hand script's names (`.out` is stdout, `.err` is stderr). The tests feed them through the real kit with stand-in tools.

| Files | What ran |
|---|---|
| `q3_k_m-bench-cpu.jsonl`, `.err` | bartowski Q3_K_M (13.96 GB), `llama-bench -p 128 -n 32 -r 1 -o jsonl -dev none -ngl 0`: pp128 5.6 t/s, tg32 3.0 t/s, 68 s, lowest MemAvailable 13.2 GB, peak RSS 5.5 GB |
| `q3_k_m-bench-gpu.jsonl` | the same with `-dev GPUOpenCL -ngl 99`: pp 5.8, tg 2.1, lowest MemAvailable 6.5 GB, peak RSS 7.4 GB |
| `q3_k_m-bench-gpu36.jsonl` | `-dev GPUOpenCL -ngl 36`: pp 5.4, tg 2.5 |
| `q3_k_m-bench-npu.err` | `-dev HTP0 -ngl 99 -ub 1024`: only the init lines when the session ended; it never printed a result |
| `smoke-bench-{cpu,gpu,npu}.jsonl` | SmolLM2 135M Q4_0 (the smoke subject) on each backend |
| `smoke-answer-cpu-{capital,sum,color}.out`, `.err` | llama-completion with the kit's flags on CPU: "Paris", "42", and "a shade of blue" (wrong) |
