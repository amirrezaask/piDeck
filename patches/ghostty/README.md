# Ghostty patches

`prepare-ghostty-source.mjs` applies these patches to the revision pinned in
`packages/ghostty-core/src/vendor/VERSION`. Native and WASM builds verify and
consume the same patched tree.

## `lib-vt-osc-color-reports.patch`

Ghostty's application stream handler answers OSC 4/10/11/12 color queries, but
the public `libghostty-vt` terminal stream at the pinned revision discards those
query actions. The patch routes 16-bit color reports through the public
write-PTY effect, matching Ghostty's default report format without adding a
second parser in the server.

Remove the patch after the pinned upstream revision provides equivalent public
behavior. Regenerate it as an exact `git diff --binary HEAD` patch; preparation
rejects any source tree whose diff does not match the tracked bytes.
