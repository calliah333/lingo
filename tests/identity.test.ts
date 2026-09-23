import { expect, test } from 'bun:test';
import { displayIdentity, mentionRanges, mentionsAny } from '../src/shared/identity.ts';

test('configured relay prefixes supply a display sender without rewriting the IRC message', () => {
  const bracketed = { nick: 'BridgeBot', text: '[Jane Doe] hello' };
  const angled = { nick: 'bridgebot', text: '<Jane Doe> hello' };
  expect(displayIdentity(bracketed, ['bridgebot']))
    .toEqual({ nick: 'Jane Doe', text: 'hello', relayed: true, mentionTarget: 'Jane Doe' });
  expect(displayIdentity(angled, ['BridgeBot']))
    .toEqual({ nick: 'Jane Doe', text: 'hello', relayed: true, mentionTarget: 'Jane Doe' });
  expect(bracketed).toEqual({ nick: 'BridgeBot', text: '[Jane Doe] hello' });
  expect(angled).toEqual({ nick: 'bridgebot', text: '<Jane Doe> hello' });
});

test('unconfigured and malformed prefixes remain ordinary IRC messages', () => {
  const original = { nick: 'alice', text: '[Jane Doe] hello' };
  expect(displayIdentity(original, ['bridgebot']))
    .toEqual({ ...original, relayed: false, mentionTarget: 'alice' });
  for (const text of ['[ ] hello', '[Jane Doe] ', '[Jane Doe]hello', '[Jane Doe hello',
    '[Jane [Doe] hello', `[${'J'.repeat(49)}] hello`, '<Jane Doe>\nhello']) {
    expect(displayIdentity({ nick: 'bridgebot', text }, ['bridgebot']))
      .toEqual({ nick: 'bridgebot', text, relayed: false, mentionTarget: 'bridgebot' });
  }
  expect(displayIdentity({ nick: null, text: '[Jane Doe] hello' }, ['bridgebot']))
    .toEqual({ nick: null, text: '[Jane Doe] hello', relayed: false, mentionTarget: null });
});

test('manual display names override ordinary and extracted relay senders case-insensitively', () => {
  const displayNames = { ALICE: 'Alice Cooper', 'jane doe': 'Jane D.' };
  expect(displayIdentity({ nick: 'Alice', text: 'hello' }, [], displayNames))
    .toEqual({ nick: 'Alice Cooper', text: 'hello', relayed: false, mentionTarget: 'Alice' });
  const message = { nick: 'bridgebot', text: '[Jane Doe] hello' };
  expect(displayIdentity(message, ['bridgebot'], displayNames))
    .toEqual({ nick: 'Jane D.', text: 'hello', relayed: true, mentionTarget: 'Jane Doe' });
  expect(message.text).toBe('[Jane Doe] hello');
  expect(displayIdentity({ nick: 'Chatbot', text: '[jane] hi' }, ['Chatbot'], { JANE: 'Jane Smith' }))
    .toEqual({ nick: 'Jane Smith', text: 'hi', relayed: true, mentionTarget: 'jane' });
});

test('mentions match exact bare or @-prefixed names with original text offsets', () => {
  const text = 'ann: @ANN, not joann, ann_2, ann-b, or mail@ann. hi Ann!';
  const ranges = mentionRanges(text, ['Ann']);
  expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual(['ann', '@ANN', 'Ann']);
  expect(mentionsAny('joann ann_2 ann-b mail@ann', ['ann'])).toBe(false);
  expect(mentionsAny('Ping @aNn!', ['ANN'])).toBe(true);
});

test('Unicode word boundaries and overlapping aliases do not produce partial highlights', () => {
  const text = 'élena @Jane Doe Jane Doe Jane and ÉLENA';
  expect(mentionRanges(text, ['lena', 'Jane', 'Jane Doe', 'élena'])
    .map(({ start, end }) => text.slice(start, end)))
    .toEqual(['élena', '@Jane Doe', 'Jane Doe', 'Jane', 'ÉLENA']);
  expect(mentionsAny('nomément ÉLENA2', ['élena'])).toBe(false);
});
