import ReactDOM from 'react-dom/client';

import { createPaletteClient } from '/src/app/palette-client';
import { PaletteHost } from '/src/app/palette-host';
import { ContentRuntime } from '/src/runtime/content-runtime';
import '/src/styles/globals.css';

const HOST_SELECTOR = 'wxt-switcher-overlay';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  cssInjectionMode: 'ui',
  world: 'ISOLATED',
  allFrames: false,
  runAt: 'document_idle',
  async main(context) {
    if (document.querySelector(HOST_SELECTOR) !== null) return;
    const ui = await createShadowRootUi(context, {
      name: 'switcher-overlay',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        container.id = 'switcher-shadow-container';
        const app = document.createElement('div');
        app.id = 'switcher-root-container';
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(
          <PaletteHost client={createPaletteClient(ContentRuntime)} portalContainer={container} />,
        );
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
    context.onInvalidated(() => {
      ui.remove();
      void ContentRuntime.dispose();
    });
  },
});
