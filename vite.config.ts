import { defineConfig } from "vite-plus";

const recoveryFilterActive = process.argv.some(argument =>
  argument.includes("tests/recovery"),
);

export default defineConfig({
  pack: {
    platform: "node",
    format: ["esm"],
    deps: {
      onlyBundle: false,
      neverBundle: ["node-pty"],
    },
  },
  // Existing sources are not Oxfmt-clean yet; keep formatting opt-in while
  // this migration preserves the repository's current source formatting.
  check: { fmt: false },
  fmt: {},
  lint: {
    plugins: ["react", "unicorn", "typescript", "oxc"],
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".repos/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
    ],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    rules: {
      "eslint/no-unused-vars": "error",
      "react/jsx-no-constructed-context-values": "error",
      "react/no-object-type-as-default-prop": "error",
      "react/no-unstable-nested-components": ["error", { allowAsProps: true }],
      "react/exhaustive-deps": "error",
      "unicorn/prefer-set-has": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: false, typeCheck: false },
  },
  test: {
    exclude: recoveryFilterActive
      ? [
          ".repos/**",
          "tests/bench/**",
          "tests/chaos/**",
          "tests/fixtures/**",
          "tests/helpers/**",
          "tests/multi-server/**",
          "tests/platform/**",
          "tests/runtime/**",
          "tests/security/**",
          "tests/shell/**",
          "tests/soak/**",
          "tests/web/**",
          "**/node_modules/**",
          "**/dist/**",
          "**/out/**",
        ]
      : [
          ".repos/**",
          "tests/bench/**",
          "tests/chaos/**",
          "tests/fixtures/**",
          "tests/helpers/**",
          "tests/multi-server/**",
          "tests/platform/**",
          "tests/runtime/**",
          "tests/security/**",
          "tests/shell/**",
          "tests/soak/**",
          "tests/web/**",
          "**/node_modules/**",
          "**/dist/**",
          "**/out/**",
        ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  run: {
    tasks: {
      "test:security:e2e": {
        command: "vp exec playwright test --project=security-e2e --pass-with-no-tests",
        cache: false,
      },
      "test:platform:e2e": {
        command: "vp exec playwright test --project=platform-e2e --pass-with-no-tests",
        cache: false,
      },
    },
  },
});
