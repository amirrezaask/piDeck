use ghostty_vt::Terminal;

fn assert_sync<T: Sync>() {}

fn main() {
    assert_sync::<Terminal>();
}
