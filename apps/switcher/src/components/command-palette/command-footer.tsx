import { AlertTriangleIcon, MoonIcon, MonitorIcon, SunIcon } from 'lucide-react';

import { Button } from '/src/components/ui/button';
import type { ThemePreference } from '/src/domain/theme';

interface CommandFooterProps {
  readonly shortcut: string | undefined;
  readonly theme: ThemePreference;
  readonly onTheme: (theme: ThemePreference) => void;
}

const nextTheme: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const themeIcon = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
} as const;

export function CommandFooter({ shortcut, theme, onTheme }: CommandFooterProps) {
  const ThemeIcon = themeIcon[theme];
  const themeLabel = `${theme.charAt(0).toLocaleUpperCase()}${theme.slice(1)} theme`;

  return (
    <footer className="flex min-h-9 items-center gap-3 px-3 text-[11px] text-muted-foreground">
      {shortcut === undefined ? (
        <span className="flex items-center gap-1.5 text-warning">
          <AlertTriangleIcon /> Shortcut unassigned
        </span>
      ) : (
        <span className="font-medium text-muted-foreground/80">{shortcut}</span>
      )}
      <span className="ml-auto hidden items-center gap-3 sm:flex" aria-label="Keyboard help">
        <span>
          <kbd>↑↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`${themeLabel}. Switch theme`}
        title={`${themeLabel}. Click to switch.`}
        onClick={() => onTheme(nextTheme[theme])}
      >
        <ThemeIcon />
      </Button>
    </footer>
  );
}
