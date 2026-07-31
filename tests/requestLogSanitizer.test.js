const {
  sanitizeRequestPayloadForLog,
  sanitizeResponsePayloadForLog
} = require('../src/utils/requestLogSanitizer')

describe('request log sanitizer', () => {
  test('summarizes inference payloads without retaining prompt content', () => {
    const result = sanitizeRequestPayloadForLog(
      {
        model: 'claude-sonnet-5',
        stream: false,
        max_tokens: 64,
        system: 'secret system prompt',
        messages: [{ role: 'user', content: 'private transcript' }]
      },
      '/api/v1/messages?beta=true'
    )

    expect(result).toMatchObject({
      _summary: 'inference_payload',
      model: 'claude-sonnet-5',
      maxTokens: 64,
      messageCount: 1
    })
    expect(JSON.stringify(result)).not.toContain('secret system prompt')
    expect(JSON.stringify(result)).not.toContain('private transcript')
  })

  test('masks credentials in small response payloads', () => {
    const result = sanitizeResponsePayloadForLog({
      success: true,
      proxy: { username: 'proxy-user', password: 'proxy-password' }
    })

    expect(result.proxy.password).not.toBe('proxy-password')
  })

  test('summarizes large account-list responses', () => {
    const result = sanitizeResponsePayloadForLog({
      success: true,
      data: Array.from({ length: 100 }, (_, index) => ({
        id: index,
        password: `secret-${index}`,
        description: 'x'.repeat(200)
      }))
    })

    expect(result).toMatchObject({
      _summary: 'response_payload',
      success: true,
      itemCount: 100
    })
    expect(JSON.stringify(result)).not.toContain('secret-1')
  })
})
