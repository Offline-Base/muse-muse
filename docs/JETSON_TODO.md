# Jetson to-do

Everything that needs a real board. There's no Jetson access yet. None of this has run. When someone has a board, they do these in order. Each says what proves it.

## Gadget connect (`GADGET_CONNECT`, docs/GADGETS.md)

1. **Copy the files and start it.** `muse-device/server.py`, `drive.py`, `train.py` to a board, then `python3 server.py --tls`. Proves: it makes a certificate, and `python3 server.py pair` prints a code and a check number. `server.py` needs `openssl` on the board, which nobody has checked on JetPack 7.
2. **Reach it from a hosted site.** A hosted site can't call a private address, on purpose. A board needs a public address that keeps its own TLS: a TCP passthrough tunnel, not one that ends TLS itself, or the pin would be the tunnel's certificate. Open: which tunnel. On a local site, a board on the same network works.
3. **Pair it from `/gadgets`.** Proves: both screens show the same check number, and the board's kind comes out `jetson_orin_nano`. `boardKindOf` matches the text of `describe_device`'s `model`. A real board's text has never been read by this code.
4. **Put one-bit Muse Glimmer on it and start it.** From a tuned model's IQ1_S file (tg-quant-targets), with `install_model` and `start_model`. Proves: it fits and answers. The file is about 6.5 GB and the estimate to run it is 7.7 GB against 8 GB of memory, with no measurement. A failed GPU allocation has frozen and rebooted these boards (`train.py`), so watch it, and be ready for it not to fit. Its answers may also be poor: the knowledge run's one-bit recall was 9.0% against 29.5% at four bits.
5. **Ask from a product.** `askBoard` from a linked product. Proves: the answer comes from the board, in under `BOARD_ANSWER_MS` (100 seconds), and it's what `/v1/chat/completions` returned. If one-bit is slower than that, the limit needs to change. `server.py`'s `ask_model` adds `enable_thinking`, and `/v1` doesn't: check Glimmer's template behaves.
6. **Turn the owner check on first.** `HARDWARE_GADGET_OWNER_CHECK` before `DEVICE_MCP_URL` or any real board reaches production.

## Small Llama on other devices

7. **A Raspberry Pi or other device.** Same as 3 to 5 with Llama 3.2 3B Q4_K_M. Proves: its kind comes out right and it answers.

## Training on the board

8. **Run `setup-train.sh` and one run on Llama 3.2 1B.** `train_model`, then `training_status`. Proves: it trains and converts. Nothing about this base has been measured on a board. The file is 2.47 GB, so `TRAIN_OVERHEAD_GIB` puts a run at about 3.5 GiB, against a real 2.3 GiB taken by the smaller model it replaced. Record peak memory, seconds per step, and whether `convert_lora_to_gguf.py` b11970 takes the adapter. Until then the product says it hasn't been measured. If it doesn't fit, show board training as not available: don't swap in a smaller non-Meta model.
9. **A board fine-tune on a drive.** `export_model` with the Llama license on it. The kit's new license files need `scripts/drive-kit.ts --upload` first. Earlier non-Meta runs on `jetson-02` can't go on a drive any more, by design.

## Robotics

10. **Real actuators don't exist in this code.** `server.py` has no robot tools. `robot_action` runs only in `sim_board.py`, and the gateway refuses every robot tool on a board that didn't report `simulated: true` at pairing. Before a real one: a physical cut-off the software can't override, a watchdog on the board that stops everything if the platform goes quiet, limits enforced on the board with each actuator's own numbers, and someone watching. Don't do this by flipping the simulated check.
11. **Check the hard stop on hardware.** Press it with the actuator running and time it. On a real board a stop that reaches only the platform isn't a stop, and the page tells the owner to cut power in that case.

## Fleet

12. **`jetson-infra`'s control plane has no TLS on the LAN**, so the fleet gateway can't be paired this way. docs/OFFLINE.md on tg-offline has the options. Not part of this.
