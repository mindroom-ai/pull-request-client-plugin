import { act } from './act';

// Intersection observers that report only when a test tells them to.
export const observers: FakeIntersectionObserver[] = [];

export class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Reports the intersection states of matching elements, in delivery order. */
export const report = (visible: boolean | boolean[], matches = (_target: Element) => true) => {
  const states = typeof visible === 'boolean' ? [visible] : visible;
  for (const observer of observers) {
    const entries = [...observer.targets]
      .filter(matches)
      .flatMap((target) =>
        states.map((isIntersecting) => ({ target, isIntersecting }) as IntersectionObserverEntry)
      );
    if (entries.length > 0) {
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
};

/** Leaves matching elements on screen for the visibility dwell and flushes the latch. */
export const settleOnScreen = (matches?: (target: Element) => boolean) =>
  act(async () => {
    report(true, matches);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  });
