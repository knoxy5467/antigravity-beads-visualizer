import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSixKeyNotes } from '../../src/core/notes.js';

test('parseSixKeyNotes extracts all six standard Beads handoff keys', () => {
  const raw =
    'COMPLETED: Reader built. | IN PROGRESS: DAG layout. | NEXT: Write UI. | BLOCKERS: None. | KEY DECISION: Use SVG. | REFERENCE: specs/visualizer/spec.md';
  const parsed = parseSixKeyNotes(raw);
  assert.equal(parsed.completed, 'Reader built.');
  assert.equal(parsed.inProgress, 'DAG layout.');
  assert.equal(parsed.next, 'Write UI.');
  assert.equal(parsed.blockers, 'None.');
  assert.equal(parsed.keyDecision, 'Use SVG.');
  assert.equal(parsed.reference, 'specs/visualizer/spec.md');
  assert.equal(parsed.hasStructuredKeys, true);
});

test('parseSixKeyNotes preserves raw fallback for unstructured notes', () => {
  const parsed = parseSixKeyNotes('Plain freeform note text.');
  assert.equal(parsed.hasStructuredKeys, false);
  assert.equal(parsed.raw, 'Plain freeform note text.');
});
