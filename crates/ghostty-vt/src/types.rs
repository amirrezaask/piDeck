use crate::{GhosttyError, TextField};

/// An RGB terminal color.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Rgb {
    /// Red channel.
    pub r: u8,
    /// Green channel.
    pub g: u8,
    /// Blue channel.
    pub b: u8,
}

impl From<ghostty_vt_sys::ColorRgb> for Rgb {
    fn from(value: ghostty_vt_sys::ColorRgb) -> Self {
        Self {
            r: value.r,
            g: value.g,
            b: value.b,
        }
    }
}

impl From<Rgb> for ghostty_vt_sys::ColorRgb {
    fn from(value: Rgb) -> Self {
        Self {
            r: value.r,
            g: value.g,
            b: value.b,
        }
    }
}

/// Owned terminal text copied before its native borrow can become stale.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalText {
    bytes: Vec<u8>,
    field: TextField,
}

impl TerminalText {
    pub(crate) fn new(bytes: Vec<u8>, field: TextField) -> Self {
        Self { bytes, field }
    }

    /// Return exact bytes emitted by the terminal program.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Validate and return UTF-8 text.
    ///
    /// Terminal titles and working directories are byte-oriented in the C
    /// interface. Invalid UTF-8 is reported rather than replaced implicitly.
    pub fn as_str(&self) -> Result<&str, GhosttyError> {
        std::str::from_utf8(&self.bytes)
            .map_err(|_| GhosttyError::InvalidUtf8 { field: self.field })
    }

    /// Consume the wrapper and return its exact bytes.
    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}
