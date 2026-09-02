#include <stddef.h>
#include <stdint.h>
#include <ghostty/vt.h>

size_t yaade_abi_terminal_options_size(void) {
  return sizeof(GhosttyTerminalOptions);
}

size_t yaade_abi_terminal_options_align(void) {
  struct AlignProbe {
    char byte;
    GhosttyTerminalOptions value;
  };
  return offsetof(struct AlignProbe, value);
}

size_t yaade_abi_terminal_options_cols_offset(void) {
  return offsetof(GhosttyTerminalOptions, cols);
}

size_t yaade_abi_terminal_options_rows_offset(void) {
  return offsetof(GhosttyTerminalOptions, rows);
}

size_t yaade_abi_terminal_options_scrollback_offset(void) {
  return offsetof(GhosttyTerminalOptions, max_scrollback);
}

size_t yaade_abi_string_size(void) {
  return sizeof(GhosttyString);
}

size_t yaade_abi_string_align(void) {
  struct AlignProbe {
    char byte;
    GhosttyString value;
  };
  return offsetof(struct AlignProbe, value);
}

int32_t yaade_abi_result_success(void) {
  return (int32_t)GHOSTTY_SUCCESS;
}

uint32_t yaade_abi_build_info_simd(void) {
  return (uint32_t)GHOSTTY_BUILD_INFO_SIMD;
}

uint32_t yaade_abi_build_info_version_build(void) {
  return (uint32_t)GHOSTTY_BUILD_INFO_VERSION_BUILD;
}
