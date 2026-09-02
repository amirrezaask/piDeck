use std::ffi::c_void;
use std::marker::{PhantomData, PhantomPinned};
use std::pin::Pin;
use std::rc::Rc;

use ghostty_vt_sys as ffi;

use crate::error::invalid;
use crate::ffi_util::ffi_result;
use crate::{AbiViolation, EffectKind, GhosttyError, Operation, ValueField};

/// Maximum PTY response bytes accepted by [`EffectLimits`].
pub const MAX_PTY_RESPONSE_BYTES: usize = 1024 * 1024;
/// Maximum response callback count accepted by [`EffectLimits`].
pub const MAX_PTY_RESPONSES: usize = 4096;
/// Maximum title or working-directory bytes accepted by [`EffectLimits`].
pub const MAX_EFFECT_TEXT_BYTES: usize = 64 * 1024;
/// Maximum configured ENQ or XTVERSION response bytes.
pub const MAX_QUERY_RESPONSE_BYTES: usize = 4096;
/// Maximum callback count accepted for one query kind or bells.
pub const MAX_EFFECT_EVENTS: u32 = 65_536;

/// Per-mutation bounds for synchronous terminal effects.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectLimits {
    /// Combined bytes retained from write-PTY callbacks.
    pub pty_response_bytes: usize,
    /// Number of separately delivered write-PTY callbacks.
    pub pty_responses: usize,
    /// Maximum copied title or working-directory length.
    pub text_bytes: usize,
    /// Maximum bells retained for one terminal mutation.
    pub bells: u32,
    /// Maximum callbacks retained for each host-query kind.
    pub queries: u32,
}

impl Default for EffectLimits {
    fn default() -> Self {
        Self {
            pty_response_bytes: 64 * 1024,
            pty_responses: 256,
            text_bytes: 8 * 1024,
            bells: 1024,
            queries: 1024,
        }
    }
}

impl EffectLimits {
    pub(crate) fn validate(self) -> Result<(), GhosttyError> {
        if self.pty_response_bytes > MAX_PTY_RESPONSE_BYTES {
            return Err(invalid(ValueField::PtyResponseBytes));
        }
        if self.pty_responses > MAX_PTY_RESPONSES {
            return Err(invalid(ValueField::PtyResponseCount));
        }
        if self.text_bytes > MAX_EFFECT_TEXT_BYTES {
            return Err(invalid(ValueField::EffectTextBytes));
        }
        if self.bells > MAX_EFFECT_EVENTS {
            return Err(invalid(ValueField::BellCount));
        }
        if self.queries > MAX_EFFECT_EVENTS {
            return Err(invalid(ValueField::QueryCount));
        }
        Ok(())
    }
}

/// Pixel and cell geometry copied into size-query callbacks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSize {
    /// Rows in cells.
    pub rows: u16,
    /// Columns in cells.
    pub columns: u16,
    /// Cell width in pixels.
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
}

impl From<TerminalSize> for ffi::SizeReportSize {
    fn from(value: TerminalSize) -> Self {
        Self {
            rows: value.rows,
            columns: value.columns,
            cell_width: value.cell_width,
            cell_height: value.cell_height,
        }
    }
}

/// Color scheme returned to terminal color-scheme queries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorScheme {
    /// A light host theme.
    Light,
    /// A dark host theme.
    Dark,
}

impl ColorScheme {
    fn as_ffi(self) -> ffi::ColorScheme::Type {
        match self {
            Self::Light => ffi::ColorScheme::LIGHT,
            Self::Dark => ffi::ColorScheme::DARK,
        }
    }
}

/// Device attributes copied into DA1, DA2, and DA3 callbacks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceAttributes {
    /// DA1 conformance level.
    pub primary_conformance_level: u16,
    /// DA1 feature codes, limited to the public ABI's 64 entries.
    pub primary_features: Vec<u16>,
    /// DA2 terminal type.
    pub secondary_device_type: u16,
    /// DA2 firmware version.
    pub secondary_firmware_version: u16,
    /// DA2 ROM cartridge value.
    pub secondary_rom_cartridge: u16,
    /// DA3 unit identifier.
    pub tertiary_unit_id: u32,
}

