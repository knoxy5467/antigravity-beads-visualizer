import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolPayload, readHttpError } from '../../src/ui/host-bridge.js';

test('parseToolPayload throws tool error text when isError is true', () => {
  assert.throws(
    () =>
      parseToolPayload({
        isError: true,
        content: [{ type: 'text', text: 'Command failed: bd list --readonly --json' }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Command failed: bd list --readonly --json');
      return true;
    }
  );
});

test('parseToolPayload throws readable text error instead of SyntaxError for plain-text responses', () => {
  assert.throws(
    () =>
      parseToolPayload({
        content: [{ type: 'text', text: 'Dolt server is not reachable at 127.0.0.1:3307.' }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /Unexpected token/);
      assert.match(err.message, /Dolt server is not reachable/);
      return true;
    }
  );
});

test('parseToolPayload returns structuredContent or parses valid JSON text', () => {
  const fromStructured = parseToolPayload<{ workspaces: string[] }>({
    structuredContent: { workspaces: ['/synthetic/ws'] },
    content: [{ type: 'text', text: 'not-json' }],
  });
  assert.deepEqual(fromStructured, { workspaces: ['/synthetic/ws'] });

  const fromJsonText = parseToolPayload<{ unchanged: boolean }>({
    content: [{ type: 'text', text: '{"unchanged":true}' }],
  });
  assert.deepEqual(fromJsonText, { unchanged: true });
});

test('readHttpError extracts JSON error fields and falls back cleanly', async () => {
  const jsonRes = new Response(JSON.stringify({ error: 'Dolt server is not reachable.' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(await readHttpError(jsonRes), 'Dolt server is not reachable.');

  const textRes = new Response('Service unavailable', { status: 503 });
  assert.equal(await readHttpError(textRes), 'Service unavailable');

  const emptyRes = new Response('', { status: 502 });
  assert.equal(await readHttpError(emptyRes), 'HTTP 502');
});
