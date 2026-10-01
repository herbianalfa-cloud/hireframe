/**
 * Static guard over firestore.rules and storage.rules (ADR-011, ADR-018, ADR-019): every client
 * write the rules allow is listed here. A new `allow create|update|delete|write` anywhere else,
 * even a shape-validated one that the emulator tests' junk payloads would never satisfy, fails
 * this test. Runs in `npm run check`, no emulator needed.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const WRITE_OPS = new Set(['create', 'update', 'delete', 'write']);

/** Maps each match path (relative to the service root) to the write ops it allows. */
function allowedWrites(rules: string): Record<string, string[]> {
  const stack: (string | null)[] = [];
  const writes: Record<string, string[]> = {};
  for (const line of rules.split('\n').map((raw) => raw.replace(/\/\/.*$/, ''))) {
    const match = /^\s*match\s+(\S+)\s*\{\s*$/.exec(line);
    if (match) {
      stack.push(match[1] ?? '');
      continue;
    }
    // `allow write;` (no condition) and a condition on the next line both count as allowed.
    const allow = /^\s*allow\s+([a-z,\s]+?)\s*(?::(.*)|;)\s*$/.exec(line);
    if (allow) {
      const ops = (allow[1] ?? '').split(',').map((op) => op.trim());
      const neverAllowed = /^\s*if\s+false\s*;/.test(allow[2] ?? '');
      const path = stack
        .filter((part): part is string => part !== null)
        .slice(1) // the service root: /databases/{database}/documents or /b/{bucket}/o
        .join('');
      for (const op of ops.filter((candidate) => WRITE_OPS.has(candidate))) {
        if (!neverAllowed) (writes[path] ??= []).push(op);
      }
    }
    for (const char of line) {
      if (char === '{') stack.push(null);
      if (char === '}') stack.pop();
    }
  }
  return writes;
}

describe('client-writable paths', () => {
  it('firestore.rules opens only the M2 and M2.1 writes', () => {
    expect(allowedWrites(readFileSync('firestore.rules', 'utf8'))).toEqual({
      '/criteria/current': ['create', 'update'],
      '/criteria/{versionId}': ['create'],
      '/profile/{profileId}/documents/{docId}': ['update'],
      '/profile/{profileId}/facts/{factId}': ['update'],
      '/profile/{profileId}/facts/{factId}/versions/{versionId}': ['create'],
    });
  });

  it('storage.rules opens only the CV upload', () => {
    expect(allowedWrites(readFileSync('storage.rules', 'utf8'))).toEqual({
      '/profile/documents/{docId}/{fileName}': ['create'],
    });
  });

  it('catches a new shape-validated write on an Admin-only path', () => {
    const rules = `service cloud.firestore {
  match /databases/{database}/documents {
    match /usage/{month} {
      allow read: if isOwner();
      allow update: if isOwner() && request.resource.data.keys().hasOnly(['spendPence']);
    }
    match /config/{docId} {
      allow write: if false; // Admin SDK only
    }
    match /runs/{runId} {
      allow delete;
      allow create:
        if isOwner();
    }
  }
}`;
    expect(allowedWrites(rules)).toEqual({
      '/usage/{month}': ['update'],
      '/runs/{runId}': ['delete', 'create'],
    });
  });
});
