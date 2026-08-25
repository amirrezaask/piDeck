# Deep modules

Packages use this copy-me layout:

```text
packages/<name>/
  index.ts       # public entry point
  client.ts      # optional additional public entry point
  lib/           # private implementation
  tests/         # co-located tests and fixtures
```

Import only through a package's entry points — its root files. Files in any package subfolder are private, including `lib/` and implementation files under `src/` in older packages. A package may expose several small entry points; explicitly discourage giant barrel files that re-export a whole subtree through one index.

`lint:boundaries` enforces four rules: code outside a package can import only its root entry points; files within a package can import its own internals; tests use package entry points and may share their own test fixtures but may not deep-import package internals; and the dependency graph must not contain cycles.

Copy the `example/` package when starting a new package, or delete it if it is not useful. Run the boundary check with:

```sh
pnpm lint:boundaries
```
