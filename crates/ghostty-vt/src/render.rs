use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr::{self, NonNull};
use std::rc::Rc;

use ghostty_vt_sys as ffi;

use crate::ffi_util::{abi_violation, ffi_result, sized};
use crate::{AbiViolation, GhosttyError, Operation, Rgb, TextField};

const INITIAL_GRAPHEME_BYTES: usize = 64;
const MAX_GRAPHEME_BYTES: usize = 16 * 1024;

struct RawRenderState(NonNull<ffi::RenderStateImpl>);

impl RawRenderState {
    fn new() -> Result<Self, GhosttyError> {
        let mut raw = ptr::null_mut();
        // SAFETY: `raw` is a valid out-pointer and null selects Ghostty's
        // process-default allocator. A successful result owns one live handle.
        let result = unsafe { ffi::ghostty_render_state_new(ptr::null(), &mut raw) };
        ffi_result(result, Operation::RenderStateNew)?;
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| abi_violation(Operation::RenderStateNew, AbiViolation::NullData))
    }

    fn as_ptr(&self) -> ffi::RenderState {
        self.0.as_ptr()
    }
}

impl Drop for RawRenderState {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the live render-state handle and
        // frees it exactly once after its iterators have been freed.
        unsafe { ffi::ghostty_render_state_free(self.as_ptr()) };
    }
}

struct RawRowIterator(NonNull<ffi::RenderStateRowIteratorImpl>);

impl RawRowIterator {
    fn new() -> Result<Self, GhosttyError> {
        let mut raw = ptr::null_mut();
        // SAFETY: `raw` is a valid out-pointer and null selects the same default
        // allocator used for every wrapper-owned resource.
        let result = unsafe { ffi::ghostty_render_state_row_iterator_new(ptr::null(), &mut raw) };
        ffi_result(result, Operation::RenderRowIteratorNew)?;
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| abi_violation(Operation::RenderRowIteratorNew, AbiViolation::NullData))
    }

    fn as_ptr(&self) -> ffi::RenderStateRowIterator {
        self.0.as_ptr()
    }
}

impl Drop for RawRowIterator {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the initialized iterator and frees
        // it exactly once before its backing render state.
        unsafe { ffi::ghostty_render_state_row_iterator_free(self.as_ptr()) };
    }
}

struct RawCells(NonNull<ffi::RenderStateRowCellsImpl>);

impl RawCells {
    fn new() -> Result<Self, GhosttyError> {
        let mut raw = ptr::null_mut();
        // SAFETY: `raw` is a valid out-pointer and null selects the process
        // default allocator. Success transfers one live iterator handle.
        let result = unsafe { ffi::ghostty_render_state_row_cells_new(ptr::null(), &mut raw) };
        ffi_result(result, Operation::RenderCellsNew)?;
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| abi_violation(Operation::RenderCellsNew, AbiViolation::NullData))
    }

    fn as_ptr(&self) -> ffi::RenderStateRowCells {
        self.0.as_ptr()
    }
}

impl Drop for RawCells {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the initialized cells iterator and
        // frees it exactly once before the row iterator and render state.
        unsafe { ffi::ghostty_render_state_row_cells_free(self.as_ptr()) };
    }
}

pub(crate) struct RenderResources {
    // Declaration order is intentional: children are freed before parents.
    cells: RawCells,
    rows: RawRowIterator,
    state: RawRenderState,
    grapheme: Vec<u8>,
}

impl RenderResources {
    pub(crate) fn new() -> Result<Self, GhosttyError> {
        let state = RawRenderState::new()?;
        let rows = RawRowIterator::new()?;
        let cells = RawCells::new()?;
        Ok(Self {
            cells,
            rows,
            state,
            grapheme: vec![0; INITIAL_GRAPHEME_BYTES],
        })
    }

