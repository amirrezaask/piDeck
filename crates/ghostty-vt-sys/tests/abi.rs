use std::ffi::c_void;
use std::mem::{align_of, offset_of, size_of};
use std::ptr;

use ghostty_vt_sys as ffi;

unsafe extern "C" {
    fn yaade_abi_terminal_options_size() -> usize;
    fn yaade_abi_terminal_options_align() -> usize;
    fn yaade_abi_terminal_options_cols_offset() -> usize;
    fn yaade_abi_terminal_options_rows_offset() -> usize;
    fn yaade_abi_terminal_options_scrollback_offset() -> usize;
    fn yaade_abi_string_size() -> usize;
    fn yaade_abi_string_align() -> usize;
    fn yaade_abi_result_success() -> i32;
    fn yaade_abi_build_info_simd() -> u32;
    fn yaade_abi_build_info_version_build() -> u32;
}

#[test]
fn public_layout_and_discriminants_match_c() {
    // SAFETY: These verifier functions take no pointers and return C compile-time values.
    unsafe {
        assert_eq!(
            size_of::<ffi::TerminalOptions>(),
            yaade_abi_terminal_options_size()
        );
        assert_eq!(
            align_of::<ffi::TerminalOptions>(),
            yaade_abi_terminal_options_align()
        );
        assert_eq!(
            offset_of!(ffi::TerminalOptions, cols),
            yaade_abi_terminal_options_cols_offset()
        );
        assert_eq!(
            offset_of!(ffi::TerminalOptions, rows),
            yaade_abi_terminal_options_rows_offset()
        );
        assert_eq!(
            offset_of!(ffi::TerminalOptions, max_scrollback),
            yaade_abi_terminal_options_scrollback_offset()
        );
        assert_eq!(size_of::<ffi::String>(), yaade_abi_string_size());
        assert_eq!(align_of::<ffi::String>(), yaade_abi_string_align());
        assert_eq!(ffi::Result::SUCCESS, yaade_abi_result_success());
        assert_eq!(ffi::BuildInfo::SIMD, yaade_abi_build_info_simd());
        assert_eq!(
            ffi::BuildInfo::VERSION_BUILD,
            yaade_abi_build_info_version_build()
        );
    }
}

#[test]
fn build_info_identifies_the_pinned_non_simd_artifact() {
    let mut simd = true;
    // SAFETY: The output pointer matches the bool type documented for BUILD_INFO_SIMD.
    let result = unsafe {
        ffi::ghostty_build_info(
            ffi::BuildInfo::SIMD,
            ptr::from_mut(&mut simd).cast::<c_void>(),
        )
    };
    assert_eq!(result, ffi::Result::SUCCESS);
    assert!(!simd, "Plan 028 owns re-enabling and benchmarking SIMD");

    let mut revision = ffi::String::default();
    // SAFETY: The output pointer matches GhosttyString for VERSION_BUILD.
    let result = unsafe {
        ffi::ghostty_build_info(
            ffi::BuildInfo::VERSION_BUILD,
            ptr::from_mut(&mut revision).cast::<c_void>(),
        )
    };
    assert_eq!(result, ffi::Result::SUCCESS);
    // SAFETY: Build-info strings are immutable library-owned data valid for the process lifetime.
    let revision = unsafe { revision.to_str() };
    assert_eq!(revision, env!("YAADE_GHOSTTY_REVISION"));
}

#[test]
fn terminal_lifecycle_accepts_arbitrary_pty_bytes() {
    let inputs: [&[u8]; 5] = [
        b"",
        b"plain text\r\n",
        b"\x1b[31mred\x1b[0m",
        &[0xff, 0xfe, 0x00, 0x1b, b'['],
        b"\x1b]2;unterminated title",
    ];

    for iteration in 0..64 {
        let mut terminal: ffi::Terminal = ptr::null_mut();
        let options = ffi::TerminalOptions {
            cols: 80,
            rows: 24,
            max_scrollback: 10_000,
        };
        // SAFETY: terminal is a valid out-pointer, the default allocator is selected by NULL,
        // and options satisfy Ghostty's documented nonzero dimension requirements.
        let result = unsafe { ffi::ghostty_terminal_new(ptr::null(), &raw mut terminal, options) };
        assert_eq!(result, ffi::Result::SUCCESS);
        assert!(!terminal.is_null());

        for input in inputs {
            // SAFETY: The terminal is live and each byte slice remains valid for the call.
            unsafe { ffi::ghostty_terminal_vt_write(terminal, input.as_ptr(), input.len()) };
        }
        // SAFETY: The terminal is exclusively used by this test and dimensions are nonzero.
        let result = unsafe { ffi::ghostty_terminal_resize(terminal, 120, 40, 8, 16) };
        assert_eq!(result, ffi::Result::SUCCESS, "resize iteration {iteration}");
        // SAFETY: The terminal is live and exclusively owned.
        unsafe { ffi::ghostty_terminal_reset(terminal) };
        // SAFETY: This is the sole free of the live terminal handle.
        unsafe { ffi::ghostty_terminal_free(terminal) };
    }
}
