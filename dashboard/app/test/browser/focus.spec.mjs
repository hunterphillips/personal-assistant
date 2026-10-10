// The native Focus board against the invented fixture (test/fixtures/focus)
// copied into the data root: sections, tabs, every card action, the drawers,
// the side panel, the rules, the stream reaching a second page, and quick
// chat's context. Every card and agent here is invented for the browser suite.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const FOCUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'focus');
const persona = (fields) => ({
  description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', ...fields,
});
const AGENTS = [
  persona({ id: 'assistant', name: 'Assistant', role: 'Assistant', pinned: true }),
  persona({ id: 'myos', name: 'Myos', role: 'Guide', builtin: true }),
];

const list = (page, place) => page.locator(`#focus-sections ul[data-place="${place}"]`);
const card = (page, id) => page.locator(`#focus-sections .focus-card[data-id="${id}"]`);
const titles = (page, place) => list(page, place).locator('.focus-card .focus-title');
const phone = (page) => page.viewportSize().width < 720;

async function readBoard(hub) {
  return JSON.parse(await readFile(hub.focusBoardFile, 'utf8'));
}

async function readChanges(hub) {
  try {
    return (await readFile(hub.focusChangesFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const itemOf = (board, id) => board.items.find((item) => item.id === id);

async function openFocus(page, hub) {
  await page.goto(`${hub.origin}/focus`);
  await expectView(page, 'focus', 'Focus');
  await expect(page.locator('#focus-board')).toBeVisible();
  await expect(titles(page, 'now')).toHaveText(['Send the draft agenda']);
}

async function openMenu(page, id) {
  await card(page, id).getByRole('button', { name: 'More' }).click();
  const menu = card(page, id).locator('.focus-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function openPanel(page) {
  if (phone(page)) await page.locator('#panel-toggle').click();
  const section = page.locator('[data-panel-for="focus"]');
  await expect(section).toBeVisible();
  return section;
}

test.describe('Focus board', () => {
  test.use({ withFocus: false, hubOptions: { focus: FOCUS, agents: AGENTS } });

  // The fixture's done card reads as done for 24 hours; stamp it an hour ago.
  test.beforeEach(async ({ hub }) => {
    const board = await readBoard(hub);
    itemOf(board, 'done-one').updated = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await writeFile(hub.focusBoardFile, `${JSON.stringify(board, null, 2)}\n`);
  });

  test('renders the sections in order, with the done card collapsed last, and no frame', async ({ page, hub }) => {
    await openFocus(page, hub);
    await expect(page.locator('#focus-sections .focus-heading:visible')).toHaveText(['Now', 'Rest of today', 'Tomorrow', 'Later']);
    await expect(titles(page, 'today')).toHaveText(['Choose a workshop topic', 'Confirm the sample order']);
    await expect(titles(page, 'tomorrow')).toHaveText(['Review the release checklist']);
    await expect(titles(page, 'later')).toHaveText(['Book the practice room']);
    await expect(card(page, 'now-one')).toHaveClass(/focus-card-big/);
    await expect(card(page, 'done-one')).toHaveClass(/focus-card-collapsed/);
    await expect(card(page, 'done-one').locator('.focus-meta')).toHaveCount(0);
    await expect(card(page, 'today-one').locator('.focus-note')).toHaveText('Keep the first session practical');
    await expect(card(page, 'now-one').locator('.focus-meta')).toContainText('Gmail · reply requested');
    await expect(card(page, 'tomorrow-one').getByRole('link', { name: 'Review the release checklist' }))
      .toHaveAttribute('href', 'https://example.test/checklist');
    await expect(page.locator('#focus-add')).toHaveAttribute('placeholder', 'Add something');
    await expect(page.locator('#focus-frame')).toHaveCount(0);
    await expect(page.locator('#focus-slot')).toBeHidden();
    await expect(page.locator('#focus-notice')).toBeHidden();
    await expect(page.locator('#focus-message')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBe(0);

    // A done card opens past its title on click and folds again.
    await card(page, 'done-one').locator('.focus-card-body').click();
    await expect(card(page, 'done-one')).not.toHaveClass(/focus-card-collapsed/);
    await expect(card(page, 'done-one').locator('.focus-meta')).toBeVisible();
    await card(page, 'done-one').locator('.focus-card-body').click();
    await expect(card(page, 'done-one')).toHaveClass(/focus-card-collapsed/);
  });

  test('each tab hides the horizons above it and its own heading', async ({ page, hub }) => {
    await openFocus(page, hub);
    const tab = (name) => page.locator('#focus-tabs').getByRole('tab', { name });
    await tab('Tomorrow').click();
    await expect(tab('Tomorrow')).toHaveAttribute('aria-selected', 'true');
    await expect(list(page, 'now')).toBeHidden();
    await expect(list(page, 'today')).toBeHidden();
    await expect(page.locator('#focus-add')).toBeHidden();
    await expect(page.locator('#focus-sections .focus-heading:visible')).toHaveText(['Later']);
    await expect(titles(page, 'tomorrow')).toHaveText(['Review the release checklist']);

    await tab('Later').click();
    await expect(list(page, 'tomorrow')).toBeHidden();
    await expect(page.locator('#focus-sections .focus-heading:visible')).toHaveCount(0);
    await expect(titles(page, 'later')).toHaveText(['Book the practice room']);
    await expect(page.locator('#focus-cleared')).toBeVisible();

    await tab('Today').click();
    await expect(page.locator('#focus-sections .focus-heading:visible')).toHaveText(['Now', 'Rest of today', 'Tomorrow', 'Later']);
  });

  test('the check marks a card done, collapsed, and reopens it', async ({ page, hub }) => {
    await openFocus(page, hub);
    await card(page, 'today-one').getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'today-one')).toHaveClass(/focus-card-collapsed/);
    await expect(card(page, 'today-one').getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
    expect(itemOf(await readBoard(hub), 'today-one').status).toBe('done');

    await card(page, 'today-one').getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'today-one')).not.toHaveClass(/focus-card-done/);
    expect(itemOf(await readBoard(hub), 'today-one').status).toBe('open');
    expect((await readChanges(hub)).map((line) => line.summary)).toEqual([
      'done "Choose a workshop topic"', 'reopen "Choose a workshop topic"',
    ]);
  });

  test('the menu lists the places, Note, and Dismiss, and moves a card', async ({ page, hub }) => {
    await openFocus(page, hub);
    let menu = await openMenu(page, 'today-one');
    await expect(menu.getByRole('menuitem')).toHaveText(['Now', 'Today', 'Tomorrow', 'Later', 'Note', 'Dismiss']);
    await expect(menu.getByRole('menuitem', { name: 'Today' })).toHaveAttribute('aria-current', 'true');
    await menu.getByRole('menuitem', { name: 'Tomorrow' }).click();
    // The menu moves without a rank change: equal ranks keep the board's order.
    await expect(titles(page, 'tomorrow')).toHaveText(['Choose a workshop topic', 'Review the release checklist']);
    await expect(titles(page, 'today')).toHaveText(['Confirm the sample order']);
    const moved = itemOf(await readBoard(hub), 'today-one');
    expect([moved.tier, moved.now]).toEqual(['tomorrow', false]);

    menu = await openMenu(page, 'done-one');
    await expect(menu.getByRole('menuitem')).toHaveText(['Note']);
    await page.keyboard.press('Escape');
    await expect(card(page, 'done-one').locator('.focus-menu')).toHaveCount(0);
  });

  test('a drag reorders a list and writes the whole order', async ({ page, hub }) => {
    test.skip(phone(page), 'A phone moves cards with the menu.');
    await openFocus(page, hub);
    await page.locator('#focus-add').fill('Water the plants');
    await page.locator('#focus-add').press('Enter');
    await expect(titles(page, 'today')).toHaveText(['Choose a workshop topic', 'Water the plants', 'Confirm the sample order']);
    const added = (await readBoard(hub)).items.find((item) => item.title === 'Water the plants');

    await card(page, added.id).dragTo(card(page, 'today-one'), { targetPosition: { x: 40, y: 4 } });
    await expect(titles(page, 'today')).toHaveText(['Water the plants', 'Choose a workshop topic', 'Confirm the sample order']);
    await expect.poll(async () => {
      const board = await readBoard(hub);
      return [itemOf(board, added.id).rank, itemOf(board, 'today-one').rank];
    }).toEqual([0, 1]);
    expect((await readChanges(hub)).at(-1).summary).toBe('reorder "Water the plants" to #1 in today');

    // A drop on a tab sends the card first in that place.
    await card(page, 'today-one').dragTo(page.locator('#focus-tab-later'));
    await expect(titles(page, 'later')).toHaveText(['Choose a workshop topic', 'Book the practice room']);
    await expect(page.locator('#focus-tab-today')).toHaveAttribute('aria-selected', 'true');
  });

  test('Dismiss sends a card to Recently cleared and Reopen brings it back', async ({ page, hub }) => {
    await openFocus(page, hub);
    const menu = await openMenu(page, 'later-one');
    await menu.getByRole('menuitem', { name: 'Dismiss' }).click();
    await expect(card(page, 'later-one')).toHaveCount(0);
    await expect(list(page, 'later')).toHaveText('Nothing for later.');
    const cleared = page.locator('#focus-cleared');
    await cleared.locator('summary').click();
    const rows = cleared.locator('.focus-row');
    await expect(rows.locator('.focus-row-title')).toHaveText(['Book the practice room', 'Prepare the old demo', 'Read the product announcement']);
    expect(itemOf(await readBoard(hub), 'later-one').status).toBe('dismissed');

    await rows.filter({ hasText: 'Book the practice room' }).getByRole('button', { name: 'Reopen' }).click();
    await expect(titles(page, 'later')).toHaveText(['Book the practice room']);
    await expect(rows).toHaveCount(2);
    expect(itemOf(await readBoard(hub), 'later-one').status).toBe('open');
  });

  test('a note saves and shows; a manual title edits and a curated one does not', async ({ page, hub }) => {
    await openFocus(page, hub);
    const menu = await openMenu(page, 'now-one');
    await menu.getByRole('menuitem', { name: 'Note' }).click();
    const note = card(page, 'now-one').getByRole('textbox', { name: 'Note' });
    await expect(note).toBeFocused();
    await note.fill('Ask about the venue too');
    await note.press('Enter');
    await expect(card(page, 'now-one').locator('.focus-note')).toHaveText('Ask about the venue too');
    expect(itemOf(await readBoard(hub), 'now-one').note).toBe('Ask about the venue too');

    await card(page, 'today-one').locator('.focus-title').dblclick();
    const title = card(page, 'today-one').getByRole('textbox', { name: 'Title' });
    await expect(title).toBeFocused();
    await title.fill('Choose the workshop topic');
    await title.press('Enter');
    await expect(card(page, 'today-one').locator('.focus-title')).toHaveText('Choose the workshop topic');
    expect(itemOf(await readBoard(hub), 'today-one').title).toBe('Choose the workshop topic');

    // Escape leaves the title as it was.
    await card(page, 'today-one').locator('.focus-title').dblclick();
    await card(page, 'today-one').getByRole('textbox', { name: 'Title' }).fill('Something else');
    await page.keyboard.press('Escape');
    await expect(card(page, 'today-one').locator('.focus-title')).toHaveText('Choose the workshop topic');

    await card(page, 'now-one').locator('.focus-title').dblclick();
    await expect(card(page, 'now-one').getByRole('textbox', { name: 'Title' })).toHaveCount(0);
    expect((await readChanges(hub)).map((line) => line.summary)).toEqual([
      'note "Send the draft agenda"', 'edit "Choose the workshop topic"',
    ]);
  });

  test('the add row adds a manual card under Today', async ({ page, hub }) => {
    await openFocus(page, hub);
    await page.locator('#focus-add').fill('Call the venue');
    await page.locator('#focus-add').press('Enter');
    await expect(titles(page, 'today')).toHaveText(['Choose a workshop topic', 'Call the venue', 'Confirm the sample order']);
    await expect(page.locator('#focus-add')).toHaveValue('');
    const added = (await readBoard(hub)).items.find((item) => item.title === 'Call the venue');
    expect(added).toMatchObject({ source: 'manual', meta: 'added by you', tier: 'today', now: false, status: 'open' });
  });

  test('Considered shows a verdict and Add promotes the other candidate with its external_id', async ({ page, hub }) => {
    await openFocus(page, hub);
    await page.locator('#focus-tab-later').click();
    const considered = page.locator('#focus-considered');
    await expect(considered).toBeVisible();
    await considered.locator('summary').click();
    await expect(considered.locator('.focus-candidate-group')).toHaveText([/^Gmail · Scanned /]);
    const agenda = considered.locator('[data-focus-candidate="gmail|thread-agenda"]');
    const venue = considered.locator('[data-focus-candidate="gmail|thread-venue"]');
    await expect(agenda.locator('.focus-verdict')).toHaveText('On the board · Today');
    await venue.getByRole('button', { name: 'Add' }).click();
    const title = venue.getByRole('textbox', { name: 'Title' });
    await expect(title).toHaveValue('Venue question');
    await title.fill('Answer the venue question');
    await title.press('Enter');
    await expect(venue.locator('.focus-verdict')).toHaveText('On the board · Later');
    await expect(titles(page, 'later')).toHaveText(['Book the practice room', 'Answer the venue question']);
    const promoted = (await readBoard(hub)).items.find((item) => item.external_id === 'thread-venue');
    expect(promoted).toMatchObject({ title: 'Answer the venue question', source: 'manual', meta: 'A new question', tier: 'later' });
  });

  test('the panel lists the sections with counts, and choosing one selects its tab', async ({ page, hub }) => {
    await openFocus(page, hub);
    const section = await openPanel(page);
    const rows = section.locator('.panel-row');
    await expect(rows.locator('.panel-row-name')).toHaveText(['Now', 'Today', 'Tomorrow', 'Later', 'Recently cleared', 'Considered']);
    await expect(rows.locator('.panel-row-count')).toHaveText(['1', '1', '1', '1', '2', '2']);
    await rows.filter({ hasText: 'Later' }).first().click();
    await expect(page.locator('#focus-tab-later')).toHaveAttribute('aria-selected', 'true');
    await expect(list(page, 'tomorrow')).toBeHidden();

    await openPanel(page);
    await rows.filter({ hasText: 'Tomorrow' }).click();
    await expect(page.locator('#focus-tab-tomorrow')).toHaveAttribute('aria-selected', 'true');
    await expect(rows.filter({ hasText: 'Tomorrow' })).toHaveAttribute('aria-current', 'true');
  });

  test('the gear opens the rules', async ({ page, hub }) => {
    await openFocus(page, hub);
    const gear = page.locator('[data-actions-for="focus"]').getByRole('button', { name: 'Rules' });
    await expect(gear).toBeVisible();
    await gear.click();
    const panel = page.locator('#focus-instructions');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.instructions-heading')).toHaveText('Focus rules');
    await expect(panel.locator('#focus-instructions-body')).toContainText('A reply someone is waiting on goes under Today.');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toBeHidden();
  });

  test('a second page sees a done, a move, and a dismiss without a reload', async ({ page, context, hub }) => {
    await openFocus(page, hub);
    const other = await context.newPage();
    await openFocus(other, hub);

    await card(page, 'today-one').getByRole('button', { name: 'Done' }).click();
    await expect(card(other, 'today-one')).toHaveClass(/focus-card-done/);

    const menu = await openMenu(page, 'tomorrow-one');
    await menu.getByRole('menuitem', { name: 'Now' }).click();
    await expect(titles(other, 'now')).toHaveText(['Send the draft agenda', 'Review the release checklist']);

    const again = await openMenu(page, 'later-one');
    await again.getByRole('menuitem', { name: 'Dismiss' }).click();
    await expect(card(other, 'later-one')).toHaveCount(0);
    await other.close();
  });

  test('a change arriving while the add row holds a draft leaves the draft', async ({ page, hub }) => {
    await openFocus(page, hub);
    await page.locator('#focus-add').fill('Half a thought');
    // Another browser's change, through the route.
    const status = await page.evaluate(() => fetch('/api/focus/changes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'done', id: 'now-one' }),
    }).then((response) => response.status));
    expect(status).toBe(200);
    await expect(page.locator('#focus-add')).toHaveValue('Half a thought');
    await page.locator('#focus-tabs').click({ position: { x: 4, y: 4 } });
    await expect(card(page, 'now-one')).toHaveClass(/focus-card-done/);
    await expect(page.locator('#focus-add')).toHaveValue('Half a thought');
  });

  test('a refused change says why and draws the board again', async ({ page, hub }) => {
    await openFocus(page, hub);
    // The card closes elsewhere while this page's menu is open, which holds
    // the newer board back until the menu closes.
    const menu = await openMenu(page, 'later-one');
    await page.evaluate(() => fetch('/api/focus/changes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'dismiss', id: 'later-one' }),
    }));
    await expect(card(page, 'later-one')).toHaveCount(1);
    await menu.getByRole('menuitem', { name: 'Tomorrow' }).click();
    await expect(page.locator('#focus-message')).toHaveText('The board changed before that went through.');
    await expect(card(page, 'later-one')).toHaveCount(0);
  });

  test('quick chat says it was sent from Focus, with the counts', async ({ page, hub }) => {
    await openFocus(page, hub);
    if (phone(page)) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator('#app-menu').getByRole('button', { name: 'Quick chat', exact: true }).click();
    } else {
      await page.locator('.header-right').getByRole('button', { name: 'Quick chat', exact: true }).click();
    }
    await expect(page.locator('#quick-chat')).toBeVisible();
    await page.locator('#quick-chat-input').fill('What first?');
    await page.locator('#quick-chat').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#quick-chat-messages .thread-message-context summary')).toHaveText('Sent from Focus.');
    await expect.poll(() => hub.personas.sent[0]?.context.context).toEqual({
      view: 'focus', detail: '1 now, 1 today, 1 tomorrow, 1 later.',
    });
  });
});

test.describe('Focus without a board', () => {
  test.use({ withFocus: false, hubOptions: { agents: AGENTS } });

  test('the board and its gear stay hidden and the frame path answers', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/focus`);
    await expectView(page, 'focus', 'Focus');
    await expect(page.locator('#focus-notice')).toBeVisible();
    await expect(page.locator('#focus-board')).toBeHidden();
    await expect(page.locator('#focus-instructions-toggle')).toBeHidden();
    await expect(page.locator('[data-panel-for="focus"]')).toBeHidden();
  });
});