    pub(crate) fn update(&mut self, terminal: ffi::Terminal) -> Result<(), GhosttyError> {
        // SAFETY: Both handles are live and thread-confined. `terminal` is
        // exclusively borrowed for this mutation, and no render view exists.
        let result = unsafe { ffi::ghostty_render_state_update(self.state.as_ptr(), terminal) };
        ffi_result(result, Operation::RenderStateUpdate)
    }

    pub(crate) fn view(&mut self) -> Result<RenderView<'_>, GhosttyError> {
        RenderView::new(self)
    }

    #[cfg(test)]
    pub(crate) fn grapheme_capacity(&self) -> usize {
        self.grapheme.capacity()
    }
}

/// Global dirty state after a render-state update.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirtyState {
    /// No render data changed.
    Clean,
    /// One or more rows changed.
    Partial,
    /// Global state changed and the viewport needs a full redraw.
    Full,
}

/// Visual cursor shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorVisualStyle {
    /// Vertical bar.
    Bar,
    /// Filled block.
    Block,
    /// Underline.
    Underline,
    /// Hollow block.
    HollowBlock,
}

/// Viewport cell position.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ViewportPosition {
    /// Zero-based column.
    pub column: u16,
    /// Zero-based row.
    pub row: u16,
}

/// Cursor state copied from the public render interface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CursorState {
    /// Visual cursor style.
    pub style: CursorVisualStyle,
    /// Whether terminal modes make the cursor visible.
    pub visible: bool,
    /// Whether the cursor should blink.
    pub blinking: bool,
    /// Whether the cursor is at a password input field.
    pub password_input: bool,
    /// Position when the cursor lies in the current viewport.
    pub viewport_position: Option<ViewportPosition>,
    /// Whether the reported position is the tail of a wide cell.
    pub wide_tail: bool,
}

/// Render colors copied from the native render state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderColors {
    /// Effective background color.
    pub background: Rgb,
    /// Effective foreground color.
    pub foreground: Rgb,
    /// Explicit cursor color, when one exists.
    pub cursor: Option<Rgb>,
    /// Effective 256-color palette.
    pub palette: [Rgb; 256],
}

/// A row-local selected column range, inclusive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SelectionRange {
    /// First selected column.
    pub start: u16,
    /// Last selected column.
    pub end: u16,
}

/// Semantic prompt state attached to a row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticPrompt {
    /// No prompt content.
    None,
    /// A primary prompt line.
    Prompt,
    /// A prompt continuation line.
    Continuation,
}

/// Cell-width behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CellWidth {
    /// One-column cell.
    Narrow,
    /// Two-column cell head.
    Wide,
    /// Non-rendered tail after a wide cell.
    SpacerTail,
    /// Soft-wrap spacer at the prior row's end.
    SpacerHead,
}

/// Semantic content attached to a cell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticContent {
    /// Ordinary command output.
    Output,
    /// User input.
    Input,
    /// Shell prompt text.
    Prompt,
}

/// A style color from Ghostty's public tagged union.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StyleColor {
    /// No explicit color.
    None,
    /// A palette index.
    Palette(u8),
    /// A direct RGB color.
    Rgb(Rgb),
}

/// Underline decoration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Underline {
    /// No underline.
    None,
    /// Single underline.
    Single,
    /// Double underline.
    Double,
    /// Curly underline.
    Curly,
    /// Dotted underline.
    Dotted,
    /// Dashed underline.
    Dashed,
}

/// Complete copied style for one rendered cell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CellStyle {
    /// Foreground style color.
    pub foreground: StyleColor,
    /// Background style color.
    pub background: StyleColor,
    /// Underline style color.
    pub underline_color: StyleColor,
    /// Bold flag.
    pub bold: bool,
    /// Italic flag.
    pub italic: bool,
    /// Faint flag.
    pub faint: bool,
    /// Blink flag.
    pub blink: bool,
    /// Inverse flag.
    pub inverse: bool,
    /// Invisible flag.
    pub invisible: bool,
    /// Strikethrough flag.
    pub strikethrough: bool,
    /// Overline flag.
    pub overline: bool,
    /// Underline decoration.
    pub underline: Underline,
}

