use std::marker::PhantomData;
use std::ptr::{self, NonNull};
use std::rc::Rc;

use ghostty_vt_sys as ffi;

use crate::error::invalid;
use crate::ffi_util::{abi_violation, ffi_result};
use crate::{AbiViolation, GhosttyError, Operation, Terminal, ValueField};

/// Coordinate space for a terminal point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoordinateSpace {
    /// Active terminal area.
    Active,
    /// Visible viewport.
    Viewport,
    /// Full active screen including scrollback.
    Screen,
    /// Scrollback history before the active area.
    History,
}

impl CoordinateSpace {
    fn as_ffi(self) -> ffi::PointTag::Type {
        match self {
            Self::Active => ffi::PointTag::ACTIVE,
            Self::Viewport => ffi::PointTag::VIEWPORT,
            Self::Screen => ffi::PointTag::SCREEN,
            Self::History => ffi::PointTag::HISTORY,
        }
    }
}

/// A validated point in one terminal coordinate space.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalPoint {
    /// Coordinate space.
    pub space: CoordinateSpace,
    /// Zero-based column.
    pub column: usize,
    /// Zero-based row.
    pub row: usize,
}

impl TerminalPoint {
    pub(crate) fn to_ffi(self) -> Result<ffi::Point, GhosttyError> {
        let column = u16::try_from(self.column).map_err(|_| invalid(ValueField::PointColumn))?;
        let row = u32::try_from(self.row).map_err(|_| invalid(ValueField::PointRow))?;
        let mut value = ffi::PointValue::default();
        value.coordinate = ffi::PointCoordinate { x: column, y: row };
        Ok(ffi::Point {
            tag: self.space.as_ffi(),
            value,
        })
    }
}

/// Owned tracked reference that follows a cell through scroll, prune, and reflow.
///
/// The reference is thread-confined but may outlive its originating terminal,
/// as explicitly supported by the public Ghostty contract. It never exposes an
/// untracked native grid pointer.
pub struct TrackedGridRef {
    raw: NonNull<ffi::TrackedGridRefImpl>,
    owner_id: u64,
    _thread_confined: PhantomData<Rc<()>>,
}

impl TrackedGridRef {
    pub(crate) fn new(
        terminal: ffi::Terminal,
        owner_id: u64,
        point: TerminalPoint,
    ) -> Result<Self, GhosttyError> {
        let point = point.to_ffi()?;
        let mut raw = ptr::null_mut();
        // SAFETY: The terminal is live and exclusively borrowed, `point` uses a
        // checked public tagged union, and `raw` is a valid out-pointer.
        let result = unsafe { ffi::ghostty_terminal_grid_ref_track(terminal, point, &mut raw) };
        ffi_result(result, Operation::TrackedGridRefNew)?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| abi_violation(Operation::TrackedGridRefNew, AbiViolation::NullData))?;
        Ok(Self {
            raw,
            owner_id,
            _thread_confined: PhantomData,
        })
    }

    /// Whether the tracked cell still has a meaningful value.
    #[must_use]
    pub fn has_value(&self) -> bool {
        // SAFETY: The tracked handle is live. This public operation remains
        // valid even after the originating terminal has been freed.
        unsafe { ffi::ghostty_tracked_grid_ref_has_value(self.raw.as_ptr()) }
    }

    /// Resolve the tracked cell in a requested coordinate space.
    pub fn point(&self, space: CoordinateSpace) -> Result<Option<TerminalPoint>, GhosttyError> {
        let mut output = ffi::PointCoordinate::default();
        // SAFETY: The tracked handle and output storage are live. This operation
        // is documented as safe after terminal destruction and exposes no borrow.
        let result = unsafe {
            ffi::ghostty_tracked_grid_ref_point(self.raw.as_ptr(), space.as_ffi(), &mut output)
        };
        match result {
            ffi::Result::SUCCESS => Ok(Some(TerminalPoint {
                space,
                column: usize::from(output.x),
                row: usize::try_from(output.y)
                    .expect("supported native targets represent every u32 in usize"),
            })),
            ffi::Result::NO_VALUE => Ok(None),
            other => {
                ffi_result(other, Operation::TrackedGridRefGet)?;
                unreachable!("successful result handled above")
            }
        }
    }

    /// Move this reference to another point in its originating terminal.
    ///
    /// Passing another terminal is rejected before C, preventing the public
    /// native same-owner precondition from becoming caller-managed unsafe state.
    pub fn set(
        &mut self,
        terminal: &mut Terminal,
        point: TerminalPoint,
    ) -> Result<(), GhosttyError> {
        if terminal.id() != self.owner_id {
            return Err(invalid(ValueField::TerminalOwner));
        }
        let point = point.to_ffi()?;
        // SAFETY: Owner identity proves this is the creating terminal, both
        // handles are live and thread-confined, and `point` is validated.
        let result = unsafe {
            ffi::ghostty_tracked_grid_ref_set(self.raw.as_ptr(), terminal.raw_ptr(), point)
        };
        ffi_result(result, Operation::TrackedGridRefSet)
    }
}

impl Drop for TrackedGridRef {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the tracked handle and frees it
        // exactly once. The public ABI permits this after terminal destruction.
        unsafe { ffi::ghostty_tracked_grid_ref_free(self.raw.as_ptr()) };
    }
}
