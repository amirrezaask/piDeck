use std::io::Write;
use std::ptr::{self, NonNull};

use ghostty_vt_sys as ffi;

use crate::error::invalid;
use crate::ffi_util::{abi_violation, ffi_result, sized};
use crate::{AbiViolation, GhosttyError, Operation, Terminal, ValueField};

/// Hard maximum accepted by [`Terminal::format_into`].
pub const MAX_FORMAT_BYTES: usize = 16 * 1024 * 1024;

/// Terminal formatter output encoding.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Format {
    /// Plain text without terminal escape sequences.
    #[default]
    Plain,
    /// VT text preserving styles and terminal state.
    Vt,
    /// HTML with inline styles.
    Html,
}

impl Format {
    fn as_ffi(self) -> ffi::FormatterFormat::Type {
        match self {
            Self::Plain => ffi::FormatterFormat::PLAIN,
            Self::Vt => ffi::FormatterFormat::VT,
            Self::Html => ffi::FormatterFormat::HTML,
        }
    }
}

/// Screen-level state included in styled formatter output.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FormatScreenExtras {
    /// Emit cursor position.
    pub cursor: bool,
    /// Emit the active text style.
    pub style: bool,
    /// Emit active hyperlink state.
    pub hyperlink: bool,
    /// Emit character protection mode.
    pub protection: bool,
    /// Emit Kitty keyboard protocol state.
    pub kitty_keyboard: bool,
    /// Emit character-set state.
    pub charsets: bool,
}

/// Terminal-level state included in styled formatter output.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FormatExtras {
    /// Emit the palette.
    pub palette: bool,
    /// Emit modes that differ from defaults.
    pub modes: bool,
    /// Emit scrolling regions.
    pub scrolling_region: bool,
    /// Emit tab stops.
    pub tabstops: bool,
    /// Emit the working directory.
    pub working_directory: bool,
    /// Emit keyboard modes.
    pub keyboard: bool,
    /// Screen-level extras.
    pub screen: FormatScreenExtras,
}

/// Options for bounded terminal formatting.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FormatOptions {
    /// Output encoding.
    pub format: Format,
    /// Join soft-wrapped rows.
    pub unwrap: bool,
    /// Trim trailing whitespace from non-blank rows.
    pub trim: bool,
    /// Additional state for styled output.
    pub extras: FormatExtras,
}

struct FormatterGuard(NonNull<ffi::FormatterImpl>);

impl FormatterGuard {
    fn new(terminal: ffi::Terminal, options: FormatOptions) -> Result<Self, GhosttyError> {
        let mut screen: ffi::FormatterScreenExtra = sized();
        screen.cursor = options.extras.screen.cursor;
        screen.style = options.extras.screen.style;
        screen.hyperlink = options.extras.screen.hyperlink;
        screen.protection = options.extras.screen.protection;
        screen.kitty_keyboard = options.extras.screen.kitty_keyboard;
        screen.charsets = options.extras.screen.charsets;

        let mut extras: ffi::FormatterTerminalExtra = sized();
        extras.palette = options.extras.palette;
        extras.modes = options.extras.modes;
        extras.scrolling_region = options.extras.scrolling_region;
        extras.tabstops = options.extras.tabstops;
        extras.pwd = options.extras.working_directory;
        extras.keyboard = options.extras.keyboard;
        extras.screen = screen;

        let mut raw_options: ffi::FormatterTerminalOptions = sized();
        raw_options.emit = options.format.as_ffi();
        raw_options.unwrap = options.unwrap;
        raw_options.trim = options.trim;
        raw_options.extra = extras;
        raw_options.selection = ptr::null();

        let mut raw = ptr::null_mut();
        // SAFETY: The terminal is live and exclusively borrowed by the caller;
        // options are checked public sized structs with no retained Rust pointer
        // except the terminal itself. Null selects the default allocator.
        let result = unsafe {
            ffi::ghostty_formatter_terminal_new(ptr::null(), &mut raw, terminal, raw_options)
        };
        ffi_result(result, Operation::FormatterNew)?;
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| abi_violation(Operation::FormatterNew, AbiViolation::NullData))
    }

    fn as_ptr(&self) -> ffi::Formatter {
        self.0.as_ptr()
    }
}

impl Drop for FormatterGuard {
    fn drop(&mut self) {
        // SAFETY: This guard uniquely owns the formatter and frees it exactly
        // once before its borrowed terminal can be mutated or dropped.
        unsafe { ffi::ghostty_formatter_free(self.as_ptr()) };
    }
}

impl Terminal {
    /// Format the active screen into a bounded [`Write`] sink.
    ///
    /// Ghostty first reports the required byte count. Output larger than
    /// `max_bytes` is rejected before allocation or sink IO. The wrapper reuses
    /// one scratch buffer across calls and frees the native formatter through
    /// RAII on every success and error path.
    pub fn format_into(
        &mut self,
        options: FormatOptions,
        max_bytes: usize,
        sink: &mut impl Write,
    ) -> Result<usize, GhosttyError> {
        if max_bytes > MAX_FORMAT_BYTES {
            return Err(invalid(ValueField::FormatterLimit));
        }
        let formatter = FormatterGuard::new(self.raw_ptr(), options)?;
        let mut required = 0usize;
        // SAFETY: The formatter is live and borrows the live terminal. Null with
        // zero capacity is the documented size query and `required` is writable.
        let query = unsafe {
            ffi::ghostty_formatter_format_buf(formatter.as_ptr(), ptr::null_mut(), 0, &mut required)
        };
        if query != ffi::Result::OUT_OF_SPACE && query != ffi::Result::SUCCESS {
            ffi_result(query, Operation::FormatterWrite)?;
        }
        if required > max_bytes {
            return Err(GhosttyError::OutOfSpace {
                operation: Operation::FormatterWrite,
                required,
                limit: max_bytes,
            });
        }
        if required == 0 {
            return Ok(0);
        }

        self.formatter_scratch.resize(required, 0);
        let mut written = 0usize;
        // SAFETY: The formatter and terminal remain live and unmutated. Scratch
        // is writable for exactly `required` bytes and `written` is a valid out.
        let result = unsafe {
            ffi::ghostty_formatter_format_buf(
                formatter.as_ptr(),
                self.formatter_scratch.as_mut_ptr(),
                self.formatter_scratch.len(),
                &mut written,
            )
        };
        if result == ffi::Result::OUT_OF_SPACE {
            return Err(GhosttyError::OutOfSpace {
                operation: Operation::FormatterWrite,
                required: written,
                limit: max_bytes,
            });
        }
        ffi_result(result, Operation::FormatterWrite)?;
        if written > self.formatter_scratch.len() {
            return Err(abi_violation(
                Operation::FormatterWrite,
                AbiViolation::InvalidLength,
            ));
        }
        drop(formatter);
        sink.write_all(&self.formatter_scratch[..written])
            .map_err(|error| GhosttyError::Sink { kind: error.kind() })?;
        Ok(written)
    }
}
