#!/bin/bash
# Builds llama-server for the arm64 Android emulator on the Mac lab box, for gguf_emu jobs (docs/NATIVE_LAB.md). One static
# file, from the same llama.cpp build glimmer-quantize uses. The owner runs it once; the agent offers gguf_emu when it's there.
set -euo pipefail
ROOT="${MUSE_LAB_ROOT:-$HOME/musemuse-lab}"
SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK_VERSION="27.2.12479018"
TAG="b11669"
SHA="e06ba4fa263e30fdb9f0e65f00a8965202ddaa0c51f548a67e1f9b2164d04efc"
OUT="$ROOT/tools/llama-android"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v cmake >/dev/null || brew install cmake
command -v ninja >/dev/null || brew install ninja
SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
[ -x "$SDKMANAGER" ] || SDKMANAGER="$(command -v sdkmanager)"
"$SDKMANAGER" --install "ndk;$NDK_VERSION"

curl -fsSL -o "$WORK/src.tar.gz" "https://github.com/ggml-org/llama.cpp/archive/refs/tags/$TAG.tar.gz"
echo "$SHA  $WORK/src.tar.gz" | shasum -a 256 -c -
tar -xzf "$WORK/src.tar.gz" -C "$WORK"
cmake -S "$WORK/llama.cpp-$TAG" -B "$WORK/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$SDK_ROOT/ndk/$NDK_VERSION/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
cmake --build "$WORK/build" --target llama-server
mkdir -p "$OUT"
cp "$WORK/build/bin/llama-server" "$OUT/llama-server"
echo "Built $OUT/llama-server. Restart the agent so it offers gguf_emu."
