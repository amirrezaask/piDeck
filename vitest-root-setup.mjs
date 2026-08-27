import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(root, 'apps/web/package.json'));
const { cleanup } = require('@testing-library/react');
const matchers = require('@testing-library/jest-dom/matchers');

expect.extend(matchers);
afterEach(cleanup);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverStub,
  configurable: true,
});

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  value: () => undefined,
  configurable: true,
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  value: () => undefined,
  configurable: true,
});
