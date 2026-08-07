const {
  DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS,
  evaluateClaudeTrafficGuardrail
} = require('../src/utils/claudeTrafficGuardrail')

describe('claudeTrafficGuardrail', () => {
  test('is disabled until explicitly enabled', () => {
    const result = evaluateClaudeTrafficGuardrail({
      max_tokens: DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxOutputTokens + 1
    })

    expect(result.allowed).toBe(true)
    expect(result.limits.enabled).toBe(false)
  })

  test('allows an ordinary request', () => {
    const result = evaluateClaudeTrafficGuardrail({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hello' }],
      tools: []
    })

    expect(result.allowed).toBe(true)
    expect(result.violations).toEqual([])
  })

  test('reports every exceeded request dimension', () => {
    const result = evaluateClaudeTrafficGuardrail(
      {
        max_tokens: 65,
        messages: [{ role: 'user' }, { role: 'assistant' }],
        tools: [{ name: 'one' }, { name: 'two' }],
        payload: 'x'.repeat(200)
      },
      {
        enabled: true,
        maxBodyBytes: 100,
        maxMessages: 1,
        maxTools: 1,
        maxOutputTokens: 64
      }
    )

    expect(result.allowed).toBe(false)
    expect(result.violations.map((violation) => violation.code)).toEqual([
      'request_body_bytes',
      'message_count',
      'tool_count',
      'max_output_tokens'
    ])
  })

  test('can be disabled explicitly', () => {
    const result = evaluateClaudeTrafficGuardrail(
      { max_tokens: DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxOutputTokens + 1 },
      { enabled: false }
    )

    expect(result.allowed).toBe(true)
  })
})