impl Default for DeviceAttributes {
    fn default() -> Self {
        Self {
            primary_conformance_level: ffi::DA_CONFORMANCE_VT220,
            primary_features: vec![ffi::DA_FEATURE_ANSI_COLOR],
            secondary_device_type: ffi::DA_DEVICE_TYPE_VT220,
            secondary_firmware_version: 0,
            secondary_rom_cartridge: 0,
            tertiary_unit_id: 0,
        }
    }
}

impl DeviceAttributes {
    fn to_ffi(&self) -> Result<ffi::DeviceAttributes, GhosttyError> {
        if self.primary_features.len() > 64 {
            return Err(invalid(ValueField::DeviceAttributeFeatures));
        }
        let mut result = ffi::DeviceAttributes::default();
        result.primary.conformance_level = self.primary_conformance_level;
        result.primary.num_features = self.primary_features.len();
        result.primary.features[..self.primary_features.len()]
            .copy_from_slice(&self.primary_features);
        result.secondary.device_type = self.secondary_device_type;
        result.secondary.firmware_version = self.secondary_firmware_version;
        result.secondary.rom_cartridge = self.secondary_rom_cartridge;
        result.tertiary.unit_id = self.tertiary_unit_id;
        Ok(result)
    }
}

/// Host values and bounds used by terminal effect callbacks.
///
/// Callbacks only read these copied values. They never invoke host closures,
/// lock, block, or write to a PTY.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct EffectOptions {
    /// Bounded outbox limits.
    pub limits: EffectLimits,
    /// Optional size-query response.
    pub size: Option<TerminalSize>,
    /// Optional color-scheme query response.
    pub color_scheme: Option<ColorScheme>,
    /// Optional device-attributes response.
    pub device_attributes: Option<DeviceAttributes>,
    /// Bytes returned for ENQ.
    pub enquiry_response: Vec<u8>,
    /// Bytes returned for XTVERSION.
    pub xtversion: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ResponseRange {
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct QueryCountsInner {
    enquiry: u32,
    xtversion: u32,
    size: u32,
    color_scheme: u32,
    device_attributes: u32,
}

impl QueryCountsInner {
    fn increment(value: &mut u32, limit: u32) -> bool {
        if *value >= limit {
            return false;
        }
        *value += 1;
        true
    }
}

/// Counts of host-query callbacks observed during one terminal mutation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QueryCounts {
    /// ENQ callbacks.
    pub enquiry: u32,
    /// XTVERSION callbacks.
    pub xtversion: u32,
    /// XTWINOPS size callbacks.
    pub size: u32,
    /// Color-scheme callbacks.
    pub color_scheme: u32,
    /// Device-attributes callbacks.
    pub device_attributes: u32,
}

impl From<QueryCountsInner> for QueryCounts {
    fn from(value: QueryCountsInner) -> Self {
        Self {
            enquiry: value.enquiry,
            xtversion: value.xtversion,
            size: value.size,
            color_scheme: value.color_scheme,
            device_attributes: value.device_attributes,
        }
    }
}

#[derive(Debug)]
pub(crate) struct CallbackState {
    terminal: ffi::Terminal,
    limits: EffectLimits,
    pty_bytes: Vec<u8>,
    pty_ranges: Vec<ResponseRange>,
    title: Vec<u8>,
    pwd: Vec<u8>,
    title_changed: bool,
    pwd_changed: bool,
    bells: u32,
    queries: QueryCountsInner,
    enquiry_response: Box<[u8]>,
    xtversion: Box<[u8]>,
    size: Option<ffi::SizeReportSize>,
    color_scheme: Option<ColorScheme>,
    device_attributes: Option<ffi::DeviceAttributes>,
    overflow: Option<(EffectKind, usize)>,
    in_callback: bool,
    reentrant: bool,
    invalid_callback: bool,
    _pinned: PhantomPinned,
}