/// Borrowed traversal of one updated render state.
///
/// A render view can exist only inside [`crate::Terminal::with_render_state`].
/// It and all row/cell views are thread-confined and prevent terminal mutation.
pub struct RenderView<'terminal> {
    resources: &'terminal mut RenderResources,
    columns: u16,
    rows: u16,
    dirty: DirtyState,
    colors: RenderColors,
    cursor: CursorState,
    next_row: u16,
    _thread_confined: PhantomData<Rc<()>>,
}

impl<'terminal> RenderView<'terminal> {
    fn new(resources: &'terminal mut RenderResources) -> Result<Self, GhosttyError> {
        let columns = render_get::<u16>(resources, ffi::RenderStateData::COLS)?;
        let rows = render_get::<u16>(resources, ffi::RenderStateData::ROWS)?;
        let dirty_raw =
            render_get::<ffi::RenderStateDirty::Type>(resources, ffi::RenderStateData::DIRTY)?;
        let dirty = match dirty_raw {
            ffi::RenderStateDirty::FALSE => DirtyState::Clean,
            ffi::RenderStateDirty::PARTIAL => DirtyState::Partial,
            ffi::RenderStateDirty::FULL => DirtyState::Full,
            _ => {
                return Err(abi_violation(
                    Operation::RenderStateGet,
                    AbiViolation::UnknownDiscriminant,
                ));
            }
        };

        let mut raw_colors: ffi::RenderStateColors = sized();
        // SAFETY: The state is live and immutably traversed, while `raw_colors`
        // is a correctly initialized public sized output struct.
        let result = unsafe {
            ffi::ghostty_render_state_colors_get(resources.state.as_ptr(), &mut raw_colors)
        };
        ffi_result(result, Operation::RenderStateGet)?;
        let colors = RenderColors {
            background: raw_colors.background.into(),
            foreground: raw_colors.foreground.into(),
            cursor: raw_colors
                .cursor_has_value
                .then(|| raw_colors.cursor.into()),
            palette: raw_colors.palette.map(Into::into),
        };

        let style_raw = render_get::<ffi::RenderStateCursorVisualStyle::Type>(
            resources,
            ffi::RenderStateData::CURSOR_VISUAL_STYLE,
        )?;
        let style = match style_raw {
            ffi::RenderStateCursorVisualStyle::BAR => CursorVisualStyle::Bar,
            ffi::RenderStateCursorVisualStyle::BLOCK => CursorVisualStyle::Block,
            ffi::RenderStateCursorVisualStyle::UNDERLINE => CursorVisualStyle::Underline,
            ffi::RenderStateCursorVisualStyle::BLOCK_HOLLOW => CursorVisualStyle::HollowBlock,
            _ => {
                return Err(abi_violation(
                    Operation::RenderStateGet,
                    AbiViolation::UnknownDiscriminant,
                ));
            }
        };
        let has_position =
            render_get::<bool>(resources, ffi::RenderStateData::CURSOR_VIEWPORT_HAS_VALUE)?;
        let viewport_position = if has_position {
            Some(ViewportPosition {
                column: render_get::<u16>(resources, ffi::RenderStateData::CURSOR_VIEWPORT_X)?,
                row: render_get::<u16>(resources, ffi::RenderStateData::CURSOR_VIEWPORT_Y)?,
            })
        } else {
            None
        };
        let cursor = CursorState {
            style,
            visible: render_get::<bool>(resources, ffi::RenderStateData::CURSOR_VISIBLE)?,
            blinking: render_get::<bool>(resources, ffi::RenderStateData::CURSOR_BLINKING)?,
            password_input: render_get::<bool>(
                resources,
                ffi::RenderStateData::CURSOR_PASSWORD_INPUT,
            )?,
            viewport_position,
            wide_tail: has_position
                && render_get::<bool>(resources, ffi::RenderStateData::CURSOR_VIEWPORT_WIDE_TAIL)?,
        };

        let mut iterator = resources.rows.as_ptr();
        // SAFETY: `iterator` is a live preallocated row iterator and the output
        // pointer type exactly matches `ROW_ITERATOR`. No render update can occur
        // while the returned view borrows `resources`.
        let result = unsafe {
            ffi::ghostty_render_state_get(
                resources.state.as_ptr(),
                ffi::RenderStateData::ROW_ITERATOR,
                ptr::from_mut(&mut iterator).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::RenderStateGet)?;
        if iterator != resources.rows.as_ptr() {
            return Err(abi_violation(
                Operation::RenderStateGet,
                AbiViolation::InvalidCallback,
            ));
        }

        Ok(Self {
            resources,
            columns,
            rows,
            dirty,
            colors,
            cursor,
            next_row: 0,
            _thread_confined: PhantomData,
        })
    }

    /// Viewport width in cells.
    #[must_use]
    pub fn columns(&self) -> u16 {
        self.columns
    }

    /// Viewport height in cells.
    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Global dirty state.
    #[must_use]
    pub fn dirty(&self) -> DirtyState {
        self.dirty
    }

    /// Copied render colors and palette.
    #[must_use]
    pub fn colors(&self) -> &RenderColors {
        &self.colors
    }

    /// Copied cursor state.
    #[must_use]
    pub fn cursor(&self) -> CursorState {
        self.cursor
    }

    /// Advance to the next viewport row.
    ///
    /// The returned row view mutably borrows this traversal, so two rows cannot
    /// alias the single reusable native iterator.
    pub fn next_row(&mut self) -> Result<Option<RowView<'_>>, GhosttyError> {
        if self.next_row >= self.rows {
            return Ok(None);
        }
        // SAFETY: The iterator is live, populated from this render state, and
        // exclusively accessed through the lending row view.
        let advanced =
            unsafe { ffi::ghostty_render_state_row_iterator_next(self.resources.rows.as_ptr()) };
        if !advanced {
            return Err(abi_violation(
                Operation::RenderRowGet,
                AbiViolation::ShortIterator,
            ));
        }
        let index = self.next_row;
        self.next_row += 1;
        Ok(Some(RowView {
            resources: self.resources,
            index,
            columns: self.columns,
            next_cell: 0,
            cells_ready: false,
            _thread_confined: PhantomData,
        }))
    }

