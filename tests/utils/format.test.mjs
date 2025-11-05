import { test } from 'node:test';
import { strictEqual } from 'node:assert';
import { parseAmountInput, clamp01, toInt0 } from '../../public/js/utils/format.js';

test('parseAmountInput handles german formatted values', () => {
  strictEqual(parseAmountInput('1.234,56'), 1234.56);
  strictEqual(parseAmountInput('1.234.567,89'), 1234567.89);
});

test('parseAmountInput handles english formatted values', () => {
  strictEqual(parseAmountInput('1,234.56'), 1234.56);
  strictEqual(parseAmountInput('1234.56'), 1234.56);
});

test('clamp01 restricts values between 0 and 100', () => {
  strictEqual(clamp01(-20), 0);
  strictEqual(clamp01(50), 50);
  strictEqual(clamp01(150), 100);
});

test('toInt0 normalizes comma decimals and invalid numbers', () => {
  strictEqual(toInt0('12,7'), 13);
  strictEqual(toInt0('not-a-number'), 0);
});
