use std::ffi::c_void;
use std::marker::PhantomData;
use std::pin::Pin;
use std::ptr::{self, NonNull};
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use ghostty_vt_sys as ffi;

use crate::effects::{CallbackState, register_callbacks};
use crate::error::invalid;
use crate::ffi_util::{abi_violation, ffi_result};
use crate::render::RenderResources;
use crate::{
    AbiViolation, EffectOptions, GhosttyError, Operation, RenderView, Rgb, TerminalEffects,
    TerminalPoint, TerminalSize, TerminalText, TextField, TrackedGridRef, ValueField,
};

/// Maximum scrollback accepted by one native terminal.
pub const MAX_SCROLLBACK_ROWS: usize = 1_000_000;
/// Maximum APC payload retained by Ghostty's stream parser.
pub const MAX_APC_BYTES: usize = 1024 * 1024;

static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static PROCESS_INITIALIZATION: OnceLock<Result<(), GhosttyError>> = OnceLock::new();

/// Construction options for a thread-confined terminal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalOptions {
    /// Initial columns. Must fit `u16` and be non-zero.
    pub cols: usize,
    /// Initial rows. Must fit `u16` and be non-zero.
    pub rows: usize,
    /// Maximum retained native scrollback rows.
    pub scrollback: usize,
    /// Bounded synchronous callback configuration.
    pub effects: EffectOptions,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            scrollback: 10_000,
            effects: EffectOptions::default(),
        }
    }
}

/// ANSI or DEC-private terminal mode packed through the public ABI contract.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Mode(u16);

impl Mode {
    /// Cursor-key application mode (DEC 1).
    pub const APPLICATION_CURSOR_KEYS: Self = Self(1);
    /// Alternate-screen mode (DEC 1047).
    pub const ALTERNATE_SCREEN: Self = Self(1047);
    /// Bracketed-paste mode (DEC 2004).
    pub const BRACKETED_PASTE: Self = Self(2004);
    /// Synchronized-output mode (DEC 2026).
    pub const SYNCHRONIZED_OUTPUT: Self = Self(2026);
    /// In-band resize reports (DEC 2048).
    pub const IN_BAND_RESIZE: Self = Self(2048);
    /// ANSI insert mode (ANSI 4).
    pub const INSERT: Self = Self(0x8000 | 4);

    /// Construct a checked mode.
    pub fn new(value: u16, ansi: bool) -> Result<Self, GhosttyError> {
        if value > 0x7fff {
            return Err(invalid(ValueField::Mode));
        }
        Ok(Self(value | (u16::from(ansi) << 15)))
    }

    /// Numeric mode value without its ANSI flag.
    #[must_use]
    pub const fn value(self) -> u16 {
        self.0 & 0x7fff
    }

    /// Whether this is an ANSI mode rather than a DEC-private mode.
    #[must_use]
    pub const fn is_ansi(self) -> bool {
        self.0 & 0x8000 != 0
    }

    pub(crate) const fn as_ffi(self) -> ffi::Mode {
        self.0
    }
}

/// Active terminal screen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveScreen {
    /// Primary screen with scrollback.
    Primary,
    /// Alternate screen.
    Alternate,
}

/// Scrollbar metadata for the active screen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScrollbarState {
    /// Total rows in the scrollable area.
    pub total: u64,
    /// Current viewport offset.
    pub offset: u64,
    /// Visible row count.
    pub length: u64,
}

/// Effective terminal colors copied from public getters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalColors {
    /// Effective foreground, when configured.
    pub foreground: Option<Rgb>,
    /// Effective background, when configured.
    pub background: Option<Rgb>,
    /// Effective cursor color, when configured.
    pub cursor: Option<Rgb>,
    /// Effective 256-color palette.
    pub palette: [Rgb; 256],
}

