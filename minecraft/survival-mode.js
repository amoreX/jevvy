// This is a fixed owner-requested command, never a model-generated command.
// Only server packets determine the actual mode; never overwrite bot.game.
module.exports = function keepSurvival(bot, log) {
  const state = { desired: 'survival', actual: null, canChange: null, status: 'connecting' }
  let spawned = false
  let requestedFor = null
  let previous = ''

  function enforce() {
    state.actual = bot.game?.gameMode || null
    if (state.actual === 'survival') {
      state.status = 'survival'
      requestedFor = null
    } else if (!spawned || !state.actual || state.canChange === null) {
      state.status = 'connecting'
    } else if (!state.canChange) {
      state.status = 'needs_server_permission'
    } else {
      state.status = 'awaiting_server'
      // Duplicate game/spawn/command packets must not flood server chat.
      if (requestedFor !== state.actual) {
        requestedFor = state.actual
        bot.chat('/gamemode survival')
      }
    }
    const current = JSON.stringify(state)
    if (current !== previous) {
      previous = current
      log('survival_mode', { ...state })
    }
  }

  bot._client.on('declare_commands', packet => {
    const root = packet.nodes?.[packet.rootIndex]
    const allowed = (root?.children || []).some(index => packet.nodes[index]?.extraNodeData?.name === 'gamemode')
    if (allowed !== state.canChange) requestedFor = null
    state.canChange = allowed
    enforce()
  })
  bot.on('spawn', () => { spawned = true; enforce() })
  bot.on('game', enforce)
  bot.on('end', () => { spawned = false; state.status = 'disconnected' })
  return state
}
