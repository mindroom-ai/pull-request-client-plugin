import type { CSSProperties } from 'react';
import { color, config } from 'folds';

/**
 * The variables `styles.css` draws with, from the app's theme tokens, so the card and the panel
 * follow the light and dark themes. Set on the root element of each of them.
 */
export function pluginRootStyle(): CSSProperties {
  return {
    '--pr-fg': color.Surface.OnContainer,
    '--pr-muted': color.SurfaceVariant.OnContainer,
    '--pr-border': color.Surface.ContainerLine,
    '--pr-surface': color.Surface.Container,
    '--pr-hover': color.Surface.ContainerHover,
    '--pr-added': color.Success.Main,
    '--pr-removed': color.Critical.Main,
    '--pr-warning': color.Warning.Main,
    '--pr-open': color.Success.Main,
    '--pr-closed': color.Critical.Main,
    '--pr-merged': color.Primary.Main,
    '--pr-draft': color.SurfaceVariant.OnContainer,
    '--pr-primary': color.Primary.Main,
    '--pr-font-sans': config.font.Inter,
    '--pr-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  } as CSSProperties;
}
