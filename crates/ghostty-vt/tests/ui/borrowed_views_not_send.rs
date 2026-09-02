use ghostty_vt::{PtyResponses, RenderView};

fn assert_send<T: Send>() {}

fn main() {
    assert_send::<RenderView<'static>>();
    assert_send::<PtyResponses<'static>>();
}