impl CallbackState {
    pub(crate) fn new(options: EffectOptions) -> Result<Self, GhosttyError> {
        options.limits.validate()?;
        if options.enquiry_response.len() > MAX_QUERY_RESPONSE_BYTES
            || options.xtversion.len() > MAX_QUERY_RESPONSE_BYTES
        {
            return Err(invalid(ValueField::QueryResponse));
        }
        let device_attributes = options
            .device_attributes
            .as_ref()
            .map(DeviceAttributes::to_ffi)
            .transpose()?;
        Ok(Self {
            terminal: std::ptr::null_mut(),
            limits: options.limits,
            pty_bytes: Vec::with_capacity(options.limits.pty_response_bytes),
            pty_ranges: Vec::with_capacity(options.limits.pty_responses),
            title: Vec::with_capacity(options.limits.text_bytes),
            pwd: Vec::with_capacity(options.limits.text_bytes),
            title_changed: false,
            pwd_changed: false,
            bells: 0,
            queries: QueryCountsInner::default(),
            enquiry_response: options.enquiry_response.into_boxed_slice(),
            xtversion: options.xtversion.into_boxed_slice(),
            size: options.size.map(Into::into),
            color_scheme: options.color_scheme,
            device_attributes,
            overflow: None,
            in_callback: false,
            reentrant: false,
            invalid_callback: false,
            _pinned: PhantomPinned,
        })
    }

    pub(crate) fn pinned_mut(state: Pin<&mut Self>) -> &mut Self {
        // SAFETY: Callers use this reference only for in-place field mutation
        // and never move or replace the `!Unpin` callback state.
        unsafe { Pin::get_unchecked_mut(state) }
    }

    pub(crate) fn bind_terminal(&mut self, terminal: ffi::Terminal) {
        self.terminal = terminal;
    }

    pub(crate) fn prepare(&mut self) {
        self.pty_bytes.clear();
        self.pty_ranges.clear();
        self.title.clear();
        self.pwd.clear();
        self.title_changed = false;
        self.pwd_changed = false;
        self.bells = 0;
        self.queries = QueryCountsInner::default();
        self.overflow = None;
        self.in_callback = false;
        self.reentrant = false;
        self.invalid_callback = false;
    }

    pub(crate) fn title_is_dirty(&self) -> bool {
        self.title_changed
    }

    pub(crate) fn pwd_is_dirty(&self) -> bool {
        self.pwd_changed
    }

    pub(crate) fn copy_title(&mut self, bytes: &[u8]) {
        if bytes.len() > self.limits.text_bytes {
            self.mark_overflow(EffectKind::Title, self.limits.text_bytes);
            return;
        }
        self.title.extend_from_slice(bytes);
    }

    pub(crate) fn copy_pwd(&mut self, bytes: &[u8]) {
        if bytes.len() > self.limits.text_bytes {
            self.mark_overflow(EffectKind::WorkingDirectory, self.limits.text_bytes);
            return;
        }
        self.pwd.extend_from_slice(bytes);
    }

    pub(crate) fn text_limit(&self) -> usize {
        self.limits.text_bytes
    }

    pub(crate) fn set_size(&mut self, size: TerminalSize) {
        if self.size.is_some() {
            self.size = Some(size.into());
        }
    }

