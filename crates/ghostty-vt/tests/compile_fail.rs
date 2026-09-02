//! Compile-fail ownership contract tests.

#[test]
fn ownership_and_thread_confinement_are_enforced() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}