/// Owned snapshot of public terminal state.
///
/// This is observation data, not serializable parser state and not a
/// checkpoint. Plan 024 owns checkpoint feasibility.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalState {
    /// Columns in cells.
    pub columns: u16,
    /// Rows in cells.
    pub rows: u16,
    /// Cursor column in the active area.
    pub cursor_column: u16,
    /// Cursor row in the active area.
    pub cursor_row: u16,
    /// Whether the next print will soft-wrap.
    pub cursor_pending_wrap: bool,
    /// Whether terminal modes make the cursor visible.
    pub cursor_visible: bool,
    /// Active screen.
    pub active_screen: ActiveScreen,
    /// Whether the active screen is the alternate screen.
    pub alternate_screen: bool,
    /// Total rows including native scrollback.
    pub total_rows: usize,
    /// Native scrollback rows.
    pub scrollback_rows: usize,
    /// Width in pixels.
    pub width_pixels: u32,
    /// Height in pixels.
    pub height_pixels: u32,
    /// Whether the viewport follows the active area.
    pub viewport_active: bool,
    /// Current Kitty keyboard protocol flags.
    pub kitty_keyboard_flags: u8,
    /// Scrollbar metadata.
    pub scrollbar: ScrollbarState,
    /// Copied title bytes.
    pub title: TerminalText,
    /// Copied working-directory bytes.
    pub working_directory: TerminalText,
    /// Effective colors and palette.
    pub colors: TerminalColors,
}

struct RawTerminal(NonNull<ffi::TerminalImpl>);

impl RawTerminal {
    fn new(options: ffi::TerminalOptions) -> Result<Self, GhosttyError> {
        let mut raw = ptr::null_mut();
        // SAFETY: `raw` is a valid out-pointer, null consistently selects the
        // process-default allocator, and all dimensions were checked before C.
        let result = unsafe { ffi::ghostty_terminal_new(ptr::null(), &mut raw, options) };
        ffi_result(result, Operation::TerminalNew)?;
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| abi_violation(Operation::TerminalNew, AbiViolation::NullData))
    }

    fn as_ptr(&self) -> ffi::Terminal {
        self.0.as_ptr()
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the live terminal and frees it
        // exactly once while its pinned callback userdata still exists.
        unsafe { ffi::ghostty_terminal_free(self.as_ptr()) };
    }
}

/// Safe, thread-confined owner of one native Ghostty terminal.
///
/// `Terminal` is intentionally `!Send + !Sync`. Every mutation requires
/// `&mut self`; native callbacks can only fill a pinned, bounded outbox. PTY
/// response bytes become visible through [`TerminalEffects`] after the native
/// write or resize call has returned.
pub struct Terminal {
    // Declaration order is intentional: render resources, then terminal, then
    // callback userdata. This gives deterministic native destruction order.
    pub(crate) render: RenderResources,
    raw: RawTerminal,
    callbacks: Pin<Box<CallbackState>>,
    pub(crate) formatter_scratch: Vec<u8>,
    id: u64,
    _thread_confined: PhantomData<Rc<()>>,
}