    pub(crate) fn finish(&self) -> Result<TerminalEffects<'_>, GhosttyError> {
        if self.invalid_callback {
            return Err(GhosttyError::AbiViolation {
                operation: Operation::TerminalSet,
                violation: AbiViolation::InvalidCallback,
            });
        }
        if self.reentrant {
            return Err(GhosttyError::CallbackReentrant);
        }
        if let Some((effect, limit)) = self.overflow {
            return Err(GhosttyError::CallbackOverflow { effect, limit });
        }
        Ok(TerminalEffects {
            state: self,
            _thread_confined: PhantomData,
        })
    }

    fn enter(&mut self, terminal: ffi::Terminal) -> bool {
        if terminal != self.terminal {
            self.invalid_callback = true;
            return false;
        }
        if self.in_callback {
            self.reentrant = true;
            return false;
        }
        self.in_callback = true;
        true
    }

    fn exit(&mut self) {
        self.in_callback = false;
    }

    fn mark_overflow(&mut self, effect: EffectKind, limit: usize) {
        if self.overflow.is_none() {
            self.overflow = Some((effect, limit));
        }
    }

    fn record_pty(&mut self, data: *const u8, len: usize) {
        if len == 0 {
            return;
        }
        if data.is_null() {
            self.invalid_callback = true;
            return;
        }
        if self.pty_ranges.len() >= self.limits.pty_responses {
            self.mark_overflow(EffectKind::PtyResponseCount, self.limits.pty_responses);
            return;
        }
        let Some(end) = self.pty_bytes.len().checked_add(len) else {
            self.mark_overflow(EffectKind::PtyResponseBytes, self.limits.pty_response_bytes);
            return;
        };
        if end > self.limits.pty_response_bytes {
            self.mark_overflow(EffectKind::PtyResponseBytes, self.limits.pty_response_bytes);
            return;
        }
        let start = self.pty_bytes.len();
        // SAFETY: The callback contract guarantees `data` is readable for `len`
        // bytes for this synchronous call; null with non-zero length was rejected.
        let bytes = unsafe { std::slice::from_raw_parts(data, len) };
        // Capacity was preallocated to the configured bound and `end` was checked,
        // so this copy cannot grow or allocate the callback vector.
        self.pty_bytes.extend_from_slice(bytes);
        self.pty_ranges.push(ResponseRange { start, end });
    }

    fn record_bell(&mut self) {
        if self.bells >= self.limits.bells {
            self.mark_overflow(
                EffectKind::Bells,
                usize::try_from(self.limits.bells)
                    .expect("validated event limits fit supported native targets"),
            );
            return;
        }
        self.bells += 1;
    }

    fn record_query(&mut self, kind: QueryKind) {
        let accepted = match kind {
            QueryKind::Enquiry => {
                QueryCountsInner::increment(&mut self.queries.enquiry, self.limits.queries)
            }
            QueryKind::Xtversion => {
                QueryCountsInner::increment(&mut self.queries.xtversion, self.limits.queries)
            }
            QueryKind::Size => {
                QueryCountsInner::increment(&mut self.queries.size, self.limits.queries)
            }
            QueryKind::ColorScheme => {
                QueryCountsInner::increment(&mut self.queries.color_scheme, self.limits.queries)
            }
            QueryKind::DeviceAttributes => QueryCountsInner::increment(
                &mut self.queries.device_attributes,
                self.limits.queries,
            ),
        };
        if !accepted {
            self.mark_overflow(
                EffectKind::Queries,
                usize::try_from(self.limits.queries)
                    .expect("validated event limits fit supported native targets"),
            );
        }
    }

    #[cfg(test)]
    pub(crate) fn capacities(&self) -> (usize, usize, usize, usize) {
        (
            self.pty_bytes.capacity(),
            self.pty_ranges.capacity(),
            self.title.capacity(),
            self.pwd.capacity(),
        )
    }
}

#[derive(Clone, Copy)]
enum QueryKind {
    Enquiry,
    Xtversion,
    Size,
    ColorScheme,
    DeviceAttributes,
}

/// Borrowed terminal effects produced only after the native mutation returns.
///
/// This value borrows the terminal's bounded outbox. While it is alive, safe
/// Rust cannot write, resize, reset, or otherwise mutably access the terminal.
#[derive(Debug)]
pub struct TerminalEffects<'terminal> {
    state: &'terminal CallbackState,
    _thread_confined: PhantomData<Rc<()>>,
}

