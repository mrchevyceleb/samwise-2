import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodexSelection } from './codex-models.ts';

test('resolves model-specific Codex efforts', () => {
  assert.deepEqual(resolveCodexSelection('gpt-6.1-sol', 'ultra'), {
    model: 'gpt-6.1-sol',
    effort: 'ultra',
  });
  assert.deepEqual(resolveCodexSelection('gpt-6-luna', 'max'), {
    model: 'gpt-6-luna',
    effort: 'max',
  });
  assert.deepEqual(resolveCodexSelection('gpt-6-luna', 'ultra'), {
    model: 'gpt-6-luna',
    effort: 'medium',
  });
});

test('rejects malformed browser values without coercing them', () => {
  const fallback = { model: 'gpt-6.1-sol', effort: 'low' };
  const hostile = { toString: null, valueOf: null };

  assert.doesNotThrow(() => resolveCodexSelection(hostile, hostile));
  assert.deepEqual(resolveCodexSelection(['gpt-6.1-sol'], ['ultra']), fallback);
  assert.deepEqual(resolveCodexSelection(hostile, hostile), fallback);
  assert.deepEqual(resolveCodexSelection(null, null), fallback);
  assert.deepEqual(resolveCodexSelection('__proto__', 'ultra'), fallback);
  assert.deepEqual(resolveCodexSelection('not-a-real-model', 'ultra'), fallback);
});
