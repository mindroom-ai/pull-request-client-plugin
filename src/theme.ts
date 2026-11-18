import type { CSSProperties } from 'react';
import { color, config } from 'folds';

/**
 * The variables `styles.css` draws with, from the app's theme tokens, so the card and the panel
 * follow the light and dark themes. Set on the root element of each of them. A pull request's
 * state is the exception: GitHub's green, red, purple and gray, the same in every theme.
 */
export function pluginRootStyle(): CSSProperties {
  return {
    '--pr-fg': color.Surface.OnContainer,
    '--pr-muted': color.SurfaceVariant.OnContainer,
    '--pr-border': color.Surface.ContainerLine,
    '--pr-surface': color.Surface.Container,
    // The side panel's own background, which the app's panel frame draws behind it.
    '--pr-panel': color.Background.Container,
    '--pr-hover': color.Surface.ContainerHover,
    '--pr-added': color.Success.Main,
    '--pr-removed': color.Critical.Main,
    '--pr-warning': color.Warning.Main,
    '--pr-open': '#2da44e',
    '--pr-closed': '#da3633',
    '--pr-merged': '#8957e5',
    '--pr-draft': '#848d97',
    '--pr-primary': color.Primary.Main,
    '--pr-primary-container-line': color.Primary.ContainerLine,
    '--pr-on-primary-container': color.Primary.OnContainer,
    '--pr-font-sans': config.font.Inter,
    '--pr-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  } as CSSProperties;
}
