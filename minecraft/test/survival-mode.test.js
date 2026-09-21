const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const keepSurvival = require('../survival-mode')

function fixture(mode = 'spectator') {
  const bot = new EventEmitter(), commands = []
  bot._client = new EventEmitter()
  bot.game = { gameMode: mode }
  bot.chat = command => commands.push(command)
  const state = keepSurvival(bot, () => {})
  const permissions = allowed => bot._client.emit('declare_commands', { rootIndex: 0, nodes: [
    { children: allowed ? [1] : [2] },
    { extraNodeData: { name: 'gamemode' } },
    { extraNodeData: { name: 'help' } }
  ] })
  return { bot, commands, state, permissions }
}

test('survival policy waits for permission and server confirmation without pretending the mode changed', () => {
  const { bot, commands, state, permissions } = fixture()
  permissions(false)
  bot.emit('spawn')
  assert.equal(state.status, 'needs_server_permission')
  assert.deepEqual(commands, [])
  permissions(true)
  assert.deepEqual(commands, ['/gamemode survival'])
  assert.equal(bot.game.gameMode, 'spectator')
  assert.equal(state.status, 'awaiting_server')
  bot.game.gameMode = 'survival'
  bot.emit('game')
  assert.equal(state.status, 'survival')
})

test('survival policy restores changed modes and avoids duplicate commands', () => {
  const { bot, commands, state, permissions } = fixture('survival')
  permissions(true)
  bot.emit('spawn')
  assert.deepEqual(commands, [])
  for (const mode of ['creative', 'spectator', 'adventure']) {
    bot.game.gameMode = mode
    bot.emit('game')
    bot.emit('spawn')
    permissions(true)
    bot.emit('game')
    bot.game.gameMode = 'survival'
    bot.emit('game')
  }
  assert.deepEqual(commands, Array(3).fill('/gamemode survival'))
  assert.equal(state.status, 'survival')
  bot.emit('end')
  assert.equal(state.status, 'disconnected')
})

test('survival policy handles spawn before command permissions and respects revoked permissions', () => {
  const { bot, commands, state, permissions } = fixture()
  bot.emit('spawn')
  assert.deepEqual(commands, [])
  permissions(true)
  assert.equal(commands.length, 1)
  bot.game.gameMode = 'survival'
  bot.emit('game')
  permissions(false)
  bot.game.gameMode = 'creative'
  bot.emit('game')
  assert.equal(state.status, 'needs_server_permission')
  assert.equal(commands.length, 1)
})
