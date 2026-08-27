import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(root, 'apps/web/package.json'));
const { createElement, forwardRef } = require('react');

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
const components = new Map();

export const AnimatePresence = ({ children }) => children;
export const LayoutGroup = ({ children }) => children;
export const MotionConfig = ({ children }) => children;
export const useReducedMotion = () => true;
export const motion = new Proxy(
  {},
  {
    get: (_target, tag) => {
      const existing = components.get(tag);
      if (existing) return existing;
      const component = forwardRef(({ children, ...props }, ref) => {
        const htmlProps = Object.fromEntries(
          Object.entries(props).filter(([name]) => !motionProps.has(name)),
        );
        return createElement(tag, { ...htmlProps, ref }, children);
      });
      components.set(tag, component);
      return component;
    },
  },
);