    /// Clear the render state's global dirty flag after presentation.
    ///
    /// Row-level flags are independent and must be cleared through
    /// [`RowView::clear_dirty`] when incremental rendering consumes them.
    pub fn clear_dirty(&mut self) -> Result<(), GhosttyError> {
        let clean = ffi::RenderStateDirty::FALSE;
        // SAFETY: The render state is live and exclusively borrowed; `clean`
        // has the exact checked type for the DIRTY option.
        let result = unsafe {
            ffi::ghostty_render_state_set(
                self.resources.state.as_ptr(),
                ffi::RenderStateOption::DIRTY,
                ptr::from_ref(&clean).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::RenderStateSet)
    }
}

/// Borrowed traversal of one viewport row.
pub struct RowView<'render> {
    resources: &'render mut RenderResources,
    index: u16,
    columns: u16,
    next_cell: u16,
    cells_ready: bool,
    _thread_confined: PhantomData<Rc<()>>,
}

impl RowView<'_> {
    /// Zero-based viewport row index.
    #[must_use]
    pub fn index(&self) -> u16 {
        self.index
    }

    /// Whether this row is dirty.
    pub fn is_dirty(&self) -> Result<bool, GhosttyError> {
        row_get(self.resources, ffi::RenderStateRowData::DIRTY)
    }

    /// Whether this row soft-wraps into the next row.
    pub fn wraps_to_next(&self) -> Result<bool, GhosttyError> {
        let row = self.raw_row()?;
        row_value_get(row, ffi::RowData::WRAP)
    }

    /// Whether this row continues a soft-wrapped previous row.
    pub fn is_wrap_continuation(&self) -> Result<bool, GhosttyError> {
        let row = self.raw_row()?;
        row_value_get(row, ffi::RowData::WRAP_CONTINUATION)
    }

    /// Semantic prompt classification for this row.
    pub fn semantic_prompt(&self) -> Result<SemanticPrompt, GhosttyError> {
        let row = self.raw_row()?;
        let raw: ffi::RowSemanticPrompt::Type = row_value_get(row, ffi::RowData::SEMANTIC_PROMPT)?;
        match raw {
            ffi::RowSemanticPrompt::NONE => Ok(SemanticPrompt::None),
            ffi::RowSemanticPrompt::PROMPT => Ok(SemanticPrompt::Prompt),
            ffi::RowSemanticPrompt::PROMPT_CONTINUATION => Ok(SemanticPrompt::Continuation),
            _ => Err(abi_violation(
                Operation::RowGet,
                AbiViolation::UnknownDiscriminant,
            )),
        }
    }

    /// Row-local selected columns, if this row intersects the selection.
    pub fn selection(&self) -> Result<Option<SelectionRange>, GhosttyError> {
        let mut raw: ffi::RenderStateRowSelection = sized();
        // SAFETY: The row iterator is live and positioned, and `raw` is the
        // exact initialized sized output type for SELECTION.
        let result = unsafe {
            ffi::ghostty_render_state_row_get(
                self.resources.rows.as_ptr(),
                ffi::RenderStateRowData::SELECTION,
                ptr::from_mut(&mut raw).cast::<c_void>(),
            )
        };
        match result {
            ffi::Result::SUCCESS => Ok(Some(SelectionRange {
                start: raw.start_x,
                end: raw.end_x,
            })),
            ffi::Result::NO_VALUE => Ok(None),
            other => {
                ffi_result(other, Operation::RenderRowGet)?;
                unreachable!("successful result handled above")
            }
        }
    }

    /// Advance to the next cell in this row.
    ///
    /// Grapheme storage is reused across cells and is borrowed from the cell
    /// view, so callers cannot retain it while advancing.
    pub fn next_cell(&mut self) -> Result<Option<CellView<'_>>, GhosttyError> {
        if self.next_cell >= self.columns {
            return Ok(None);
        }
        if !self.cells_ready {
            let mut cells = self.resources.cells.as_ptr();
            // SAFETY: The row iterator is positioned and `cells` points to the
            // live reusable output handle documented for CELLS.
            let result = unsafe {
                ffi::ghostty_render_state_row_get(
                    self.resources.rows.as_ptr(),
                    ffi::RenderStateRowData::CELLS,
                    ptr::from_mut(&mut cells).cast::<c_void>(),
                )
            };
            ffi_result(result, Operation::RenderRowGet)?;
            if cells != self.resources.cells.as_ptr() {
                return Err(abi_violation(
                    Operation::RenderRowGet,
                    AbiViolation::InvalidCallback,
                ));
            }
            self.cells_ready = true;
        }
        // SAFETY: The cells iterator is live, populated for the current row,
        // and exclusively accessed through this lending iterator.
        let advanced =
            unsafe { ffi::ghostty_render_state_row_cells_next(self.resources.cells.as_ptr()) };
        if !advanced {
            return Err(abi_violation(
                Operation::RenderCellGet,
                AbiViolation::ShortIterator,
            ));
        }
        let column = self.next_cell;
        self.next_cell += 1;
        Ok(Some(CellView {
            resources: self.resources,
            column,
            _thread_confined: PhantomData,
        }))
    }

    /// Clear this row's dirty flag after presentation.
    pub fn clear_dirty(&mut self) -> Result<(), GhosttyError> {
        let clean = false;
        // SAFETY: The row iterator is live, positioned, and exclusively
        // borrowed; `clean` is the exact checked DIRTY option type.
        let result = unsafe {
            ffi::ghostty_render_state_row_set(
                self.resources.rows.as_ptr(),
                ffi::RenderStateRowOption::DIRTY,
                ptr::from_ref(&clean).cast::<c_void>(),
            )
        };
        ffi_result(result, Operation::RenderRowSet)
    }

    fn raw_row(&self) -> Result<ffi::Row, GhosttyError> {
        row_get(self.resources, ffi::RenderStateRowData::RAW)
    }
}

