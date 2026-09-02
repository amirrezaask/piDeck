use ghostty_vt::{GhosttyError, RenderView, Terminal, TerminalOptions};

fn main() {
    let mut terminal = Terminal::new(TerminalOptions::default()).unwrap();
    let _retained: &mut RenderView<'_> = terminal
        .with_render_state(|render| Ok::<_, GhosttyError>(render))
        .unwrap();
}
