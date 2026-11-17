// @vitest-environment jsdom
// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/useInlineActionConfirm.browser.test.tsx at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { useInlineConfirm } from './useInlineConfirm';

let confirm: ReturnType<typeof useInlineConfirm>;
function Buttons({
  scopeKey = 'a',
  shown = true,
  onMerge = () => undefined,
  onClose = () => undefined,
}: {
  scopeKey?: string;
  shown?: boolean;
  onMerge?: () => void;
  onClose?: () => void;
}) {
  confirm = useInlineConfirm(scopeKey);
  // The hook's owner stays mounted while the armed button goes away, as when the primary
  // control changes under an armed merge button.
  if (!shown) return <span>gone</span>;
  return (
    <>
      <button type="button" {...confirm.props('merge', onMerge)}>
        {confirm.isArmed('merge') ? 'Confirm merge?' : 'Merge'}
      </button>
      <button type="button" {...confirm.props('close', onClose)}>
        {confirm.isArmed('close') ? 'Confirm close?' : 'Close'}
      </button>
    </>
  );
}

const show = (props: Parameters<typeof Buttons>[0] = {}) =>
  renderPluginComponent(<Buttons {...props} />, { id: 'pull-requests', plugin });
const click = (button: HTMLElement) => act(() => button.click());
const dispatch = <E extends Event>(target: EventTarget, event: E) => {
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const escape = () =>
  dispatch(
    window,
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
const pointerdown = (target: EventTarget) =>
  dispatch(target, new MouseEvent('pointerdown', { bubbles: true }));

// The signals the armed button's listeners were added with, so a test sees them removed.
let signals: AbortSignal[];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  signals = [];
  // React 18 warns when a ref returns a function, as T3's does for React 19.
  vi.spyOn(console, 'error');
  for (const target of [document, window] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options?) => {
      if (typeof options === 'object' && options.signal) signals.push(options.signal);
      add(type, listener, options);
    });
  }
});
afterEach(() => {
  expect(console.error).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useInlineConfirm', () => {
  it('arms on the first click and confirms once on the second, then disarms', async () => {
    const onMerge = vi.fn();
    const view = await show({ onMerge });
    click(view.getByRole('button', { name: 'Merge' }));
    expect(onMerge).not.toHaveBeenCalled();
    click(view.getByRole('button', { name: 'Confirm merge?' }));
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(view.getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(confirm.isArmed('merge')).toBe(false);
  });

  it('disarms on Escape, which it keeps from going further, and when the window loses focus', async () => {
    const onMerge = vi.fn();
    const view = await show({ onMerge });
    click(view.getByRole('button', { name: 'Merge' }));
    expect(escape().defaultPrevented).toBe(true);
    expect(confirm.isArmed('merge')).toBe(false);
    click(view.getByRole('button', { name: 'Merge' }));
    dispatch(window, new FocusEvent('blur'));
    expect(confirm.isArmed('merge')).toBe(false);
    click(view.getByRole('button', { name: 'Merge' }));
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('disarms on a pointerdown outside the armed button, not on one inside it', async () => {
    const view = await show();
    click(view.getByRole('button', { name: 'Merge' }));
    pointerdown(view.getByRole('button', { name: 'Confirm merge?' }));
    expect(confirm.isArmed('merge')).toBe(true);
    pointerdown(document.body);
    expect(confirm.isArmed('merge')).toBe(false);
  });

  it('disarms 3000 ms after arming, not before', async () => {
    const view = await show();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    click(view.getByRole('button', { name: 'Merge' }));
    act(() => vi.advanceTimersByTime(2999));
    expect(confirm.isArmed('merge')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(confirm.isArmed('merge')).toBe(false);
  });

  it('arms the other button instead when it is clicked while one is armed', async () => {
    const onMerge = vi.fn();
    const onClose = vi.fn();
    const view = await show({ onMerge, onClose });
    click(view.getByRole('button', { name: 'Merge' }));
    click(view.getByRole('button', { name: 'Close' }));
    expect(confirm.isArmed('merge')).toBe(false);
    expect(confirm.isArmed('close')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    click(view.getByRole('button', { name: 'Confirm close?' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('disarms when the scope changes, and stays disarmed on going back', async () => {
    const view = await show({ scopeKey: 'a' });
    click(view.getByRole('button', { name: 'Merge' }));
    view.rerender(<Buttons scopeKey="b" />);
    expect(confirm.isArmed('merge')).toBe(false);
    expect(escape().defaultPrevented).toBe(false);
    view.rerender(<Buttons scopeKey="a" />);
    expect(confirm.isArmed('merge')).toBe(false);
  });

  // React 18 calls the ref with null when the armed button detaches, and the hook cleans up then.
  it.each([
    [
      'a confirm',
      (view: Awaited<ReturnType<typeof show>>) =>
        click(view.getByRole('button', { name: 'Confirm merge?' })),
    ],
    ['Escape', () => escape()],
    [
      'the armed button unmounting',
      (view: Awaited<ReturnType<typeof show>>) => view.rerender(<Buttons shown={false} />),
    ],
  ])('removes its listeners and its timer after %s', async (_, disarm) => {
    const view = await show();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    click(view.getByRole('button', { name: 'Merge' }));
    expect(signals).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(1);
    disarm(view);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(escape().defaultPrevented).toBe(false);
    view.rerender(<Buttons />);
    expect(confirm.isArmed('merge')).toBe(false);
  });
});
