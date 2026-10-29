# Device Farm fixtures

`list-devices-android-phones.json` is the real `aws devicefarm list-devices` output for the owner's account (us-west-2, Oct 28, 2026), cut down to the 95 Android phones. Device ARNs are Device Farm's public device ARNs, not account data.

Facts read from the owner's account the same day, with `aws devicefarm get-account-settings`:

- **`memory` is storage, not RAM.** A 256 GB phone reports 256,000,000,000 bytes (238.4 GiB) and a 512 GB tablet 476.8 GiB. `heapSize` is the Java heap limit (488 MB on almost every phone). ListDevices has no RAM field, so never pick phones or files from `memory`.
- So choose by a table of known RAM per model from the makers' spec sheets, and have the kit confirm with `/proc/meminfo` on the phone before it downloads or loads a file, skipping a file that doesn't fit. From public specs: Pixel 9 Pro, 9 Pro XL, 10 Pro and 10 Pro XL have 16 GB; Pixel 8 Pro, 9 and 10 have 12 GB; the 256 GB Galaxy S24 Ultra and S25 Ultra have 12 GB and the 256 GB S23 Ultra has 8 GB. Pixel 11 Pro, 11 Pro XL and the Galaxy S26 phones are newer than our sources: probe them.
- Pixels use Google Tensor chips, not Snapdragon: no Adreno OpenCL and no Hexagon NPU, so the CPU backend is the one that counts there. The US Galaxy S23, S24 and S25 phones and the Xiaomi 12, 13 and 13 Pro are Snapdragon; the US S26 phones probably are too (check `ro.soc.model`).
- Billing: no unmetered slots (`unmeteredDevices` is 0 for Android and iOS), so runs are metered, but the account has a one-time trial: 1,000 minutes, 620.25 left. The max and default job timeout is 150 minutes. The project `base-android` already exists; ours is `muse-muse-devices`.
