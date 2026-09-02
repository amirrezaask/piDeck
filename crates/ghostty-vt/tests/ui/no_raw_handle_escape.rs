use ghostty_vt::{Terminal, TerminalOptions};

fn main() {
    let terminal = Terminal::new(TerminalOptions::default()).unwrap();
    let _raw = terminal.as_raw();
}
