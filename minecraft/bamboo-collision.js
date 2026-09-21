// The 26.2 registry captured bamboo's shape at (0, 0, 0), including that
// location's -0.25 offset. Vanilla offsets its 3/16-wide collision column
// separately at each X/Z. Match BambooStalkBlock and BlockBehaviour.Properties
// in the official 26.2 client, using Mth.getSeed's signed Java arithmetic.
function bambooShape({ x, z }) {
  let seed = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n)
  seed = BigInt.asIntN(64, seed * seed * 42317861n + seed * 11n) >> 16n
  const dx = (Math.fround(Number(seed & 15n) / 15) - 0.5) * 0.5
  const dz = (Math.fround(Number((seed >> 8n) & 15n) / 15) - 0.5) * 0.5
  return [[0.40625 + dx, 0, 0.40625 + dz, 0.59375 + dx, 1, 0.59375 + dz]]
}

function installBambooCollision(bot) {
  if (bot.version !== '26.2') return
  const blockAt = bot.blockAt.bind(bot)
  bot.blockAt = (...args) => {
    const block = blockAt(...args)
    if (block?.name === 'bamboo') block.shapes = bambooShape(block.position)
    return block
  }
}

module.exports = { bambooShape, installBambooCollision }
