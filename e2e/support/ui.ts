import type { Locator } from '@playwright/test';

/** Set a range slider the way dragging it would (Playwright can't fill() ranges). */
export async function setRange(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** The range input inside the `label.setting` whose text starts with `label` */
export const rangeIn = (scope: Locator, label: string | RegExp) =>
  scope.locator('label.setting', { hasText: label }).locator('input[type=range]');
