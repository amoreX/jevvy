const { setTimeout: delay } = require('node:timers/promises')
const { protectedAt } = require('./server-protection')

const woodenDoor = block => /_door$/.test(block?.name || '') && block.name !== 'iron_door'
const vegetation = block => /^(bamboo|vine|short_grass|tall_grass|fern|large_fern|dead_bush)$/.test(block?.name || '')

function naturalPaths(movements, state, target = null, dimension) {
  movements.canDig = !!target || !!state.autonomous
  const safe = movements.safeToBreak.bind(movements)
  movements.safeToBreak = block => {
    if (protectedAt(block.position, state, dimension)) return false
    const natural = !!state.autonomous && vegetation(block) && (!state.home || Math.hypot(block.position.x - state.home.x, block.position.z - state.home.z) >= state.protectRadius)
    return (!!target && block.position.equals(target) || natural) && safe(block)
  }
  return movements
}

function allowWoodenDoors(movements) {
  // Pathfinder 2.4.5's canOpenDoors only recognises fence gates. Model wooden
  // doors as passable; the executor opens reachable doors before crossing them.
  const getBlock = movements.getBlock.bind(movements)
  movements.getBlock = (...args) => {
    const block = getBlock(...args)
    if (woodenDoor(block)) {
      block.safe = true
      block.physical = false
      block.height = block.position.y
      block.shapes = []
    }
    return block
  }
  return movements
}

async function openNearbyDoors(bot, signal) {
  if (!bot.entity || !bot.blockAt || bot.currentWindow) return
  const origin = bot.entity.position.floored()
  for (let x = -3; x <= 3; x++) for (let y = -1; y <= 2; y++) for (let z = -3; z <= 3; z++) {
    signal.throwIfAborted()
    const b = bot.blockAt(origin.offset(x, y, z))
    if (!woodenDoor(b)) continue
    const props = b.getProperties()
    if (props.open || props.half === 'upper' || bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4.3 || (bot.canSeeBlock && !bot.canSeeBlock(b))) continue
    await bot.activateBlock(b)
    await delay(100, null, { signal })
  }
}

module.exports = { allowWoodenDoors, openNearbyDoors, naturalPaths, vegetation }
