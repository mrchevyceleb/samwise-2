import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthFailureText } from './runner.ts';

test('matches the CLI OAuth refresh-failure stderr signature', () => {
  // The exact string the claude CLI prints when a rotated refresh token
  // makes the in-memory token unrefreshable (the persistent-issue Matt hit).
  assert.equal(
    isAuthFailureText('Failed to authenticate: OAuth session expired and could not be refreshed'),
    true,
  );
  // Case/format variants of the same failure.
  assert.equal(isAuthFailureText('OAuth session expired'), true);
  assert.equal(isAuthFailureText('Error: OAuth token has expired'), true);
  assert.equal(
    isAuthFailureText('credentials could not be refreshed, please re-login'),
    true,
  );
  assert.equal(isAuthFailureText('Failed to authenticate: refresh token invalid'), true);
});

test('does not fire on unrelated stderr chatter', () => {
  // An MCP server printing "authenticate" must NOT tear the session down.
  assert.equal(isAuthFailureText('[mcp] server foo: user must authenticate in browser'), false);
  assert.equal(isAuthFailureText('warning: could not be refreshed cache entry'), false);
  assert.equal(isAuthFailureText('Compiling…'), false);
  assert.equal(isAuthFailureText('node: experimental warning'), false);
  assert.equal(isAuthFailureText(''), false);
});
