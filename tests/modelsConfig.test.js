const { CLAUDE_MODELS } = require('../config/models')

describe('models config', () => {
  it('places Claude Sonnet 4.6 as the second Claude model option', () => {
    expect(CLAUDE_MODELS[1]).toEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })

  it('exposes the canonical Claude Fable 5.1 model id', () => {
    expect(CLAUDE_MODELS).toContainEqual({
      value: 'claude-fable-5-1',
      label: 'Claude Fable 5.1'
    })
  })
})