impl TerminalEffects<'_> {
    /// Iterate exact, separately delivered bytes that must be written to the PTY.
    #[must_use]
    pub fn pty_responses(&self) -> PtyResponses<'_> {
        PtyResponses {
            bytes: &self.state.pty_bytes,
            ranges: &self.state.pty_ranges,
            index: 0,
            _thread_confined: PhantomData,
        }
    }

    /// Number of bell events observed.
    #[must_use]
    pub fn bells(&self) -> u32 {
        self.state.bells
    }

    /// Return the changed title bytes, including an empty title when cleared.
    #[must_use]
    pub fn title(&self) -> Option<&[u8]> {
        self.state
            .title_changed
            .then_some(self.state.title.as_slice())
    }

    /// Return the changed working-directory bytes, including an empty value when cleared.
    #[must_use]
    pub fn working_directory(&self) -> Option<&[u8]> {
        self.state.pwd_changed.then_some(self.state.pwd.as_slice())
    }

    /// Return counts for host-query callbacks handled from copied configuration.
    #[must_use]
    pub fn queries(&self) -> QueryCounts {
        self.state.queries.into()
    }

    /// Whether this mutation produced no externally observable effects.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.state.pty_ranges.is_empty()
            && self.state.bells == 0
            && !self.state.title_changed
            && !self.state.pwd_changed
            && self.state.queries == QueryCountsInner::default()
    }
}

/// Iterator over exact PTY responses staged by synchronous callbacks.
#[derive(Clone, Debug)]
pub struct PtyResponses<'effects> {
    bytes: &'effects [u8],
    ranges: &'effects [ResponseRange],
    index: usize,
    _thread_confined: PhantomData<Rc<()>>,
}

impl<'effects> Iterator for PtyResponses<'effects> {
    type Item = &'effects [u8];

    fn next(&mut self) -> Option<Self::Item> {
        let range = *self.ranges.get(self.index)?;
        self.index += 1;
        self.bytes.get(range.start..range.end)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.ranges.len().saturating_sub(self.index);
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for PtyResponses<'_> {}
impl std::iter::FusedIterator for PtyResponses<'_> {}

pub(crate) fn register_callbacks(
    terminal: ffi::Terminal,
    state: *mut CallbackState,
) -> Result<(), GhosttyError> {
    set_callback(terminal, ffi::TerminalOption::USERDATA, state.cast())?;

    let write_pty =
        write_pty_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void, *const u8, usize);
    set_callback(
        terminal,
        ffi::TerminalOption::WRITE_PTY,
        write_pty as *const () as *const c_void,
    )?;
    let bell = bell_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void);
    set_callback(
        terminal,
        ffi::TerminalOption::BELL,
        bell as *const () as *const c_void,
    )?;
    let title = title_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void);
    set_callback(
        terminal,
        ffi::TerminalOption::TITLE_CHANGED,
        title as *const () as *const c_void,
    )?;
    let pwd = pwd_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void);
    set_callback(
        terminal,
        ffi::TerminalOption::PWD_CHANGED,
        pwd as *const () as *const c_void,
    )?;
    let enquiry =
        enquiry_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void) -> ffi::String;
    set_callback(
        terminal,
        ffi::TerminalOption::ENQUIRY,
        enquiry as *const () as *const c_void,
    )?;
    let xtversion =
        xtversion_callback as unsafe extern "C" fn(ffi::Terminal, *mut c_void) -> ffi::String;
    set_callback(
        terminal,
        ffi::TerminalOption::XTVERSION,
        xtversion as *const () as *const c_void,
    )?;
    let size = size_callback
        as unsafe extern "C" fn(ffi::Terminal, *mut c_void, *mut ffi::SizeReportSize) -> bool;
    set_callback(
        terminal,
        ffi::TerminalOption::SIZE,
        size as *const () as *const c_void,
    )?;
    let scheme = color_scheme_callback
        as unsafe extern "C" fn(ffi::Terminal, *mut c_void, *mut ffi::ColorScheme::Type) -> bool;
    set_callback(
        terminal,
        ffi::TerminalOption::COLOR_SCHEME,
        scheme as *const () as *const c_void,
    )?;
    let attrs = device_attributes_callback
        as unsafe extern "C" fn(ffi::Terminal, *mut c_void, *mut ffi::DeviceAttributes) -> bool;
    set_callback(
        terminal,
        ffi::TerminalOption::DEVICE_ATTRIBUTES,
        attrs as *const () as *const c_void,
    )
}

