import { beforeAll, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted by Vitest to the top of the file before any imports.
// This ensures the mocked module is in place when db.ts is first imported.
vi.mock('sqlite-vec', () => ({
  load: vi.fn().mockImplementation(() => {
    throw new Error('Extension load failed');
  }),
}));

// db.ts is imported AFTER the mock is established (hoisting ensures this).
import { _initTestDatabase, isSemanticsEnabled } from './db.js';

describe('sqlite-vec graceful degradation', () => {
  beforeAll(() => {
    _initTestDatabase();
  });

  it('isSemanticsEnabled returns false when sqlite-vec load throws', () => {
    expect(isSemanticsEnabled()).toBe(false);
  });

  it('database initializes without throwing when sqlite-vec fails to load', () => {
    // If _initTestDatabase() threw, beforeAll would have failed and this test
    // would not run. Reaching this assertion confirms normal startup.
    expect(true).toBe(true);
  });
});