impl Terminal {
    /// Create a terminal and all reusable render resources.
    ///
    /// The linked build revision is checked once per process. Partial native
    /// construction is guarded by private RAII owners, so every successful C
    /// allocation is released if a later step fails.
    pub fn new(options: TerminalOptions) -> Result<Self, GhosttyError> {
        initialize_process()?;
        let cols = checked_dimension(options.cols, ValueField::Columns)?;
        let rows = checked_dimension(options.rows, ValueField::Rows)?;
        if options.scrollback > MAX_SCROLLBACK_ROWS {
            return Err(invalid(ValueField::Scrollback));
        }

        let mut callbacks = Box::pin(CallbackState::new(options.effects)?);
        let raw = RawTerminal::new(ffi::TerminalOptions {
            cols,
            rows,
            max_scrollback: options.scrollback,
        })?;
        let callback_state = CallbackState::pinned_mut(callbacks.as_mut());
        callback_state.bind_terminal(raw.as_ptr());
        let state_ptr = ptr::from_mut(callback_state);
        register_callbacks(raw.as_ptr(), state_ptr)?;

        let apc_limit = MAX_APC_BYTES;
        // SAFETY: The terminal is live and exclusively initializing;
        // `apc_limit` has the exact checked public option type and is copied.
        let result = unsafe {
            ffi::ghostty_terminal_set(
                raw.as_ptr(),
                ffi::TerminalOption::APC_MAX_BYTES,
                ptr::from_ref(&apc_limit).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::TerminalSet)?;

        let render = RenderResources::new()?;
        Ok(Self {
            render,
            raw,
            callbacks,
            formatter_scratch: Vec::new(),
            id: next_terminal_id(),
            _thread_confined: PhantomData,
        })
    }

    /// Process arbitrary PTY bytes and return bounded effects.
    ///
    /// Native callbacks run synchronously, but only copy into preallocated
    /// storage. This method does not invoke host code or write to a PTY. The
    /// returned outbox is created only after `ghostty_terminal_vt_write`
    /// returns and borrows `self`, preventing reentrant terminal mutation.
    pub fn write(&mut self, bytes: &[u8]) -> Result<TerminalEffects<'_>, GhosttyError> {
        self.callback_mut().prepare();
        // SAFETY: The terminal is live and exclusively borrowed. `bytes` is
        // readable for `len` for the complete synchronous call. Pinned callback
        // userdata and all registered function pointers remain valid.
        unsafe { ffi::ghostty_terminal_vt_write(self.raw.as_ptr(), bytes.as_ptr(), bytes.len()) };
        self.finish_effects()
    }

