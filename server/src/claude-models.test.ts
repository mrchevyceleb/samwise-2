import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClaudeSelection } from './claude-models.ts';

test('resolves model-specific Claude efforts', () => {
  assert.deepEqual(resolveClaudeSelection('claude-opus-5-5', 'xhigh'), {
    model: 'claude-opus-5-5',
    effort: 'xhigh',
  });
  assert.deepEqual(resolveClaudeSelection('claude-sonnet-5-5', 'low'), {
    model: 'claude-sonnet-5-5',
    effort: 'low',
  });
  // Unsupported effort falls back to the model's default, not a global one.
  assert.deepEqual(resolveClaudeSelection('claude-sonnet-5-5', 'ultra'), {
    model: 'claude-sonnet-5-5',
    effort: 'high',
  });
});

test('defaults to Fable 5.1 at max effort when nothing is requested', () => {
  assert.deepEqual(resolveClaudeSelection(undefined, undefined), {
    model: 'claude-fable-5-1',
    effort: 'max',
  });
});

test('rejects malformed browser values without coercing them', () => {
  const fallback = { model: 'claude-fable-5-1', effort: 'max' };
  const hostile = { toString: null, valueOf: null };

  assert.doesNotThrow(() => resolveClaudeSelection(hostile, hostile));
  assert.deepEqual(resolveClaudeSelection(['claude-fable-5-1'], ['xhigh']), fallback);
  assert.deepEqual(resolveClaudeSelection(hostile, hostile), fallback);
  assert.deepEqual(resolveClaudeSelection(null, null), fallback);
  assert.deepEqual(resolveClaudeSelection('__proto__', 'xhigh'), fallback);
  assert.deepEqual(resolveClaudeSelection('not-a-real-model', 'xhigh'), fallback);
});
