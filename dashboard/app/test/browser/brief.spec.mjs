// The brief's overlay (B30, B31): the invented fixture brief
// (test/fixtures/brief) rendered over any view, feedback saved and read
// back, the states for a missing or malformed brief, the old /brief address,
// the morning line, and the instructions panel inside the overlay. Briefs
// live in the test hub's temporary directory only.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const DATE = '2026-09-15';
const NEXT_DATE = '2026-09-16';
const TITLE = 'Invented brief for tests, not a real day';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const BRIEF_INSTRUCTIONS = path.join(FIXTURES, 'brief-instructions', 'curator.md');
const ASSISTANT = Object.freeze({
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
  cwd: '/invented', provider: 'claude', pinned: true,
});

const overlay = (page) => page.getByRole('dialog', { name: 'Brief' });
const item = (page, id) => page.locator(`[data-brief-item="${id}"]`);
const phone = (page) => page.viewportSize().width < 720;

// The header's Brief entry: in the header on a desk, in the menu on a phone.
async function openFromHeader(page) {
  if (phone(page)) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('#app-menu').getByRole('button', { name: 'Brief', exact: true }).click();
  } else {
    await page.locator('.header-right > .header-brief').click();
  }
  await expect(overlay(page)).toBeVisible();
}

test.describe('the overlay', () => {
  test.use({ hubOptions: { agents: [ASSISTANT], briefInstructions: BRIEF_INSTRUCTIONS } });

  test('opens from the header over every view and closes with Escape and Close, leaving the view as it was', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    for (const [route, view, title] of [['/', 'agents', 'Agents'], ['/feed', 'feed', 'Feed'], ['/goals', 'goals', 'Goals'], ['/health', 'health', 'Health']]) {
      await page.goto(hub.origin + route);
      await expectView(page, view, title);
      await openFromHeader(page);
      await expect(page.locator('.brief-title')).toHaveText(TITLE);
      await expect(page).toHaveURL(hub.origin + route);
      await page.keyboard.press('Escape');
      await expect(overlay(page)).toBeHidden();
      await expectView(page, view, title);
    }

    await openFromHeader(page);
    await overlay(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(overlay(page)).toBeHidden();
    if (!phone(page)) await expect(page.locator('.header-right > .header-brief')).toBeFocused();
  });

  test('a heading with an obvious icon shows the icon, keeps its word for screen readers, and others stay text', async ({ page, hub }) => {
    await hub.writeBrief(DATE, { sections: [
      { id: 'reading', label: 'Reading', items: [{ id: 'reading-1', text: 'An invented story.' }] },
      { id: 'what-changed', label: 'What changed', items: [{ id: 'what-changed-1', text: 'An invented change.' }] },
      { id: 'money', label: 'Money', items: [{ id: 'money-1', text: 'An invented figure.' }] },
    ] });
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    await expect(page.getByRole('heading', { name: 'Reading' }).locator('svg')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Reading' })).toHaveAttribute('title', 'Reading');
    await expect(page.getByRole('heading', { name: 'What changed' }).locator('svg')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Money' }).locator('svg')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Money' })).toBeVisible();
  });

  test('an item\'s marks are hidden until hover on a desk and always shown on a phone', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    const marks = item(page, 'money-1').locator('.brief-marks');
    const opacity = () => marks.evaluate((node) => Number(getComputedStyle(node).opacity));
    if (phone(page)) {
      await expect.poll(opacity).toBeGreaterThan(0.5);
      return;
    }
    await page.mouse.move(1, 1);
    await expect.poll(opacity).toBe(0);
    await item(page, 'money-1').locator('.brief-text').hover();
    await expect.poll(opacity).toBeGreaterThan(0.5);
  });

  test('renders the date, title, opening, and each section with its items in the dashboard\'s markup', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    await expect(page.locator('.brief-date')).toHaveText(/^Tuesday, September 15(, 2026)?$/);
    await expect(page.locator('.brief-opening')).toContainText('Invented opening: cash is fine');
    await expect(page.locator('.brief-section-label')).toHaveText(['Needs you', 'Money']);
    await expect(page.locator('[data-brief-item]')).toHaveCount(4);
    await expect(item(page, 'needs-you-1').locator('strong')).toHaveText('Sam');
    await expect(item(page, 'needs-you-2').locator('li')).toHaveText([
      'One invented form waits for a signature.', 'Another invented form is half done.',
    ]);
    await expect(item(page, 'money-1').getByRole('link', { name: 'policy' })).toHaveAttribute('href', 'https://example.com/policy');
    await expect(page.locator('.brief-doc')).not.toContainText('**');
    // No iframe and no theme or font toggle of its own.
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(overlay(page).getByRole('button', { name: /theme|font/i })).toHaveCount(0);
    const face = await page.locator('.brief-text').first().evaluate((node) => getComputedStyle(node).fontFamily);
    expect(face).toMatch(/serif/);
  });

  test('Approve, Dismiss, a note, and the overall note save every item and read back on the next open', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);

    const approve = item(page, 'needs-you-1').getByRole('button', { name: 'Approve' });
    await approve.click();
    await expect(approve).toHaveAttribute('aria-pressed', 'true');
    await item(page, 'needs-you-1').getByRole('button', { name: 'Note' }).click();
    await item(page, 'needs-you-1').getByRole('textbox', { name: 'Note' }).fill('Invented note on the lease.');
    const dismiss = item(page, 'money-1').getByRole('button', { name: 'Dismiss' });
    await dismiss.click();
    await dismiss.click();
    await expect(dismiss).toHaveAttribute('aria-pressed', 'false');
    await item(page, 'needs-you-2').getByRole('button', { name: 'Dismiss' }).click();
    await page.getByLabel('Overall note').fill('Invented overall note.');
    await expect(page.locator('#brief-saved')).toHaveText('You have changes that are not saved.');

    const saved = page.waitForResponse((response) => response.url().endsWith('/api/brief/feedback'));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator('#brief-saved')).toHaveText(/^Saved at \d{1,2}:\d{2} [AP]M\.$/);

    const markdown = await hub.readFeedback(DATE);
    expect(markdown).toContain('## Needs you\n\n- needs-you-1: APPROVED\n  > An invented reply to **Sam** is owed about the lease.\n  - note: Invented note on the lease.');
    expect(markdown).toContain('- needs-you-2: DISMISSED');
    expect(markdown).toContain('- money-1: no mark');
    expect(markdown).toContain('## Overall\n\nInvented overall note.');
    const record = await hub.readSavedFeedback(DATE);
    expect(record.items.map((entry) => entry.id)).toEqual(['opening', 'needs-you-1', 'needs-you-2', 'money-1']);

    await page.reload();
    await openFromHeader(page);
    await expect(item(page, 'needs-you-1').getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
    await expect(item(page, 'needs-you-1').getByRole('textbox', { name: 'Note' })).toHaveValue('Invented note on the lease.');
    await expect(item(page, 'needs-you-2').getByRole('button', { name: 'Dismiss' })).toHaveAttribute('aria-pressed', 'true');
    await expect(item(page, 'money-1').getByRole('textbox', { name: 'Note' })).toBeHidden();
    await expect(page.getByLabel('Overall note')).toHaveValue('Invented overall note.');
    await expect(page.locator('#brief-saved')).toHaveText(/^Saved at /);
  });

  test('marks not yet saved survive closing and reopening the same brief', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    await item(page, 'opening').getByRole('button', { name: 'Approve' }).click();
    await page.keyboard.press('Escape');
    await openFromHeader(page);
    await expect(item(page, 'opening').getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#brief-saved')).toHaveText('You have changes that are not saved.');
  });

  test('a brief rebuilt while open is offered, and a save against the old one says so', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    await item(page, 'opening').getByRole('button', { name: 'Approve' }).click();
    await hub.writeBrief(DATE, { title: 'Invented brief, rebuilt' });
    await hub.state.refreshStatus();
    await expect(page.locator('#brief-newer')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#brief-saved')).toHaveText('The brief changed after it opened. Load the newer brief to save.');
    await expect(hub.readFeedback(DATE)).rejects.toThrow();

    await page.getByRole('button', { name: 'Load newer brief' }).click();
    await expect(page.locator('.brief-title')).toHaveText('Invented brief, rebuilt');
    await expect(page.locator('#brief-newer')).toBeHidden();
  });

  test('Instructions opens the brief\'s rules inside the overlay', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/feed');
    await openFromHeader(page);
    const toggle = overlay(page).getByRole('button', { name: 'Instructions' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    const panel = page.locator('#brief-instructions');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Brief instructions' })).toBeVisible();
    await expect(panel.locator('.instructions-intro')).toHaveText('The brief follows these rules. A change goes to Assistant, which edits the file.');
    // Escape closes the panel first, then the overlay.
    await panel.getByLabel('What should change?').press('Escape');
    await expect(panel).toBeHidden();
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();
  });

  test('covers the whole screen on a phone and one centered column on a desk, scrolling on its own', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    const viewport = page.viewportSize();
    const box = await page.locator('#brief-sheet').boundingBox();
    if (phone(page)) {
      expect(Math.round(box.x)).toBe(0);
      expect(Math.round(box.width)).toBe(viewport.width);
      expect(Math.round(box.height)).toBe(viewport.height);
    } else {
      expect(box.width).toBeLessThanOrEqual(760);
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
    }
    const shell = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    }));
    expect(shell.scrollWidth).toBeLessThanOrEqual(shell.innerWidth);
    await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  });

  test('follows the dark theme', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(hub.origin + '/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openFromHeader(page);
    const colors = await page.locator('#brief-sheet').evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.color];
    });
    expect(colors).toEqual(['rgb(33, 31, 27)', 'rgb(242, 237, 228)']);
  });
});

