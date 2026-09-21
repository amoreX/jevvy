const MODEL = 'typesafe/jev-1.13'

class JevDecisions {
  constructor(getKey, sdkOptions = {}) {
    this.getKey = getKey
    this.sdkOptions = sdkOptions
  }

  async choose(state, instructions, criteria, signal) {
    const key = this.getKey()
    if (!key) throw new Error('The locally saved OpenRouter key is missing.')
    const { OpenRouter } = await import('@openrouter/sdk')
    const client = new OpenRouter({ apiKey: key, appTitle: 'Jev Minecraft', ...this.sdkOptions })
    let response
    try {
      response = await client.alpha.decisions.create({
        decisionsRequest: {
          model: MODEL, state,
          questions: { next: { type: 'choice', instructions, criteria } }
        }
      }, {
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]),
        retries: { strategy: 'none' }
      })
    } catch (error) {
      if (signal?.aborted) throw new Error('Paused')
      const status = error.statusCode || error.status
      const messages = {
        401: 'OpenRouter rejected the locally saved key.',
        402: 'OpenRouter credits are required for this key.',
        403: 'OpenRouter denied access to Jev for this key.',
        429: 'OpenRouter rate limit reached. Wait, then resume.',
        529: 'Jev is overloaded. Wait, then resume.'
      }
      // SDK errors can contain request objects. Never log or return them.
      throw new Error(messages[status] || `OpenRouter decision failed${status ? ` (HTTP ${status})` : ' or timed out'}. Resume to retry.`)
    }
    const answer = response.answers?.next
    if (answer?.type !== 'choice' || !Object.hasOwn(criteria, answer.choice)) {
      throw new Error('Jev returned an option outside the offered actions.')
    }
    const confidence = answer.confidence ?? answer.probabilities?.[answer.choice]
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Jev did not return a valid confidence score.')
    }
    return { choice: answer.choice, confidence, probabilities: answer.probabilities || {}, usage: response.usage }
  }
}

module.exports = { MODEL, JevDecisions }
