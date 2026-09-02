import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('reduce') ? false : query.includes('dark'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

HTMLElement.prototype.scrollIntoView = () => undefined;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub });
