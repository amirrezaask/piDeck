#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CORE_PACKAGE_DIR="${PACKAGE_DIR}/../ghostty-core"
VENDOR_DIR="${CORE_PACKAGE_DIR}/src/vendor"
COMPAT_VENDOR_DIR="${PACKAGE_DIR}/src/vendor"
REVISION_FILE="${VENDOR_DIR}/VERSION"
PREPARE_SCRIPT="${PACKAGE_DIR}/../../scripts/prepare-ghostty-source.mjs"
PREPARED_JSON="$(node "${PREPARE_SCRIPT}" prepare --json)"
GHOSTTY_REVISION="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.revision)' "${PREPARED_JSON}")"
GHOSTTY_SOURCE_DIR="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.source)' "${PREPARED_JSON}")"
GHOSTTY_ZIG="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.zig)' "${PREPARED_JSON}")"
GHOSTTY_ZIG_GLOBAL_CACHE_DIR="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.zigGlobalCache)' "${PREPARED_JSON}")"

log() {
  printf '[ghostty-vt-wasm] %s\n' "$*"
}

build_root="$(mktemp -d)"
trap 'rm -rf "${build_root}"' EXIT

log "building ${GHOSTTY_REVISION} for wasm32-freestanding"
(
  cd "${GHOSTTY_SOURCE_DIR}"
  "${GHOSTTY_ZIG}" build \
    -Demit-lib-vt \
    -Dtarget=wasm32-freestanding \
    -Doptimize=ReleaseSmall \
    -Dstrip=true \
    -Dlib-version-string="0.1.0-dev+${GHOSTTY_REVISION}" \
    --global-cache-dir "${GHOSTTY_ZIG_GLOBAL_CACHE_DIR}" \
    --system "${GHOSTTY_ZIG_GLOBAL_CACHE_DIR}/p" \
    -p "${build_root}"
)

mkdir -p "${VENDOR_DIR}" "${COMPAT_VENDOR_DIR}"
cp "${build_root}/bin/ghostty-vt.wasm" "${VENDOR_DIR}/ghostty-vt.wasm"
cp "${VENDOR_DIR}/VERSION" "${COMPAT_VENDOR_DIR}/VERSION"
cp "${VENDOR_DIR}/ghostty-vt.wasm" "${COMPAT_VENDOR_DIR}/ghostty-vt.wasm"
"${GHOSTTY_ZIG}" build-exe \
  "${SCRIPT_DIR}/ghostty-write-pty.zig" \
  -target wasm32-freestanding \
  -O ReleaseSmall \
  -fno-entry \
  -rdynamic \
  -femit-bin="${VENDOR_DIR}/ghostty-write-pty.wasm"
cp "${VENDOR_DIR}/ghostty-write-pty.wasm" "${COMPAT_VENDOR_DIR}/ghostty-write-pty.wasm"
chmod 0644 "${VENDOR_DIR}/ghostty-vt.wasm" "${VENDOR_DIR}/ghostty-write-pty.wasm" \
  "${COMPAT_VENDOR_DIR}/ghostty-vt.wasm" "${COMPAT_VENDOR_DIR}/ghostty-write-pty.wasm"
log "wrote ${VENDOR_DIR}/ghostty-vt.wasm"
