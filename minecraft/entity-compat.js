// 26.2 split attack from interact. Backported from the existing implementation:
// https://github.com/zkonikishi/Mineflayer/commit/f9e7db4447afda7838f08aa13430ec768738c178
// Field names follow the pinned minecraft-data 26.2 schema.
module.exports = function entityCompat(bot) {
  if (bot.version !== '26.2') return
  if (bot.look) {
    const look = bot.look.bind(bot)
    bot.look = (yaw, pitch, force) => {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new Error('Invalid camera coordinates; the action was not sent to Minecraft.')
      return look(yaw, pitch, force)
    }
  }
  const interact = (target, location = { x: 0, y: 0, z: 0 }) => bot._client.write('use_entity', {
    target: target.id, hand: 0, location, usingSecondaryAction: bot.getControlState('sneak')
  })
  bot.attack = (target, swing = true) => {
    bot._client.write('attack', { entityId: target.id })
    if (swing) bot.swingArm()
  }
  bot.useOn = target => interact(target)
  bot.mount = target => interact(target)
  bot.activateEntity = async target => {
    await bot.lookAt(target.position.offset(0, target.height / 2 || 0.5, 0), true)
    interact(target)
  }
  bot.activateEntityAt = async (target, location) => {
    await bot.lookAt(location, true)
    interact(target, location.minus(target.position))
  }
  bot.dismount = () => {
    if (!bot.vehicle) return
    bot._client.write('player_input', { inputs: { shift: true } })
  }
}
