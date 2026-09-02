use ghostty_vt::{Terminal, TerminalOptions};

fn main() {
    let terminal = Terminal::new(TerminalOptions::default()).unwrap();
    std::thread::spawn(move || drop(terminal));
}