test.describe('the unread dot', () => {
  test.use({ hubOptions: { agents: [ASSISTANT], briefInstructions: BRIEF_INSTRUCTIONS } });

  // The corner dot on a desk's Brief button, or on a phone the menu
  // toggle's own dot (visible without opening the menu).
  function closedDot(page) {
    return phone(page) ? page.locator('#app-menu-dot') : page.locator('#brief-dot');
  }

  test('shows for a new brief, clears everywhere once its overlay opens, and a newer brief brings it back', async ({ page, context, hub }) => {
    await hub.writeBrief(DATE);
    await hub.state.refreshStatus();
    await page.goto(hub.origin + '/');

    await expect(closedDot(page)).toBeVisible();
    if (phone(page)) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(page.locator('#brief-menu-dot')).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      await expect(page.locator('#brief-open')).toHaveAttribute('aria-label', 'Brief, unread');
    }

    // A second page, sharing the same daemon, shows the same dot.
    const page2 = await context.newPage();
    await page2.goto(hub.origin + '/');
    await expect(closedDot(page2)).toBeVisible();

    await openFromHeader(page);
    await expect(overlay(page)).toBeVisible();
    await expect(closedDot(page)).toBeHidden();
    if (!phone(page)) await expect(page.locator('#brief-open')).toHaveAttribute('aria-label', 'Brief');

    // Server-side: the second page clears too, without it doing anything.
    await expect(closedDot(page2)).toBeHidden();
    await page2.close();
    await page.keyboard.press('Escape');

    await hub.writeBrief(NEXT_DATE);
    await hub.state.refreshStatus();
    await expect(closedDot(page)).toBeVisible();
  });

});

