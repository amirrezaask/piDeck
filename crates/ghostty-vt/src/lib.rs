#![doc = r#"A safe, thread-confined Rust interface to YAADE's pinned `libghostty-vt`.

The module is deliberately smaller than the C interface. [`Terminal`] owns all
native resources through RAII, cannot move between threads, and allows no raw
handle escape. Native effect callbacks only copy into a pinned bounded outbox;
callers can inspect PTY response bytes only after the native parser call returns.
Render data is available only through a closure and lending row/cell views, so
no native pointer can survive a terminal mutation.

A terminal-owner loop uses the interface synchronously:

```
use ghostty_vt::{Terminal, TerminalOptions};

let mut terminal = Terminal::new(TerminalOptions::default())?;
let effects = terminal.write(b"hello\r\n\x1b[6n")?;
for response in effects.pty_responses() {
    // Enqueue `response` to the PTY only here, after `write` returned.
    let _ = response;
}
drop(effects);

terminal.with_render_state(|render| {
    while let Some(mut row) = render.next_row()? {
        while let Some(mut cell) = row.next_cell()? {
            let _text = cell.grapheme_text()?;
        }
    }
    Ok(())
})?;
# Ok::<(), ghostty_vt::GhosttyError>(())
```

Thread confinement is part of the type contract:

```compile_fail
use ghostty_vt::{Terminal, TerminalOptions};

let terminal = Terminal::new(TerminalOptions::default()).unwrap();
std::thread::spawn(move || drop(terminal));
```
"#]
#![deny(unsafe_op_in_unsafe_fn)]

mod effects;
mod error;
mod ffi_util;
mod formatter;
mod grid;
mod render;
mod terminal;
mod types;

pub use effects::{
    ColorScheme, DeviceAttributes, EffectLimits, EffectOptions, MAX_EFFECT_EVENTS,
    MAX_EFFECT_TEXT_BYTES, MAX_PTY_RESPONSE_BYTES, MAX_PTY_RESPONSES, MAX_QUERY_RESPONSE_BYTES,
    PtyResponses, QueryCounts, TerminalEffects, TerminalSize,
};
pub use error::{AbiViolation, EffectKind, GhosttyError, Operation, TextField, ValueField};
pub use formatter::{Format, FormatExtras, FormatOptions, FormatScreenExtras, MAX_FORMAT_BYTES};
pub use grid::{CoordinateSpace, TerminalPoint, TrackedGridRef};
pub use render::{
    CellStyle, CellView, CellWidth, CursorState, CursorVisualStyle, DirtyState, RenderColors,
    RenderView, RowView, SelectionRange, SemanticContent, SemanticPrompt, StyleColor, Underline,
    ViewportPosition,
};
pub use terminal::{
    ActiveScreen, MAX_APC_BYTES, MAX_SCROLLBACK_ROWS, Mode, ScrollbarState, Terminal,
    TerminalColors, TerminalOptions, TerminalState, build_revision,
};
pub use types::{Rgb, TerminalText};

#[cfg(test)]
mod tests;
