import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_COLORS, PALETTE_TEXT, resolveColorId } from './colors.js';

test('the palette is Google\'s eleven fixed event colours', () => {
  assert.deepEqual(Object.keys(EVENT_COLORS), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  assert.equal(EVENT_COLORS[11], 'Tomato');
});

test('a numeric id resolves to itself as a string', () => {
  assert.equal(resolveColorId('11'), '11');
  assert.equal(resolveColorId(11), '11');
  assert.equal(resolveColorId('1'), '1');
});

test('a colour name resolves regardless of case or surrounding whitespace', () => {
  assert.equal(resolveColorId('Tomato'), '11');
  assert.equal(resolveColorId('tomato'), '11');
  assert.equal(resolveColorId('TOMATO'), '11');
  assert.equal(resolveColorId('  Sage '), '2');
});

test('every name in the palette round-trips to its id', () => {
  for (const [id, name] of Object.entries(EVENT_COLORS)) {
    assert.equal(resolveColorId(name), id);
    assert.equal(resolveColorId(id), id);
  }
});

test('undefined passes through so callers can forward an optional argument', () => {
  assert.equal(resolveColorId(undefined), undefined);
});

test('an unknown value is rejected with the full palette in the message', () => {
  for (const bad of ['Magenta', '12', '0', '', ' ', null, 'Tomat0']) {
    assert.throws(() => resolveColorId(bad), (err) => {
      assert.match(err.message, /^Unknown colorId /);
      assert.ok(err.message.includes(PALETTE_TEXT), 'message lists the palette');
      assert.ok(err.message.includes('11 Tomato'));
      return true;
    }, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
