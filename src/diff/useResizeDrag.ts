// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/hooks/useResizeDrag.ts at 943de8fe), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A pointer drag that resizes along one edge, as T3 Code's: it captures the pointer, applies the
// pointer's position once a frame, and commits where the pointer was released. A mouse, a pen and
// a finger drag the same way.
import { type PointerEvent, useState } from 'react';

interface ResizeBounds {
  readonly min: number;
  readonly max: number;
}

interface ResizeSession {
  width: number;
  /** The edge the handle is on: dragging it away from the element widens it. */
  edge: 'left' | 'right';
  /** Pointer widths are clamped to these before `resize` sees them. */
  bounds: ResizeBounds;
  /** Shows a width the pointer reached, already clamped to the bounds. */
  resize: (width: number) => void;
  finish: (width: number, moved: boolean) => void;
  cleanup: (committed: boolean) => void;
}

function clampToBounds(width: number, bounds: ResizeBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, width));
}

interface ActiveDrag<T extends HTMLElement> {
  session: ResizeSession;
  target: T;
  pointerId: number;
  startX: number;
  pendingX: number;
  width: number;
  moved: boolean;
  frame: number | null;
  onBlur: () => void;
}

function createResizeDrag<T extends HTMLElement>() {
  let drag: ActiveDrag<T> | null = null;

  const flush = () => {
    const active = drag;
    if (!active) return;
    const delta = (active.pendingX - active.startX) * (active.session.edge === 'left' ? -1 : 1);
    if (Math.abs(delta) > 2) active.moved = true;
    active.width = clampToBounds(active.session.width + delta, active.session.bounds);
    active.session.resize(active.width);
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    window.removeEventListener('blur', active.onBlur);
    if (commit) flush();
    // Release can synchronously dispatch lostpointercapture.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {
      // The pointer is gone already.
    }
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
    active.session.cleanup(commit);
    if (commit) active.session.finish(active.width, active.moved);
  };

  const end = (event: PointerEvent<T>, usePosition: boolean) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingX = event.clientX;
    finish(true);
  };

  return {
    /** Abandons a drag, putting the width back to where it started. */
    cancel: () => finish(false),
    refresh(bounds: ResizeBounds) {
      if (!drag) return;
      drag.session.bounds = bounds;
      flush();
    },
    begin(event: PointerEvent<T>, start: (event: PointerEvent<T>) => ResizeSession | null) {
      if (event.button !== 0 || drag) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Leaving the window mid-drag commits where the pointer was.
      const onBlur = () => finish(true);
      window.addEventListener('blur', onBlur);
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        width: session.width,
        moved: false,
        frame: null,
        onBlur,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    onPointerMove(event: PointerEvent<T>) {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > 2) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<T>) => end(event, true),
    onPointerCancel: (event: PointerEvent<T>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<T>) => end(event, false),
  };
}

/**
 * The session `start` returns owns everything the drag needs, so options read at pointer-down
 * hold for the whole drag. Call `cancel` when the handle unmounts, to abandon a drag.
 */
export function useResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => ResizeSession | null
) {
  // Created once, so a re-render mid-drag keeps the drag.
  const [drag] = useState(createResizeDrag<T>);
  const { begin, ...rest } = drag;
  return { ...rest, onPointerDown: (event: PointerEvent<T>) => begin(event, start) };
}
