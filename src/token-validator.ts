export interface TokenValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateToken(creds: unknown): TokenValidationResult {
  const c = creds as Record<string, any> | null | undefined;

  if (!c?.claudeAiOauth?.accessToken) {
    return { valid: false, reason: 'Missing accessToken in credentials' };
  }

  if (!c.claudeAiOauth.accessToken.startsWith('sk-ant-')) {
    return {
      valid: false,
      reason: 'Invalid token format (should start with sk-ant-)',
    };
  }

  if (c.claudeAiOauth.expiresAt && c.claudeAiOauth.expiresAt < Date.now()) {
    return {
      valid: false,
      reason: `Token expired at ${new Date(c.claudeAiOauth.expiresAt).toISOString()}`,
    };
  }

  return { valid: true };
}