test.describe('brief states', () => {
  test('no brief, a viewer without data, and malformed data each read as one sentence with the date', async ({ page, hub }) => {
    await page.goto(hub.origin + '/');
    await openFromHeader(page);
    await expect(page.locator('#brief-state')).toHaveText('No brief has been generated yet.');
    await expect(page.locator('#brief-doc')).toBeHidden();
    await page.keyboard.press('Escape');

    await hub.writeBrief(DATE);
    await hub.writeViewer(NEXT_DATE);
    await openFromHeader(page);
    await expect(page.locator('#brief-state')).toHaveText(/^The brief for Wednesday, September 16(, 2026)? could not be opened\.$/);
    await expect(page.locator('#brief-doc')).toBeHidden();
    await page.keyboard.press('Escape');

    await hub.writeRawBrief(NEXT_DATE, '{"date": "2026-09-16", "title": "Invented, malformed"');
    await openFromHeader(page);
    await expect(page.locator('#brief-state')).toHaveText(/^The brief for Wednesday, September 16(, 2026)? could not be opened\.$/);
    await expect(page.locator('.brief-title')).toHaveCount(0);
  });
});

test('the old /brief address opens the Feed with the overlay, under the Feed\'s address', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(hub.origin + '/brief');
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.brief-title')).toHaveText(TITLE);
  await expect(page).toHaveURL(hub.origin + '/feed');
  await page.keyboard.press('Escape');
  await expectView(page, 'feed', 'Feed');
});

test.describe('from the morning line', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT],
        personas: {
          assistant: {
            messages: [{
              role: 'system', kind: 'brief', date: DATE, state: 'ready', summary: 'Invented opening.',
              text: 'Invented opening.\n\n## Money\n\n- Invented drift.', at: new Date(Date.now() - 60_000).toISOString(),
            }],
          },
        },
      }),
    },
  });

  test('Open brief shows that date\'s brief over the thread', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await hub.writeBrief(NEXT_DATE, { title: 'Invented later brief' });
    await page.goto(hub.origin + '/?agent=assistant');
    const line = page.locator('#agent-messages .thread-message-brief');
    await line.getByRole('button', { name: 'Open brief' }).click();
    await expect(overlay(page)).toBeVisible();
    await expect(page.locator('.brief-title')).toHaveText(TITLE);
    await expect(page.locator('.brief-date')).toHaveText(/^Tuesday, September 15(, 2026)?$/);
    await page.keyboard.press('Escape');
    await expect(line.getByRole('button', { name: 'Open brief' })).toBeFocused();
    await expect(page).toHaveURL(hub.origin + '/?agent=assistant');
  });
});
