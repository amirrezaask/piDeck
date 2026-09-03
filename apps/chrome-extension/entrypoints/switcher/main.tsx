import ReactDOM from 'react-dom/client';

import { createPaletteClient } from '/src/app/palette-client';
import { FallbackHost } from '/src/app/fallback-host';
import { ContentRuntime } from '/src/runtime/content-runtime';
import '/src/styles/globals.css';

const root = document.querySelector('#root');
if (root === null) throw new Error('Switcher root was not found.');
ReactDOM.createRoot(root).render(<FallbackHost client={createPaletteClient(ContentRuntime)} />);