/// Borrowed view of one rendered cell.
pub struct CellView<'row> {
    resources: &'row mut RenderResources,
    column: u16,
    _thread_confined: PhantomData<Rc<()>>,
}

impl CellView<'_> {
    /// Zero-based viewport column.
    #[must_use]
    pub fn column(&self) -> u16 {
        self.column
    }

    /// Exact UTF-8 bytes for the cell's grapheme cluster.
    ///
    /// The slice is valid only until another mutable cell-view method or cell
    /// advance. Empty cells return an empty slice. Capacity grows only for an
    /// unusually large grapheme and is then reused, with a hard 16 KiB limit.
    pub fn grapheme_bytes(&mut self) -> Result<&[u8], GhosttyError> {
        let mut output = ffi::Buffer {
            ptr: self.resources.grapheme.as_mut_ptr(),
            cap: self.resources.grapheme.len(),
            len: 0,
        };
        // SAFETY: The cells iterator is live and positioned. `output` describes
        // writable storage for exactly `cap` bytes and remains live for the call.
        let mut result = unsafe {
            ffi::ghostty_render_state_row_cells_get(
                self.resources.cells.as_ptr(),
                ffi::RenderStateRowCellsData::GRAPHEMES_UTF8,
                ptr::from_mut(&mut output).cast::<c_void>(),
            )
        };
        if result == ffi::Result::OUT_OF_SPACE {
            if output.len > MAX_GRAPHEME_BYTES {
                return Err(GhosttyError::OutOfSpace {
                    operation: Operation::RenderCellGet,
                    required: output.len,
                    limit: MAX_GRAPHEME_BYTES,
                });
            }
            self.resources.grapheme.resize(output.len, 0);
            output.ptr = self.resources.grapheme.as_mut_ptr();
            output.cap = self.resources.grapheme.len();
            output.len = 0;
            // SAFETY: The iterator remains positioned and the resized vector now
            // provides the required stable writable storage for this call.
            result = unsafe {
                ffi::ghostty_render_state_row_cells_get(
                    self.resources.cells.as_ptr(),
                    ffi::RenderStateRowCellsData::GRAPHEMES_UTF8,
                    ptr::from_mut(&mut output).cast::<c_void>(),
                )
            };
        }
        ffi_result(result, Operation::RenderCellGet)?;
        if output.len > self.resources.grapheme.len() {
            return Err(abi_violation(
                Operation::RenderCellGet,
                AbiViolation::InvalidLength,
            ));
        }
        Ok(&self.resources.grapheme[..output.len])
    }

    /// Validated UTF-8 text for the cell's grapheme cluster.
    pub fn grapheme_text(&mut self) -> Result<&str, GhosttyError> {
        std::str::from_utf8(self.grapheme_bytes()?).map_err(|_| GhosttyError::InvalidUtf8 {
            field: TextField::Grapheme,
        })
    }

    /// Width behavior for this cell.
    pub fn width(&self) -> Result<CellWidth, GhosttyError> {
        let cell = self.raw_cell()?;
        let raw: ffi::CellWide::Type = cell_value_get(cell, ffi::CellData::WIDE)?;
        match raw {
            ffi::CellWide::NARROW => Ok(CellWidth::Narrow),
            ffi::CellWide::WIDE => Ok(CellWidth::Wide),
            ffi::CellWide::SPACER_TAIL => Ok(CellWidth::SpacerTail),
            ffi::CellWide::SPACER_HEAD => Ok(CellWidth::SpacerHead),
            _ => Err(abi_violation(
                Operation::CellGet,
                AbiViolation::UnknownDiscriminant,
            )),
        }
    }

    /// Semantic content classification for this cell.
    pub fn semantic_content(&self) -> Result<SemanticContent, GhosttyError> {
        let cell = self.raw_cell()?;
        let raw: ffi::CellSemanticContent::Type =
            cell_value_get(cell, ffi::CellData::SEMANTIC_CONTENT)?;
        match raw {
            ffi::CellSemanticContent::OUTPUT => Ok(SemanticContent::Output),
            ffi::CellSemanticContent::INPUT => Ok(SemanticContent::Input),
            ffi::CellSemanticContent::PROMPT => Ok(SemanticContent::Prompt),
            _ => Err(abi_violation(
                Operation::CellGet,
                AbiViolation::UnknownDiscriminant,
            )),
        }
    }

    /// Complete style copied from the cell.
    pub fn style(&self) -> Result<CellStyle, GhosttyError> {
        let mut raw: ffi::Style = sized();
        cell_get_into(
            self.resources,
            ffi::RenderStateRowCellsData::STYLE,
            &mut raw,
        )?;
        Ok(CellStyle {
            foreground: style_color(raw.fg_color)?,
            background: style_color(raw.bg_color)?,
            underline_color: style_color(raw.underline_color)?,
            bold: raw.bold,
            italic: raw.italic,
            faint: raw.faint,
            blink: raw.blink,
            inverse: raw.inverse,
            invisible: raw.invisible,
            strikethrough: raw.strikethrough,
            overline: raw.overline,
            underline: match raw.underline {
                0 => Underline::None,
                1 => Underline::Single,
                2 => Underline::Double,
                3 => Underline::Curly,
                4 => Underline::Dotted,
                5 => Underline::Dashed,
                _ => {
                    return Err(abi_violation(
                        Operation::RenderCellGet,
                        AbiViolation::UnknownDiscriminant,
                    ));
                }
            },
        })
    }

    /// Resolved foreground color, or `None` for the render default.
    pub fn foreground(&self) -> Result<Option<Rgb>, GhosttyError> {
        self.resolved_color(ffi::RenderStateRowCellsData::FG_COLOR)
    }

    /// Resolved background color, or `None` for the render default.
    pub fn background(&self) -> Result<Option<Rgb>, GhosttyError> {
        self.resolved_color(ffi::RenderStateRowCellsData::BG_COLOR)
    }

    /// Whether this cell belongs to the current selection.
    pub fn is_selected(&self) -> Result<bool, GhosttyError> {
        cell_get(self.resources, ffi::RenderStateRowCellsData::SELECTED)
    }

    fn resolved_color(
        &self,
        data: ffi::RenderStateRowCellsData::Type,
    ) -> Result<Option<Rgb>, GhosttyError> {
        let mut raw = ffi::ColorRgb::default();
        // SAFETY: The cells iterator is live and positioned, and `raw` exactly
        // matches the checked output type for foreground/background colors.
        let result = unsafe {
            ffi::ghostty_render_state_row_cells_get(
                self.resources.cells.as_ptr(),
                data,
                ptr::from_mut(&mut raw).cast::<c_void>(),
            )
        };
        match result {
            ffi::Result::SUCCESS => Ok(Some(raw.into())),
            ffi::Result::INVALID_VALUE | ffi::Result::NO_VALUE => Ok(None),
            other => {
                ffi_result(other, Operation::RenderCellGet)?;
                unreachable!("successful result handled above")
            }
        }
    }

    fn raw_cell(&self) -> Result<ffi::Cell, GhosttyError> {
        cell_get(self.resources, ffi::RenderStateRowCellsData::RAW)
    }
}

