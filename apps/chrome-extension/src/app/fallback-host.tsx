import type { PaletteClient } from './palette-client';
import { CommandPalette } from '/src/components/command-palette/command-palette';

interface FallbackHostProps {
  readonly client: PaletteClient;
}

export function FallbackHost({ client }: FallbackHostProps) {
  return (
    <CommandPalette
      open
      standalone
      portalContainer={document.body}
      client={client}
      onClose={() => window.close()}
    />
  );
}
