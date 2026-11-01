# Jetson to-do

What needs a real board. There is no Jetson access yet, so nothing here has been run. Later units add to this list.

## One-bit Muse Glimmer on a Jetson Orin Nano

From `QUANT_TARGETS` (`docs/TRAINING.md`, "Device targets"). Until these are done, every page labels the file not run on a real board.

1. **Does it load?** Run the tuned IQ1_S file on an 8 GB Orin Nano with llama.cpp at b11669 or later, in a clean boot. Record peak memory. The file measured 6.53 GB on the knowledge model; the 7.7 GB to run is an estimate; the earlier 70% device rule would allow only 5.6 GB. Try a smaller context, then mmap, then partial GPU layers.
2. **How fast is it?** Record tokens a second, and how long the first token takes.
3. **Is it usable?** Run the same held-out prompts as the job's answer check on the board, and compare with its results on the GPU.
4. **Then replace the copy.** Change `fit` in `deviceModelTarget` and `LOW_BIT_FACTS` in `lib/train/quant-targets.ts` to what was measured.

## The Jetson installer

From `EXPORT_TUNED` (`docs/TRAINING.md`, "Export a tuned model"). Tested only on a simulated board, with a fake `uname`, board file, `cmake` and `llama-cli`.

1. **Does the source build work?** Run the installer on a real board: `cmake` with `GGML_CUDA=ON` at b11669, on JetPack's own CUDA. Record how long it takes, and whether `-j 4` runs out of memory.
2. **Which flags let it load?** The script uses `-c 4096 -ngl 99`, neither measured on a board. Change `LLAMA_RUN_CONTEXT` and the default layers in `lib/train/export` to what works.
3. **Does `--cpu` run?** The arm64 prebuilt may need a newer glibc than the board has.
4. **Does Ollama run an IQ1_S file?** Not tried anywhere.
