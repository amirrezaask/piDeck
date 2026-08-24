import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';
import { afterEach, vi } from 'vitest';

const motionProps = new Set([
  'animate',
  'exit',
  'initial',
  'layout',
  'layoutId',
  'transition',
  'whileFocus',
  'whileHover',
  'whileTap',
]);

vi.mock('motion/react', () => {
  const components = new Map<
    string,
    ReturnType<typeof forwardRef<HTMLElement, Record<string, unknown> & { children?: ReactNode }>>
  >();
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    LayoutGroup: ({ children }: { children: ReactNode }) => children,
    MotionConfig: ({ children }: { children: ReactNode }) => children,
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => {
          const existing = components.get(tag);
          if (existing) return existing;
          const component = forwardRef<
            HTMLElement,
            Record<string, unknown> & { children?: ReactNode }
          >(({ children, ...props }, ref) => {
            const htmlProps = Object.fromEntries(
              Object.entries(props).filter(([name]) => !motionProps.has(name)),
            );
            return createElement(tag, { ...htmlProps, ref }, children as ReactNode);
          });
          components.set(tag, component);
          return component;
        },
      },
    ),
    useReducedMotion: () => true,
  };
});

afterEach(cleanup);

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverStub,
  configurable: true,
});

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  value: () => undefined,
  configurable: true,
});