fn style_color(raw: ffi::StyleColor) -> Result<StyleColor, GhosttyError> {
    match raw.tag {
        ffi::StyleColorTag::NONE => Ok(StyleColor::None),
        ffi::StyleColorTag::PALETTE => {
            // SAFETY: The checked public tag states that the palette union field
            // is active for this copied value.
            Ok(StyleColor::Palette(unsafe { raw.value.palette }))
        }
        ffi::StyleColorTag::RGB => {
            // SAFETY: The checked public tag states that the RGB union field is
            // active for this copied value.
            Ok(StyleColor::Rgb(unsafe { raw.value.rgb }.into()))
        }
        _ => Err(abi_violation(
            Operation::RenderCellGet,
            AbiViolation::UnknownDiscriminant,
        )),
    }
}

fn render_get<T: Default>(
    resources: &RenderResources,
    data: ffi::RenderStateData::Type,
) -> Result<T, GhosttyError> {
    let mut output = T::default();
    // SAFETY: Every private call site pairs a checked RenderStateData key with
    // its exact public output type. The state and output storage are live.
    let result = unsafe {
        ffi::ghostty_render_state_get(
            resources.state.as_ptr(),
            data,
            ptr::from_mut(&mut output).cast::<c_void>(),
        )
    };
    ffi_result(result, Operation::RenderStateGet)?;
    Ok(output)
}

fn row_get<T: Default>(
    resources: &RenderResources,
    data: ffi::RenderStateRowData::Type,
) -> Result<T, GhosttyError> {
    let mut output = T::default();
    // SAFETY: Every private call site pairs a checked row key with its exact
    // output type. The iterator is live, positioned, and not concurrently used.
    let result = unsafe {
        ffi::ghostty_render_state_row_get(
            resources.rows.as_ptr(),
            data,
            ptr::from_mut(&mut output).cast::<c_void>(),
        )
    };
    ffi_result(result, Operation::RenderRowGet)?;
    Ok(output)
}

fn cell_get<T: Default>(
    resources: &RenderResources,
    data: ffi::RenderStateRowCellsData::Type,
) -> Result<T, GhosttyError> {
    let mut output = T::default();
    cell_get_into(resources, data, &mut output)?;
    Ok(output)
}

fn cell_get_into<T>(
    resources: &RenderResources,
    data: ffi::RenderStateRowCellsData::Type,
    output: &mut T,
) -> Result<(), GhosttyError> {
    // SAFETY: Every private call site pairs a checked cell key with its exact
    // output type. The cells iterator is live, positioned, and exclusive.
    let result = unsafe {
        ffi::ghostty_render_state_row_cells_get(
            resources.cells.as_ptr(),
            data,
            ptr::from_mut(output).cast::<c_void>(),
        )
    };
    ffi_result(result, Operation::RenderCellGet)
}

fn row_value_get<T: Default>(row: ffi::Row, data: ffi::RowData::Type) -> Result<T, GhosttyError> {
    let mut output = T::default();
    // SAFETY: `row` is an opaque copied value from the currently live render
    // row and every call pairs a public key with its exact output type.
    let result =
        unsafe { ffi::ghostty_row_get(row, data, ptr::from_mut(&mut output).cast::<c_void>()) };
    ffi_result(result, Operation::RowGet)?;
    Ok(output)
}

fn cell_value_get<T: Default>(
    cell: ffi::Cell,
    data: ffi::CellData::Type,
) -> Result<T, GhosttyError> {
    let mut output = T::default();
    // SAFETY: `cell` is an opaque copied value from the currently live render
    // cell and every call pairs a public key with its exact output type.
    let result =
        unsafe { ffi::ghostty_cell_get(cell, data, ptr::from_mut(&mut output).cast::<c_void>()) };
    ffi_result(result, Operation::CellGet)?;
    Ok(output)
}
