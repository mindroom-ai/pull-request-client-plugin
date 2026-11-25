import { Children, type ReactNode } from 'react';
import { IconButton as PlainIconButton } from 'folds';
import { ChevronRight, Maximize2, Minimize2, X } from 'lucide-react';
import { usePanelFrame, usePluginTranslation, useRoomSidePanel } from '@mindroom/client-sdk/core';
import { IconTooltip } from '@mindroom/client-sdk/ui';

/**
 * The top-right floating control pill (`title: 'own'`, `frameControls: 'own'`): optional
 * panel-specific controls (Hide details, More actions), a subtle separator, Fill and Fold on
 * desktop side panels, and Close.
 */
export function PanelControlPill({ children }: { children?: ReactNode }) {
  const t = usePluginTranslation('pull-requests');
  const frame = usePanelFrame();
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const hasLeading = Children.toArray(children).length > 0;
  const activeFrame = frame && frame.layout !== 'folded' ? frame : undefined;
  const hasTrailing = activeFrame !== undefined || panel !== undefined;
  if (!hasLeading && !hasTrailing) return null;

  const filled = activeFrame?.layout === 'filled';
  const fillLabel = activeFrame ? t('fillPanel', { label: activeFrame.label }) : '';
  const foldLabel = activeFrame ? t('foldPanel', { label: activeFrame.label }) : '';
  const closeLabel = t('closePanel');

  return (
    <span className="mrpr-bar-end">
      {children}
      {hasLeading && hasTrailing ? <span aria-hidden className="mrpr-bar-pill-sep" /> : null}
      {activeFrame ? (
        <>
          <IconTooltip label={fillLabel} align="End">
            {(triggerRef) => (
              <PlainIconButton
                ref={triggerRef}
                size="300"
                radii="300"
                variant="SurfaceVariant"
                fill="None"
                className="mrpr-header-more"
                aria-label={fillLabel}
                aria-pressed={filled}
                onClick={() => activeFrame.setLayout(filled ? 'beside' : 'filled')}
              >
                {filled ? (
                  <Minimize2 aria-hidden className="mrpr-button-icon" />
                ) : (
                  <Maximize2 aria-hidden className="mrpr-button-icon" />
                )}
              </PlainIconButton>
            )}
          </IconTooltip>
          <IconTooltip label={foldLabel} align="End">
            {(triggerRef) => (
              <PlainIconButton
                ref={triggerRef}
                size="300"
                radii="300"
                variant="SurfaceVariant"
                fill="None"
                className="mrpr-header-more"
                aria-label={foldLabel}
                onClick={() => activeFrame.setLayout('folded')}
              >
                <ChevronRight aria-hidden className="mrpr-button-icon mrpr-fold-icon" />
              </PlainIconButton>
            )}
          </IconTooltip>
        </>
      ) : null}
      {panel ? (
        <IconTooltip label={closeLabel} align="End">
          {(triggerRef) => (
            <PlainIconButton
              ref={triggerRef}
              size="300"
              radii="300"
              variant="SurfaceVariant"
              fill="None"
              className="mrpr-header-more"
              aria-label={closeLabel}
              onClick={panel.close}
            >
              <X aria-hidden className="mrpr-button-icon" />
            </PlainIconButton>
          )}
        </IconTooltip>
      ) : null}
    </span>
  );
}
