#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v rustup >/dev/null 2>&1 || ! rustc +nightly --version >/dev/null 2>&1; then
  echo "ghostty-vt sanitizers require an installed nightly Rust toolchain" >&2
  exit 2
fi

target="$(rustc +nightly -vV | awk '/^host:/ { print $2 }')"
requested="${1:-all}"

supports() {
  local sanitizer="$1"
  printf 'fn main() {}\n' | rustc +nightly \
    -Zsanitizer="$sanitizer" \
    --target "$target" \
    --crate-name ghostty_vt_sanitizer_probe \
    --emit=metadata \
    -o "${TMPDIR:-/tmp}/ghostty-vt-${sanitizer}-probe.rmeta" \
    - >/dev/null 2>&1
}

run_sanitizer() {
  local sanitizer="$1"
  if ! supports "$sanitizer"; then
    echo "[ghostty-vt] SKIP: $sanitizer sanitizer is unsupported for $target"
    return 0
  fi
  echo "[ghostty-vt] running $sanitizer sanitizer for $target"
  CARGO_TARGET_DIR="target/sanitizer-$sanitizer" \
    RUSTFLAGS="-Zsanitizer=$sanitizer" \
    cargo +nightly test \
      --target "$target" \
      --manifest-path Cargo.toml \
      --lib
}

run_address_with_leaks() {
  if ! supports address; then
    echo "[ghostty-vt] SKIP: address/leak checks are unsupported for $target"
    return 0
  fi
  echo "[ghostty-vt] running address sanitizer with leak detection for $target"
  ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=1:halt_on_error=1}" \
    CARGO_TARGET_DIR="target/sanitizer-address" \
    RUSTFLAGS="-Zsanitizer=address" \
    cargo +nightly test \
      --target "$target" \
      --manifest-path Cargo.toml \
      --lib
}

case "$requested" in
  address)
    run_sanitizer address
    ;;
  leak)
    if supports leak; then
      run_sanitizer leak
    else
      run_address_with_leaks
    fi
    ;;
  undefined)
    # rustc has no UndefinedBehaviorSanitizer mode. ReleaseSafe native builds
    # retain Zig runtime safety; this explicit skip prevents a false claim.
    echo "[ghostty-vt] SKIP: rustc does not expose UndefinedBehaviorSanitizer"
    ;;
  all)
    run_address_with_leaks
    if supports leak; then
      run_sanitizer leak
    fi
    echo "[ghostty-vt] SKIP: rustc does not expose UndefinedBehaviorSanitizer"
    ;;
  *)
    echo "usage: $0 [all|address|leak|undefined]" >&2
    exit 2
    ;;
esac
