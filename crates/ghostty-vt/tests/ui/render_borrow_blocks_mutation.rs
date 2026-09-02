use ghostty_vt::{Terminal, TerminalOptions};

fn main() {
    let mut terminal = Terminal::new(TerminalOptions::default()).unwrap();
    terminal
        .with_render_state(|render| {
            let row = render.next_row()?.unwrap();
            terminal.write(b"mutate")?;
            drop(row);
            Ok(())
        })
        .unwrap();
}
