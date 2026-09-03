# Terminal conformance and compatibility

`tests/conformance/manifest.json` owns the inventory of hostile-input decoders and version boundaries. Each entry names its owner, input bound, current and previous supported versions, corpus, fuzz target, and compatibility rule. New wire or persisted formats must update the manifest and include a malformed vector.

The capable terminal path is protocol v4: an opaque Ghostty snapshot at inclusive byte cut `N`, `READY @ N`, then raw PTY bytes beginning at `N + 1`. Semantic v3 remains compatibility-only. Protocol v1 is accepted only at the network edge for the declared support window; it does not weaken v4 state or mutation fences.

Run:

```sh
vp run test:terminal:protocol
vp run test:fuzz:smoke
vp run test:compatibility
```

Fuzz and property failures must retain a stable seed, bounded scrubbed input, target, commit, and exact replay command. Corpus data is never executed as a command and targets do not access public hosts.

## Version sunset

The support window is the current release plus one explicitly named legacy edge protocol. Removing that adapter requires updating `tests/conformance/compatibility.json`, release notes, and the machine-readable compatibility report. Reset-only persisted formats must fail clearly or be explicitly reset; they are never partially loaded.
