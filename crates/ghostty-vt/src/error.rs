use std::fmt;
use std::io;

/// A value accepted by the Rust interface but rejected before it reaches C.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueField {
    /// Terminal columns.
    Columns,
    /// Terminal rows.
    Rows,
    /// Scrollback rows.
    Scrollback,
    /// Cell width in pixels.
    CellWidth,
    /// Cell height in pixels.
    CellHeight,
    /// Bytes retained for PTY responses.
    PtyResponseBytes,
    /// Number of retained PTY responses.
    PtyResponseCount,
    /// Bytes retained for title and working-directory effects.
    EffectTextBytes,
    /// Bell events retained for one mutation.
    BellCount,
    /// Query callbacks retained for one mutation.
    QueryCount,
    /// A configured ENQ or XTVERSION response.
    QueryResponse,
    /// Device-attribute feature count.
    DeviceAttributeFeatures,
    /// A packed terminal mode.
    Mode,
    /// A point column.
    PointColumn,
    /// A point row.
    PointRow,
    /// A formatter output limit.
    FormatterLimit,
    /// A tracked grid reference's terminal owner.
    TerminalOwner,
}

/// A libghostty operation used to classify a checked C result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    /// Process-wide build information validation.
    BuildInfo,
    /// Terminal allocation.
    TerminalNew,
    /// Terminal option registration or mutation.
    TerminalSet,
    /// Terminal resize.
    TerminalResize,
    /// Terminal state access.
    TerminalGet,
    /// Terminal mode access.
    TerminalMode,
    /// Render-state allocation.
    RenderStateNew,
    /// Render-state update.
    RenderStateUpdate,
    /// Render-state access.
    RenderStateGet,
    /// Render-state mutation.
    RenderStateSet,
    /// Render row-iterator allocation.
    RenderRowIteratorNew,
    /// Render row access.
    RenderRowGet,
    /// Render row mutation.
    RenderRowSet,
    /// Render cell-iterator allocation.
    RenderCellsNew,
    /// Render cell access.
    RenderCellGet,
    /// Raw row access through the public opaque value API.
    RowGet,
    /// Raw cell access through the public opaque value API.
    CellGet,
    /// Formatter allocation.
    FormatterNew,
    /// Formatter output.
    FormatterWrite,
    /// Tracked grid-reference allocation.
    TrackedGridRefNew,
    /// Tracked grid-reference access.
    TrackedGridRefGet,
    /// Tracked grid-reference mutation.
    TrackedGridRefSet,
}

/// A bounded callback effect whose capacity was exceeded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    /// PTY response bytes.
    PtyResponseBytes,
    /// Separately delivered PTY responses.
    PtyResponseCount,
    /// Terminal title bytes.
    Title,
    /// Working-directory bytes.
    WorkingDirectory,
    /// Bell events.
    Bells,
    /// Host-query callback events.
    Queries,
}

/// A text field that did not contain valid UTF-8.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextField {
    /// Ghostty's build revision metadata.
    BuildRevision,
    /// A rendered grapheme.
    Grapheme,
    /// A terminal title.
    Title,
    /// A terminal working directory.
    WorkingDirectory,
}

/// A violated invariant at the checked native interface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AbiViolation {
    /// C returned an unknown result code.
    UnknownResult(i32),
    /// C returned an unknown enum discriminant.
    UnknownDiscriminant,
    /// C returned a null pointer with a non-zero length.
    NullData,
    /// C reported more written bytes than the provided capacity.
    InvalidLength,
    /// A callback was invoked with an unexpected terminal or output pointer.
    InvalidCallback,
    /// A public iterator ended before the advertised dimensions.
    ShortIterator,
}

/// Errors produced by the safe libghostty-vt wrapper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GhosttyError {
    /// A Rust input failed validation.
    InvalidValue {
        /// The rejected field.
        field: ValueField,
    },
    /// The checked native operation rejected internally validated input.
    NativeInvalidValue {
        /// The operation that rejected the value.
        operation: Operation,
    },
    /// Native allocation failed.
    OutOfMemory {
        /// The operation that attempted the allocation.
        operation: Operation,
    },
    /// A bounded output buffer was too small.
    OutOfSpace {
        /// The operation producing output.
        operation: Operation,
        /// Required bytes when known.
        required: usize,
        /// Configured maximum bytes.
        limit: usize,
    },
    /// The requested native value was absent.
    NoValue {
        /// The operation that queried the value.
        operation: Operation,
    },
    /// A callback exceeded a configured bound.
    CallbackOverflow {
        /// The effect that overflowed.
        effect: EffectKind,
        /// Its configured bound.
        limit: usize,
    },
    /// A callback was entered recursively.
    CallbackReentrant,
    /// Native build metadata did not match the pinned sys crate.
    AbiRevisionMismatch {
        /// Revision expected by the checked sys crate.
        expected: &'static str,
        /// Revision reported by the linked native artifact.
        actual: String,
    },
    /// The checked native interface violated its documented contract.
    AbiViolation {
        /// The operation observing the violation.
        operation: Operation,
        /// The violated invariant.
        violation: AbiViolation,
    },
    /// A native text field was not valid UTF-8.
    InvalidUtf8 {
        /// The invalid field.
        field: TextField,
    },
    /// A bounded formatter sink rejected output.
    Sink {
        /// The sink's stable error category.
        kind: io::ErrorKind,
    },
}

impl fmt::Display for GhosttyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue { field } => write!(formatter, "invalid value for {field:?}"),
            Self::NativeInvalidValue { operation } => {
                write!(
                    formatter,
                    "native operation {operation:?} rejected a checked value"
                )
            }
            Self::OutOfMemory { operation } => {
                write!(formatter, "native allocation failed during {operation:?}")
            }
            Self::OutOfSpace {
                operation,
                required,
                limit,
            } => write!(
                formatter,
                "{operation:?} requires {required} bytes, exceeding the {limit}-byte limit"
            ),
            Self::NoValue { operation } => write!(formatter, "{operation:?} has no value"),
            Self::CallbackOverflow { effect, limit } => {
                write!(
                    formatter,
                    "{effect:?} exceeded its configured limit of {limit}"
                )
            }
            Self::CallbackReentrant => formatter.write_str("terminal callback re-entered"),
            Self::AbiRevisionMismatch { expected, actual } => write!(
                formatter,
                "linked Ghostty revision {actual:?} does not match {expected}"
            ),
            Self::AbiViolation {
                operation,
                violation,
            } => write!(
                formatter,
                "native ABI violation in {operation:?}: {violation:?}"
            ),
            Self::InvalidUtf8 { field } => write!(formatter, "{field:?} is not valid UTF-8"),
            Self::Sink { kind } => write!(formatter, "formatter sink failed with {kind:?}"),
        }
    }
}

impl std::error::Error for GhosttyError {}

pub(crate) fn invalid(field: ValueField) -> GhosttyError {
    GhosttyError::InvalidValue { field }
}
