use ghostty_vt::{Terminal, TerminalOptions};

fn main() {
    let mut terminal = Terminal::new(TerminalOptions::default()).unwrap();
    let effects = terminal.write(b"first").unwrap();
    terminal.write(b"second").unwrap();
    assert!(effects.is_empty());
}
