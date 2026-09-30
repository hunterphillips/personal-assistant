// Shared Playwright fixtures for the shell's browser tests. `hub` starts the
// servers in browser-server.mjs with `withFocus` and `hubOptions` (both
// test options; `hubOptions.build`, when present, is called when the test
// starts instead, so relative times are computed then); every request to a host other than 127.0.0.1 or localhost
// is aborted; and any CSP report or uncaught error in the shell or its
// frames fails the test.

import { expect, test as base } from '@playwright/test';

import { focusSourceAvailable, startHub } from './browser-server.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const test = base.extend({
  withFocus: [true, { option: true }],
  hubOptions: [{}, { option: true }],
  hub: async ({ withFocus, hubOptions }, use) => {
    const options = typeof hubOptions.build === 'function' ? hubOptions.build() : hubOptions;
    const hub = await startHub({ withFocus, ...options });
    try {
      await use(hub);
    } finally {
      await hub.stop();
    }
  },
  context: async ({ context }, use) => {
    await context.route((url) => !LOCAL_HOSTS.has(url.hostname), (route) => route.abort());
    await use(context);
  },
  policyViolations: [async ({ page }, use) => {
    const violations = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to (load|execute|apply|connect|frame)/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    page.on('pageerror', (error) => violations.push(`pageerror: ${error.message}`));
    await use(violations);
    expect(violations).toEqual([]);
  }, { auto: true }],
});

export { expect };

export const needsFocus = () => test.skip(!focusSourceAvailable(), 'Focus checkout not found');

export function nav(page, name) {
  return page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name, exact: true });
}

// The Agents view is titled "Agents" but its nav link is "Home".
const NAV_NAMES = { agents: 'Home', reading: 'Reading', focus: 'Focus', goals: 'Goals', health: 'Health' };

export async function expectView(page, view, title) {
  await expect(page.locator(`#view-${view}`)).toBeVisible();
  await expect(page.locator('section.view:visible')).toHaveCount(1);
  await expect(nav(page, NAV_NAMES[view])).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(`${title} · Dashboard`);
}
