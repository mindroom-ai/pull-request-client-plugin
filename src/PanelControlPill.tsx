import { Children, type ReactNode } from 'react';
import { IconButton as PlainIconButton } from 'folds';
import { ChevronRight, Maximize2, Minimize2, X } from 'lucide-react';
import { usePanelFrame, usePluginTranslation, useRoomSidePanel } from '@mindroom/client-sdk/core';
import { IconTooltip } from '@mindroom/client-sdk/ui';

function PillButton({
  label,
  pressed,
  onClick,
  icon,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <IconTooltip label={label} align="End">
      {(triggerRef) => (
        <PlainIconButton
          ref={triggerRef}
          size="300"
          radii="300"
          variant="SurfaceVariant"
          fill="None"
          className="mrpr-header-more"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {icon}
        </PlainIconButton>
      )}
    </IconTooltip>
  );
}

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
  const fillLabel = activeFrame
    ? (activeFrame.fillLabel ?? t('fillPanel', { label: activeFrame.label }))
    : '';
  const foldLabel = activeFrame
    ? (activeFrame.foldLabel ?? t('foldPanel', { label: activeFrame.label }))
    : '';

  return (
    <span className="mrpr-bar-end">
      {children}
      {hasLeading && hasTrailing ? <span aria-hidden className="mrpr-bar-pill-sep" /> : null}
      {hasTrailing ? (
        <span className="mrpr-bar-pill-core">
          {activeFrame ? (
            <>
              <PillButton
                label={fillLabel}
                pressed={filled}
                onClick={() => activeFrame.setLayout(filled ? 'beside' : 'filled')}
                icon={
                  filled ? (
                    <Minimize2 aria-hidden className="mrpr-button-icon" />
                  ) : (
                    <Maximize2 aria-hidden className="mrpr-button-icon" />
                  )
                }
              />
              <PillButton
                label={foldLabel}
                onClick={() => activeFrame.setLayout('folded')}
                icon={<ChevronRight aria-hidden className="mrpr-button-icon mrpr-fold-icon" />}
              />
            </>
          ) : null}
          {panel ? (
            <PillButton
              label={t('closePanel')}
              onClick={panel.close}
              icon={<X aria-hidden className="mrpr-button-icon" />}
            />
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
