/**
 * Normalize Claude SSE events before forwarding them to compatibility
 * clients. Some Claude tool streams occasionally omit partial_json on an
 * input_json_delta event; Go clients commonly model that field as *string
 * and may panic when dereferencing the missing value.
 */
function normalizeClaudeSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:')) {
    return line
  }

  const jsonText = line.slice(5).trim()
  if (!jsonText || jsonText === '[DONE]') {
    return line
  }

  let event
  try {
    event = JSON.parse(jsonText)
  } catch {
    return line
  }

  if (
    event?.type !== 'content_block_delta' ||
    event.delta?.type !== 'input_json_delta' ||
    (event.delta.partial_json !== null && event.delta.partial_json !== undefined)
  ) {
    return line
  }

  return `data: ${JSON.stringify({
    ...event,
    delta: { ...event.delta, partial_json: '' }
  })}`
}

module.exports = { normalizeClaudeSseLine }
