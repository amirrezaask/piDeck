#include <stddef.h>
#include <stdint.h>
#include <ghostty/vt.h>

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

int32_t yaade_abi_build_info_simd(void) {
  return (int32_t)GHOSTTY_BUILD_INFO_SIMD;
}

int32_t yaade_abi_build_info_version_build(void) {
  return (int32_t)GHOSTTY_BUILD_INFO_VERSION_BUILD;
}
