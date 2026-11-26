// @scry.entry
// id: src.core-notes~235b7cb4
// kind: code
// summary: >-
//   Parse Beads six-key handoff notes into structured fields with raw fallback.
//   Also: notes, six-key, completed, in-progress, next, blockers, reference
// status: active
// weight: 0.7
// tags: ["topic:notes", "notes", "scope:src", "src", "beads"]
// rationale: >-
//   Lets the Issue Inspector render structured handoff keys cleanly while preserving freeform notes.
// applies: parsing bead notes, rendering issue inspector
// seeded_questions:
//   - "How does parseSixKeyNotes extract COMPLETED, IN PROGRESS, NEXT, BLOCKERS, KEY DECISION, and REFERENCE?"
//   - "src/core/notes.ts parseSixKeyNotes"
// @scry.entry.end

export interface SixKeyNotes {
  completed: string;
  inProgress: string;
  next: string;
  blockers: string;
  keyDecision: string;
  reference: string;
  hasStructuredKeys: boolean;
  raw: string;
}

const KEY_MAP: Array<[RegExp, keyof Omit<SixKeyNotes, 'hasStructuredKeys' | 'raw'>]> = [
  [/^COMPLETED:\s*(.*)$/i, 'completed'],
  [/^IN PROGRESS:\s*(.*)$/i, 'inProgress'],
  [/^NEXT:\s*(.*)$/i, 'next'],
  [/^BLOCKERS:\s*(.*)$/i, 'blockers'],
  [/^KEY DECISION:\s*(.*)$/i, 'keyDecision'],
  [/^REFERENCE:\s*(.*)$/i, 'reference'],
];

/**
 * Parse six-key Beads handoff notes separated by pipes or newlines.
 */
export function parseSixKeyNotes(notes?: string): SixKeyNotes {
  const raw = (notes || '').trim();
  const result: SixKeyNotes = {
    completed: '',
    inProgress: '',
    next: '',
    blockers: '',
    keyDecision: '',
    reference: '',
    hasStructuredKeys: false,
    raw,
  };
  if (!raw) return result;

  const segments = raw
    .split(/\s*\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    for (const [pattern, field] of KEY_MAP) {
      const match = pattern.exec(segment);
      if (match) {
        result[field] = match[1].trim();
        result.hasStructuredKeys = true;
        break;
      }
    }
  }
  return result;
}
