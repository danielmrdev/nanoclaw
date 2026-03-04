import { describe, expect, it } from 'vitest';
import { validateToken } from './token-validator.js';

describe('validateToken', () => {
  it('returns valid for a well-formed non-expired token', () => {
    const result = validateToken({
      claudeAiOauth: {
        accessToken: 'sk-ant-abc123',
        expiresAt: Date.now() + 10000,
      },
    });
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid for empty object (missing accessToken)', () => {
    const result = validateToken({});
    expect(result).toEqual({
      valid: false,
      reason: 'Missing accessToken in credentials',
    });
  });

  it('returns invalid for wrong token format', () => {
    const result = validateToken({
      claudeAiOauth: { accessToken: 'invalid-token' },
    });
    expect(result).toEqual({
      valid: false,
      reason: 'Invalid token format (should start with sk-ant-)',
    });
  });

  it('returns invalid with reason containing "Token expired" for expired token', () => {
    const result = validateToken({
      claudeAiOauth: {
        accessToken: 'sk-ant-abc',
        expiresAt: Date.now() - 1000,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Token expired/);
  });

  it('returns valid when expiresAt is absent (no expiry check)', () => {
    const result = validateToken({
      claudeAiOauth: { accessToken: 'sk-ant-abc' },
    });
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid for null input', () => {
    const result = validateToken(null);
    expect(result).toEqual({
      valid: false,
      reason: 'Missing accessToken in credentials',
    });
  });
});