fn set_callback(
    terminal: ffi::Terminal,
    option: ffi::TerminalOption::Type,
    value: *const c_void,
) -> Result<(), GhosttyError> {
    // SAFETY: `terminal` is a live, exclusively initializing handle. Callback
    // function pointers use the exact checked public declarations, userdata is
    // pinned for the terminal lifetime, and Ghostty copies each pointer value.
    let result = unsafe { ffi::ghostty_terminal_set(terminal, option, value) };
    ffi_result(result, Operation::TerminalSet)
}

fn with_state(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
    action: impl FnOnce(&mut CallbackState),
) {
    // SAFETY: Registration stores a pointer to the pinned `CallbackState`, which
    // remains live until after the terminal is freed. Callbacks are synchronous
    // and `enter` rejects recursive mutable access.
    let Some(state) = (unsafe { userdata.cast::<CallbackState>().as_mut() }) else {
        return;
    };
    if !state.enter(terminal) {
        return;
    }
    action(state);
    state.exit();
}

unsafe extern "C" fn write_pty_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    with_state(terminal, userdata, |state| state.record_pty(data, len));
}

unsafe extern "C" fn bell_callback(terminal: ffi::Terminal, userdata: *mut c_void) {
    with_state(terminal, userdata, CallbackState::record_bell);
}

unsafe extern "C" fn title_callback(terminal: ffi::Terminal, userdata: *mut c_void) {
    with_state(terminal, userdata, |state| state.title_changed = true);
}

unsafe extern "C" fn pwd_callback(terminal: ffi::Terminal, userdata: *mut c_void) {
    with_state(terminal, userdata, |state| state.pwd_changed = true);
}

unsafe extern "C" fn enquiry_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
) -> ffi::String {
    let mut result = ffi::String::default();
    with_state(terminal, userdata, |state| {
        state.record_query(QueryKind::Enquiry);
        result = ffi::String {
            ptr: state.enquiry_response.as_ptr(),
            len: state.enquiry_response.len(),
        };
    });
    result
}

unsafe extern "C" fn xtversion_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
) -> ffi::String {
    let mut result = ffi::String::default();
    with_state(terminal, userdata, |state| {
        state.record_query(QueryKind::Xtversion);
        result = ffi::String {
            ptr: state.xtversion.as_ptr(),
            len: state.xtversion.len(),
        };
    });
    result
}

unsafe extern "C" fn size_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
    out: *mut ffi::SizeReportSize,
) -> bool {
    let mut result = false;
    with_state(terminal, userdata, |state| {
        state.record_query(QueryKind::Size);
        let Some(value) = state.size else {
            return;
        };
        // SAFETY: The checked callback declaration promises a writable output
        // pointer when non-null; null is recorded as an ABI violation.
        let Some(out) = (unsafe { out.as_mut() }) else {
            state.invalid_callback = true;
            return;
        };
        *out = value;
        result = true;
    });
    result
}

unsafe extern "C" fn color_scheme_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
    out: *mut ffi::ColorScheme::Type,
) -> bool {
    let mut result = false;
    with_state(terminal, userdata, |state| {
        state.record_query(QueryKind::ColorScheme);
        let Some(value) = state.color_scheme else {
            return;
        };
        // SAFETY: The checked callback declaration promises a writable output
        // pointer when non-null; null is recorded as an ABI violation.
        let Some(out) = (unsafe { out.as_mut() }) else {
            state.invalid_callback = true;
            return;
        };
        *out = value.as_ffi();
        result = true;
    });
    result
}

unsafe extern "C" fn device_attributes_callback(
    terminal: ffi::Terminal,
    userdata: *mut c_void,
    out: *mut ffi::DeviceAttributes,
) -> bool {
    let mut result = false;
    with_state(terminal, userdata, |state| {
        state.record_query(QueryKind::DeviceAttributes);
        let Some(value) = state.device_attributes else {
            return;
        };
        // SAFETY: The checked callback declaration promises a writable output
        // pointer when non-null; null is recorded as an ABI violation.
        let Some(out) = (unsafe { out.as_mut() }) else {
            state.invalid_callback = true;
            return;
        };
        *out = value;
        result = true;
    });
    result
}
