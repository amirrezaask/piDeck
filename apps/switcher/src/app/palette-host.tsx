import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import { CommandPalette } from '/src/components/command-palette/command-palette';
import { PaletteToggleSchema } from '/src/protocol/messages';
import { Schema } from 'effect';
import type { PaletteClient } from './palette-client';

interface PaletteHostProps {
  readonly client: PaletteClient;
  readonly portalContainer: HTMLElement | null;
}

export function PaletteHost({ client, portalContainer }: PaletteHostProps) {
  const [open, setOpen] = useState(true);
  const [previousFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => previousFocus?.focus({ preventScroll: true }));
  }, [previousFocus]);

  useEffect(() => {
    const listener = (input: unknown) => {
      const decoded = Schema.decodeUnknownEither(PaletteToggleSchema)(input);
      if (decoded._tag === 'Right') setOpen((current) => !current);
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <CommandPalette
      open={open}
      standalone={false}
      portalContainer={portalContainer}
      client={client}
      onClose={close}
    />
  );
}
