use ghostty_vt::{CellView, RowView, TerminalEffects};

fn assert_sync<T: Sync>() {}

fn main() {
    assert_sync::<RowView<'static>>();
    assert_sync::<CellView<'static>>();
    assert_sync::<TerminalEffects<'static>>();
}
