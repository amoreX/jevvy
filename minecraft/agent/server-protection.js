const { simplify } = require('prismarine-nbt')

function deniedPosition(packet) {
  if (!packet.isActionBar || packet.content?.type !== 'compound') return null
  let message
  try { message = simplify(packet.content) } catch { return null }
  if (message.translate !== 'build.spawn_protection') return null
  const match = /^(-?\d+),\s*(-?\d+),\s*(-?\d+)$/.exec(message.with?.[0])
  if (!match) return null
  const [x, y, z] = match.slice(1).map(Number)
  return { x, y, z }
}

function protectedAt(position, state, dimension) {
  const area = state.serverSpawnProtection
  return !!area && dimension === area.dimension &&
    Math.max(Math.abs(position.x - area.x), Math.abs(position.z - area.z)) <= area.radius
}

function installServerProtection(bot, state, record) {
  if (!bot._client || typeof bot.dig !== 'function') return
  const originalDig = bot.dig.bind(bot)
  let active = null
  bot._client.on('system_chat', packet => {
    const position = deniedPosition(packet)
    if (!position) return
    const error = new Error(`Server spawn protection prevents breaking blocks at ${position.x}, ${position.y}, ${position.z}. Find resources outside spawn.`)
    const spawn = bot.spawnPoint
    if (spawn && bot.game?.dimension) {
      const previous = state.serverSpawnProtection
      const radius = Math.max(Math.abs(position.x - spawn.x), Math.abs(position.z - spawn.z))
      const sameCenter = previous?.dimension === bot.game.dimension && previous.x === spawn.x && previous.z === spawn.z
      // This is a confirmed minimum radius, not a guess at the server setting.
      if (!sameCenter || radius > previous.radius) {
        state.serverSpawnProtection = { x: spawn.x, z: spawn.z, dimension: bot.game.dimension, radius: Math.max(radius, sameCenter ? previous.radius : 0) }
        record(error.message, state.serverSpawnProtection)
      }
    }
    if (active?.position && active.position.x === position.x && active.position.y === position.y && active.position.z === position.z) {
      active.error = error
      // Stop before Mineflayer's optimistic completion turns the rejected block into air.
      bot.stopDigging()
    }
  })
  bot.dig = async (block, ...args) => {
    if (block && protectedAt(block.position, state, bot.game?.dimension)) throw new Error('Server spawn protection prevents breaking this block. Find resources outside spawn.')
    const attempt = { position: block?.position }
    active = attempt
    try {
      const result = await originalDig(block, ...args)
      if (attempt.error) throw attempt.error
      return result
    } catch (error) {
      throw attempt.error || error
    } finally {
      if (active === attempt) active = null
    }
  }
}

module.exports = { deniedPosition, protectedAt, installServerProtection }
