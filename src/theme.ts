import type { CSSProperties } from 'react';
import { color, config } from 'folds';

/**
 * The variables `styles.css` draws with, from the app's theme tokens, so the card and the panel
 * follow the light and dark themes. Set on the root element of each of them. A pull request's
 * state and file-kind palette are the exception: fixed categorical colors readable in every theme.
 */
export function pluginRootStyle(): CSSProperties {
  return {
    '--pr-fg': color.Surface.OnContainer,
    '--pr-muted': color.SurfaceVariant.OnContainer,
    '--pr-border': color.Surface.ContainerLine,
    '--pr-surface': color.Surface.Container,
    '--pr-surface-subtle': color.SurfaceVariant.Container,
    '--pr-surface-subtle-line': color.SurfaceVariant.ContainerLine,
    '--pr-surface-subtle-hover': color.SurfaceVariant.ContainerHover,
    // The side panel's own floating card background, matching the center conversation card.
    '--pr-panel': color.Surface.Container,
    '--pr-hover': color.Surface.ContainerHover,
    '--pr-added': color.Success.Main,
    '--pr-removed': color.Critical.Main,
    '--pr-net-added': color.Success.ContainerActive,
    '--pr-net-added-line': color.Success.ContainerLine,
    '--pr-net-on-added': color.Success.OnContainer,
    '--pr-net-removed': color.Critical.ContainerActive,
    '--pr-net-removed-line': color.Critical.ContainerLine,
    '--pr-net-on-removed': color.Critical.OnContainer,
    '--pr-warning': color.Warning.Main,
    '--pr-open': '#2da44e',
    '--pr-closed': '#da3633',
    '--pr-merged': '#8957e5',
    '--pr-draft': '#848d97',
    '--pr-kind-code': '#2563eb',
    '--pr-kind-test': '#8957e5',
    '--pr-kind-docs': '#9a6700',
    '--pr-kind-generated': '#656d76',
    '--pr-kind-on-fill': '#ffffff',
    '--pr-primary': color.Primary.Main,
    '--pr-on-primary': color.Primary.OnMain,
    '--pr-primary-container-line': color.Primary.ContainerLine,
    '--pr-on-primary-container': color.Primary.OnContainer,
    '--pr-font-sans': config.font.Inter,
    '--pr-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  } as CSSProperties;
}
