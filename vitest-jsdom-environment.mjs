import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(path.resolve(root, 'apps/web/package.json'))('jsdom');

const DOM_GLOBALS = new Set([
  'DOMException',
  'URL',
  'URLSearchParams',
  'EventTarget',
  'NamedNodeMap',
  'Node',
  'Attr',
  'Element',
  'DocumentFragment',
  'DOMImplementation',
  'Document',
  'XMLDocument',
  'CharacterData',
  'Text',
  'Comment',
  'DocumentType',
  'NodeList',
  'RadioNodeList',
  'HTMLCollection',
  'HTMLOptionsCollection',
  'DOMStringMap',
  'DOMTokenList',
  'StyleSheetList',
  'HTMLElement',
  'HTMLHeadElement',
  'HTMLTitleElement',
  'HTMLBaseElement',
  'HTMLLinkElement',
  'HTMLMetaElement',
  'HTMLStyleElement',
  'HTMLBodyElement',
  'HTMLHeadingElement',
  'HTMLParagraphElement',
  'HTMLHRElement',
  'HTMLPreElement',
  'HTMLUListElement',
  'HTMLOListElement',
  'HTMLLIElement',
  'HTMLMenuElement',
  'HTMLDListElement',
  'HTMLDivElement',
  'HTMLAnchorElement',
  'HTMLAreaElement',
  'HTMLBRElement',
  'HTMLButtonElement',
  'HTMLCanvasElement',
  'HTMLDataElement',
  'HTMLDataListElement',
  'HTMLDetailsElement',
  'HTMLDialogElement',
  'HTMLDirectoryElement',
  'HTMLFieldSetElement',
  'HTMLFontElement',
  'HTMLFormElement',
  'HTMLHtmlElement',
  'HTMLImageElement',
  'HTMLInputElement',
  'HTMLLabelElement',
  'HTMLLegendElement',
  'HTMLMapElement',
  'HTMLMediaElement',
  'HTMLMeterElement',
  'HTMLModElement',
  'HTMLOptGroupElement',
  'HTMLOptionElement',
  'HTMLOutputElement',
  'HTMLPictureElement',
  'HTMLProgressElement',
  'HTMLQuoteElement',
  'HTMLScriptElement',
  'HTMLSelectElement',
  'HTMLSlotElement',
  'HTMLSourceElement',
  'HTMLSpanElement',
  'HTMLTableCaptionElement',
  'HTMLTableCellElement',
  'HTMLTableColElement',
  'HTMLTableElement',
  'HTMLTimeElement',
  'HTMLTableRowElement',
  'HTMLTableSectionElement',
  'HTMLTemplateElement',
  'HTMLTextAreaElement',
  'HTMLUnknownElement',
  'HTMLFrameElement',
  'HTMLFrameSetElement',
  'HTMLIFrameElement',
  'HTMLEmbedElement',
  'HTMLObjectElement',
  'HTMLParamElement',
  'HTMLVideoElement',
  'HTMLAudioElement',
  'HTMLTrackElement',
  'HTMLFormControlsCollection',
  'SVGElement',
  'SVGGraphicsElement',
  'SVGSVGElement',
  'SVGTitleElement',
  'SVGAnimatedString',
  'SVGNumber',
  'SVGStringList',
  'FileReader',
  'Blob',
  'File',
  'FileList',
  'ValidityState',
  'DOMParser',
  'XMLSerializer',
  'FormData',
  'XMLHttpRequestEventTarget',
  'XMLHttpRequestUpload',
  'XMLHttpRequest',
  'WebSocket',
  'NodeFilter',
  'NodeIterator',
  'TreeWalker',
  'AbstractRange',
  'Range',
  'StaticRange',
  'Selection',
  'Storage',
  'CustomElementRegistry',
  'ShadowRoot',
  'MutationObserver',
  'MutationRecord',
  'Headers',
  'AbortController',
  'AbortSignal',
  'DOMRectReadOnly',
  'DOMRect',
  'Image',
  'Audio',
  'Option',
  'CSS',
  'Event',
  'CloseEvent',
  'CustomEvent',
  'MessageEvent',
  'ErrorEvent',
  'HashChangeEvent',
  'PopStateEvent',
  'StorageEvent',
  'ProgressEvent',
  'PageTransitionEvent',
  'SubmitEvent',
  'UIEvent',
  'FocusEvent',
  'InputEvent',
  'MouseEvent',
  'KeyboardEvent',
  'TouchEvent',
  'CompositionEvent',
  'WheelEvent',
  'BarProp',
  'External',
  'Location',
  'History',
  'Screen',
  'Crypto',
  'Navigator',
  'PluginArray',
  'MimeTypeArray',
  'Plugin',
  'MimeType',
  'addEventListener',
  'cancelAnimationFrame',
  'dispatchEvent',
  'document',
  'focus',
  'getComputedStyle',
  'history',
  'innerHeight',
  'innerWidth',
  'location',
  'matchMedia',
  'navigator',
  'outerHeight',
  'outerWidth',
  'pageXOffset',
  'pageYOffset',
  'postMessage',
  'removeEventListener',
  'requestAnimationFrame',
  'screen',
]);

function installWindow(global, window) {
  const keys = new Set([...DOM_GLOBALS, ...Object.getOwnPropertyNames(window)]);
  const originals = new Map();
  const overrides = new Map();
  const installed = new Set();

  for (const key of keys) {
    if (key === 'window' || key === 'self' || key === 'top' || key === 'parent') continue;
    if (!DOM_GLOBALS.has(key) && key in global) continue;

    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (descriptor && descriptor.configurable === false) continue;
    if (descriptor) originals.set(key, descriptor);

    const value = window[key];
    const boundFunction =
      typeof value === 'function' && key[0] !== key[0].toUpperCase()
        ? value.bind(window)
        : undefined;
    Object.defineProperty(global, key, {
      configurable: true,
      get() {
        if (overrides.has(key)) return overrides.get(key);
        return boundFunction ?? window[key];
      },
      set(value) {
        overrides.set(key, value);
      },
    });
    installed.add(key);
  }

  const specialGlobals = new Map();
  for (const key of ['window', 'self', 'top', 'parent']) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (descriptor) specialGlobals.set(key, descriptor);
    global[key] = global;
  }

  if (global.document?.defaultView) {
    Object.defineProperty(global.document, 'defaultView', {
      configurable: true,
      enumerable: true,
      get: () => global,
    });
  }

  return () => {
    window.close();
    for (const key of installed) {
      if (originals.has(key)) {
        Object.defineProperty(global, key, originals.get(key));
      } else {
        delete global[key];
      }
    }
    for (const key of ['window', 'self', 'top', 'parent']) {
      const descriptor = specialGlobals.get(key);
      if (descriptor) Object.defineProperty(global, key, descriptor);
      else delete global[key];
    }
  };
}

export default {
  name: 'jsdom',
  viteEnvironment: 'client',
  setup(global, { jsdom: options = {} } = {}) {
    const { html = '<!DOCTYPE html>', ...jsdomOptions } = options;
    const dom = new JSDOM(html, {
      url: 'http://localhost:3000',
      pretendToBeVisual: true,
      ...jsdomOptions,
    });
    return { teardown: installWindow(global, dom.window) };
  },
};
