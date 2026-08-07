const {
  classifyClaudeOAuthError,
  extractClaudeOAuthError
} = require('../src/utils/claudeOAuthErrorClassifier')

describe('claudeOAuthErrorClassifier', () => {
  test('classifies invalid_grant as permanently revoked OAuth credentials', () => {
    const result = classifyClaudeOAuthError({
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Refresh token not found or invalid'
        }
      }
    })

    expect(result).toMatchObject({
      kind: 'oauth_revoked',
      permanent: true,
      accountStatus: 'unauthorized',
      errorCode: 'CLAUDE_OAUTH_REVOKED',
      statusCode: 400
    })
  })

  test('classifies nested disabled organization responses as blocked', () => {
    const result = classifyClaudeOAuthError(
      {
        error: {
          type: 'permission_error',
          message: 'OAuth authentication is currently not allowed for this organization'
        }
      },
      403
    )

    expect(result).toMatchObject({
      kind: 'account_blocked',
      permanent: true,
      accountStatus: 'blocked'
    })
  })

  test('supports configured blocked phrases without removing built-in rules', () => {
    expect(
      classifyClaudeOAuthError({ message: 'Tenant access frozen by policy' }, 403, {
        blockedPatterns: 'tenant access frozen'
      }).kind
    ).toBe('account_blocked')
    expect(
      classifyClaudeOAuthError({ message: 'This organization has been disabled' }, 400, {
        blockedPatterns: 'tenant access frozen'
      }).kind
    ).toBe('account_blocked')
  })

  test('keeps generic 401 and 403 errors non-permanent', () => {
    expect(classifyClaudeOAuthError({ message: 'Unauthorized' }, 401)).toMatchObject({
      kind: 'access_token_invalid',
      permanent: false
    })
    expect(classifyClaudeOAuthError({ message: 'Forbidden' }, 403)).toMatchObject({
      kind: 'permission_denied',
      permanent: false
    })
  })

  test('extracts a useful message from JSON strings', () => {
    expect(
      extractClaudeOAuthError('{"error":{"message":"account has been suspended"}}').message
    ).toBe('account has been suspended')
  })
})