    /// Resize cell and pixel geometry and return any in-band resize response.
    ///
    /// Ghostty may synchronously invoke write-PTY when mode 2048 is enabled.
    /// Those bytes are staged exactly like write effects and are inaccessible
    /// until the native resize returns.
    pub fn resize(
        &mut self,
        cols: usize,
        rows: usize,
        cell_width: usize,
        cell_height: usize,
    ) -> Result<TerminalEffects<'_>, GhosttyError> {
        let cols = checked_dimension(cols, ValueField::Columns)?;
        let rows = checked_dimension(rows, ValueField::Rows)?;
        let cell_width = checked_pixel(cell_width, ValueField::CellWidth)?;
        let cell_height = checked_pixel(cell_height, ValueField::CellHeight)?;
        self.callback_mut().prepare();
        // SAFETY: The terminal is live and exclusive, all Rust integers were
        // checked before narrowing, and pinned callback userdata stays valid.
        let result = unsafe {
            ffi::ghostty_terminal_resize(self.raw.as_ptr(), cols, rows, cell_width, cell_height)
        };
        ffi_result(result, Operation::TerminalResize)?;
        self.callback_mut().set_size(TerminalSize {
            rows,
            columns: cols,
            cell_width,
            cell_height,
        });
        self.finish_effects()
    }

    /// Perform an infallible full terminal reset while preserving dimensions.
    pub fn reset(&mut self) {
        self.callback_mut().prepare();
        // SAFETY: The terminal is live, exclusively borrowed, and no render,
        // formatter, or effect borrow exists during this mutating call.
        unsafe { ffi::ghostty_terminal_reset(self.raw.as_ptr()) };
    }

    /// Read one checked ANSI or DEC-private mode.
    pub fn mode(&self, mode: Mode) -> Result<bool, GhosttyError> {
        let mut output = false;
        // SAFETY: The terminal is live, `mode` is constructible only through
        // the checked packed representation, and output storage is valid.
        let result = unsafe {
            ffi::ghostty_terminal_mode_get(self.raw.as_ptr(), mode.as_ffi(), &mut output)
        };
        ffi_result(result, Operation::TerminalMode)?;
        Ok(output)
    }

    /// Set one checked ANSI or DEC-private mode.
    pub fn set_mode(&mut self, mode: Mode, enabled: bool) -> Result<(), GhosttyError> {
        // SAFETY: The terminal is live and exclusive, `mode` is checked, and
        // this native mutation stores no borrowed Rust memory.
        let result =
            unsafe { ffi::ghostty_terminal_mode_set(self.raw.as_ptr(), mode.as_ffi(), enabled) };
        ffi_result(result, Operation::TerminalMode)
    }

    /// Set whether DECSCUSR reset returns to a blinking cursor.
    pub fn set_default_cursor_blink(&mut self, blinking: bool) -> Result<(), GhosttyError> {
        // SAFETY: The terminal is live and exclusive, and Ghostty copies the
        // checked boolean during this call.
        let result = unsafe {
            ffi::ghostty_terminal_set(
                self.raw.as_ptr(),
                ffi::TerminalOption::DEFAULT_CURSOR_BLINK,
                ptr::from_ref(&blinking).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::TerminalSet)
    }

    /// Set default foreground, background, and cursor colors.
    pub fn set_default_colors(
        &mut self,
        foreground: Option<Rgb>,
        background: Option<Rgb>,
        cursor: Option<Rgb>,
    ) -> Result<(), GhosttyError> {
        self.set_optional_color(ffi::TerminalOption::COLOR_FOREGROUND, foreground)?;
        self.set_optional_color(ffi::TerminalOption::COLOR_BACKGROUND, background)?;
        self.set_optional_color(ffi::TerminalOption::COLOR_CURSOR, cursor)
    }

    /// Replace the default 256-color palette or restore Ghostty's built-in palette.
    pub fn set_default_palette(
        &mut self,
        palette: Option<&[Rgb; 256]>,
    ) -> Result<(), GhosttyError> {
        let ffi_palette: Option<[ffi::ColorRgb; 256]> =
            palette.map(|values| values.map(Into::into));
        let value = ffi_palette
            .as_ref()
            .map_or(ptr::null(), |values| values.as_ptr().cast::<c_void>());
        // SAFETY: The terminal is live and exclusive. The optional array has
        // exactly 256 checked RGB entries and Ghostty copies it during the call.
        let result = unsafe {
            ffi::ghostty_terminal_set(self.raw.as_ptr(), ffi::TerminalOption::COLOR_PALETTE, value)
        };
        ffi_result(result, Operation::TerminalSet)
    }

    /// Set terminal title bytes, bounded by the configured effect text limit.
    pub fn set_title(&mut self, title: &[u8]) -> Result<(), GhosttyError> {
        self.set_text(
            ffi::TerminalOption::TITLE,
            title,
            ValueField::EffectTextBytes,
        )
    }

    /// Set working-directory bytes, bounded by the configured effect text limit.
    pub fn set_working_directory(&mut self, pwd: &[u8]) -> Result<(), GhosttyError> {
        self.set_text(ffi::TerminalOption::PWD, pwd, ValueField::EffectTextBytes)
    }

    /// Scroll the viewport by a signed row delta.
    pub fn scroll_viewport(&mut self, delta: isize) {
        let mut value = ffi::TerminalScrollViewportValue::default();
        value.delta = delta;
        let behavior = ffi::TerminalScrollViewport {
            tag: ffi::TerminalScrollViewportTag::DELTA,
            value,
        };
        // SAFETY: The terminal is live and exclusive, and the tagged union's
        // active `delta` field matches its checked public tag.
        unsafe { ffi::ghostty_terminal_scroll_viewport(self.raw.as_ptr(), behavior) };
    }

    /// Scroll the viewport to the oldest retained row.
    pub fn scroll_viewport_top(&mut self) {
        self.scroll_to(ffi::TerminalScrollViewportTag::TOP);
    }

    /// Scroll the viewport to the active terminal area.
    pub fn scroll_viewport_bottom(&mut self) {
        self.scroll_to(ffi::TerminalScrollViewportTag::BOTTOM);
    }

    /// Copy public terminal state into owned Rust values.
    pub fn state(&self) -> Result<TerminalState, GhosttyError> {
        let screen_raw: ffi::TerminalScreen::Type = self.get(ffi::TerminalData::ACTIVE_SCREEN)?;
        let active_screen = match screen_raw {
            ffi::TerminalScreen::PRIMARY => ActiveScreen::Primary,
            ffi::TerminalScreen::ALTERNATE => ActiveScreen::Alternate,
            _ => {
                return Err(abi_violation(
                    Operation::TerminalGet,
                    AbiViolation::UnknownDiscriminant,
                ));
            }
        };
        let scrollbar: ffi::TerminalScrollbar = self.get(ffi::TerminalData::SCROLLBAR)?;
        let foreground = self.get_optional_color(ffi::TerminalData::COLOR_FOREGROUND)?;
        let background = self.get_optional_color(ffi::TerminalData::COLOR_BACKGROUND)?;
        let cursor = self.get_optional_color(ffi::TerminalData::COLOR_CURSOR)?;
        let mut palette_raw = [ffi::ColorRgb::default(); 256];
        self.get_into(ffi::TerminalData::COLOR_PALETTE, &mut palette_raw)?;
        Ok(TerminalState {
            columns: self.get(ffi::TerminalData::COLS)?,
            rows: self.get(ffi::TerminalData::ROWS)?,
            cursor_column: self.get(ffi::TerminalData::CURSOR_X)?,
            cursor_row: self.get(ffi::TerminalData::CURSOR_Y)?,
            cursor_pending_wrap: self.get(ffi::TerminalData::CURSOR_PENDING_WRAP)?,
            cursor_visible: self.get(ffi::TerminalData::CURSOR_VISIBLE)?,
            active_screen,
            alternate_screen: active_screen == ActiveScreen::Alternate,
            total_rows: self.get(ffi::TerminalData::TOTAL_ROWS)?,
            scrollback_rows: self.get(ffi::TerminalData::SCROLLBACK_ROWS)?,
            width_pixels: self.get(ffi::TerminalData::WIDTH_PX)?,
            height_pixels: self.get(ffi::TerminalData::HEIGHT_PX)?,
            viewport_active: self.get(ffi::TerminalData::VIEWPORT_ACTIVE)?,
            kitty_keyboard_flags: self.get(ffi::TerminalData::KITTY_KEYBOARD_FLAGS)?,
            scrollbar: ScrollbarState {
                total: scrollbar.total,
                offset: scrollbar.offset,
                length: scrollbar.len,
            },
            title: TerminalText::new(
                self.copy_terminal_text(ffi::TerminalData::TITLE)?,
                TextField::Title,
            ),
            working_directory: TerminalText::new(
                self.copy_terminal_text(ffi::TerminalData::PWD)?,
                TextField::WorkingDirectory,
            ),
            colors: TerminalColors {
                foreground,
                background,
                cursor,
                palette: palette_raw.map(Into::into),
            },
        })
    }

    /// Update and traverse a render state without exposing stale native borrows.
    ///
    /// The closure result cannot borrow the render view. While the closure runs,
    /// its exclusive terminal borrow prevents write, resize, reset, and release.
    pub fn with_render_state<R>(
        &mut self,
        visit: impl FnOnce(&mut RenderView<'_>) -> Result<R, GhosttyError>,
    ) -> Result<R, GhosttyError> {
        self.render.update(self.raw.as_ptr())?;
        let mut view = self.render.view()?;
        visit(&mut view)
    }

    /// Create an owned reference that tracks one grid cell across mutations.
    pub fn track_point(&mut self, point: TerminalPoint) -> Result<TrackedGridRef, GhosttyError> {
        TrackedGridRef::new(self.raw.as_ptr(), self.id, point)
    }

    pub(crate) fn raw_ptr(&self) -> ffi::Terminal {
        self.raw.as_ptr()
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    fn callback_mut(&mut self) -> &mut CallbackState {
        CallbackState::pinned_mut(self.callbacks.as_mut())
    }

    fn finish_effects(&mut self) -> Result<TerminalEffects<'_>, GhosttyError> {
        if self.callbacks.as_ref().get_ref().title_is_dirty() {
            let raw: ffi::String = self.get(ffi::TerminalData::TITLE)?;
            let bytes = ffi_string_bytes(raw, &self.raw, Operation::TerminalGet)?;
            CallbackState::pinned_mut(self.callbacks.as_mut()).copy_title(bytes);
        }
        if self.callbacks.as_ref().get_ref().pwd_is_dirty() {
            let raw: ffi::String = self.get(ffi::TerminalData::PWD)?;
            let bytes = ffi_string_bytes(raw, &self.raw, Operation::TerminalGet)?;
            CallbackState::pinned_mut(self.callbacks.as_mut()).copy_pwd(bytes);
        }
        self.callbacks.as_ref().get_ref().finish()
    }

    fn set_optional_color(
        &mut self,
        option: ffi::TerminalOption::Type,
        color: Option<Rgb>,
    ) -> Result<(), GhosttyError> {
        let color = color.map(Into::<ffi::ColorRgb>::into);
        let value = color
            .as_ref()
            .map_or(ptr::null(), |value| ptr::from_ref(value).cast::<c_void>());
        // SAFETY: The terminal is live and exclusive. The optional value has the
        // exact checked RGB type and is copied before this call returns.
        let result = unsafe { ffi::ghostty_terminal_set(self.raw.as_ptr(), option, value) };
        ffi_result(result, Operation::TerminalSet)
    }

    fn set_text(
        &mut self,
        option: ffi::TerminalOption::Type,
        bytes: &[u8],
        field: ValueField,
    ) -> Result<(), GhosttyError> {
        if bytes.len() > self.callbacks.as_ref().get_ref().text_limit() {
            return Err(invalid(field));
        }
        let value = ffi::String {
            ptr: bytes.as_ptr(),
            len: bytes.len(),
        };
        // SAFETY: The terminal is live and exclusive. `value` points to readable
        // bytes for the call and Ghostty copies the string before returning.
        let result = unsafe {
            ffi::ghostty_terminal_set(
                self.raw.as_ptr(),
                option,
                ptr::from_ref(&value).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::TerminalSet)
    }

    fn scroll_to(&mut self, tag: ffi::TerminalScrollViewportTag::Type) {
        let behavior = ffi::TerminalScrollViewport {
            tag,
            value: ffi::TerminalScrollViewportValue::default(),
        };
        // SAFETY: The terminal is live and exclusive. TOP/BOTTOM ignore the
        // zeroed union value under the checked public tagged-union contract.
        unsafe { ffi::ghostty_terminal_scroll_viewport(self.raw.as_ptr(), behavior) };
    }

    fn get<T: Default>(&self, data: ffi::TerminalData::Type) -> Result<T, GhosttyError> {
        let mut output = T::default();
        self.get_into(data, &mut output)?;
        Ok(output)
    }

    fn get_into<T>(
        &self,
        data: ffi::TerminalData::Type,
        output: &mut T,
    ) -> Result<(), GhosttyError> {
        // SAFETY: Every private call site pairs a checked TerminalData key with
        // its exact documented output type. The live terminal is not mutated.
        let result = unsafe {
            ffi::ghostty_terminal_get(
                self.raw.as_ptr(),
                data,
                ptr::from_mut(output).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::TerminalGet)
    }

    fn get_optional_color(
        &self,
        data: ffi::TerminalData::Type,
    ) -> Result<Option<Rgb>, GhosttyError> {
        let mut output = ffi::ColorRgb::default();
        // SAFETY: The key is one of the checked optional color getters and the
        // output has the exact public RGB type.
        let result = unsafe {
            ffi::ghostty_terminal_get(
                self.raw.as_ptr(),
                data,
                ptr::from_mut(&mut output).cast::<c_void>(),
            )
        };
        match result {
            ffi::Result::SUCCESS => Ok(Some(output.into())),
            ffi::Result::NO_VALUE => Ok(None),
            other => {
                ffi_result(other, Operation::TerminalGet)?;
                unreachable!("successful result handled above")
            }
        }
    }

    fn copy_terminal_text(&self, data: ffi::TerminalData::Type) -> Result<Vec<u8>, GhosttyError> {
        let raw: ffi::String = self.get(data)?;
        let bytes = ffi_string_bytes(raw, &self.raw, Operation::TerminalGet)?;
        if bytes.len() > self.callbacks.as_ref().get_ref().text_limit() {
            return Err(GhosttyError::OutOfSpace {
                operation: Operation::TerminalGet,
                required: bytes.len(),
                limit: self.callbacks.as_ref().get_ref().text_limit(),
            });
        }
        Ok(bytes.to_vec())
    }

    #[cfg(test)]
    pub(crate) fn callback_capacities(&self) -> (usize, usize, usize, usize) {
        self.callbacks.as_ref().get_ref().capacities()
    }
}

fn checked_dimension(value: usize, field: ValueField) -> Result<u16, GhosttyError> {
    if value == 0 {
        return Err(invalid(field));
    }
    u16::try_from(value).map_err(|_| invalid(field))
}

fn checked_pixel(value: usize, field: ValueField) -> Result<u32, GhosttyError> {
    if value == 0 {
        return Err(invalid(field));
    }
    u32::try_from(value).map_err(|_| invalid(field))
}

fn ffi_string_bytes(
    value: ffi::String,
    _terminal_borrow: &RawTerminal,
    operation: Operation,
) -> Result<&[u8], GhosttyError> {
    if value.len == 0 {
        return Ok(&[]);
    }
    if value.ptr.is_null() {
        return Err(abi_violation(operation, AbiViolation::NullData));
    }
    // SAFETY: The checked getter contract keeps this borrowed string valid until
    // the next terminal write/reset. The returned slice is tied to an immutable
    // terminal borrow, so safe Rust cannot perform either mutation while it lives.
    Ok(unsafe { std::slice::from_raw_parts(value.ptr, value.len) })
}

fn build_info_string_bytes(value: ffi::String) -> Result<&'static [u8], GhosttyError> {
    if value.len == 0 {
        return Ok(&[]);
    }
    if value.ptr.is_null() {
        return Err(abi_violation(Operation::BuildInfo, AbiViolation::NullData));
    }
    // SAFETY: Build-info strings are immutable library-owned data documented as
    // valid for the entire process lifetime.
    Ok(unsafe { std::slice::from_raw_parts(value.ptr, value.len) })
}

/// Return the exact Ghostty revision after validating linked build-info.
///
/// This value is safe to include in diagnostics and test observations. It is
/// not a parser-state or persistence version.
pub fn build_revision() -> Result<&'static str, GhosttyError> {
    initialize_process()?;
    Ok(ffi::GHOSTTY_REVISION)
}

fn initialize_process() -> Result<(), GhosttyError> {
    PROCESS_INITIALIZATION
        .get_or_init(check_linked_revision)
        .clone()
}

fn check_linked_revision() -> Result<(), GhosttyError> {
    let mut revision = ffi::String::default();
    // SAFETY: The output pointer has the exact public GhosttyString type for
    // VERSION_BUILD and the returned process-lifetime string is copied below.
    let result = unsafe {
        ffi::ghostty_build_info(
            ffi::BuildInfo::VERSION_BUILD,
            ptr::from_mut(&mut revision).cast::<c_void>(),
        )
    };
    ffi_result(result, Operation::BuildInfo)?;
    let bytes = build_info_string_bytes(revision)?;
    let actual = std::str::from_utf8(bytes)
        .map_err(|_| GhosttyError::InvalidUtf8 {
            field: TextField::BuildRevision,
        })?
        .to_owned();
    if actual != ffi::GHOSTTY_REVISION {
        return Err(GhosttyError::AbiRevisionMismatch {
            expected: ffi::GHOSTTY_REVISION,
            actual,
        });
    }
    Ok(())
}

fn next_terminal_id() -> u64 {
    let id = NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed);
    if id == 0 {
        NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed)
    } else {
        id
    }
}
