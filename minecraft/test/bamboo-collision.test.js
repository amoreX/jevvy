const test = require('node:test')
const assert = require('node:assert/strict')
const { bambooShape, installBambooCollision } = require('../bamboo-collision')

test('26.2 bamboo collision follows the vanilla position offset, including signed overflow', () => {
  assert.deepEqual(bambooShape({ x: 0, z: 0 }), [[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]])
  assert.deepEqual(bambooShape({ x: -24, z: -15 }), [[0.2562500014901161, 0, 0.3895833343267441, 0.4437500014901161, 1, 0.5770833343267441]])
  assert.deepEqual(bambooShape({ x: 30000000, z: -30000000 }), [[0.4895833432674408, 0, 0.2562500014901161, 0.6770833432674408, 1, 0.4437500014901161]])
})

test('the compatibility hook only changes bamboo shapes in the affected version', () => {
  const registry = require('prismarine-registry')('26.2')
  const Block = require('prismarine-block')(registry)
  const originalShapes = Block.fromStateId(registry.blocksByName.bamboo.minStateId, 0).shapes
  const position = { x: -24, y: 65, z: -15 }
  const bamboo = { name: 'bamboo', position, shapes: originalShapes }
  const stone = { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }
  const bot = { version: '26.2', blockAt: p => p === position ? bamboo : stone }
  installBambooCollision(bot)
  assert.deepEqual(bot.blockAt(position).shapes, bambooShape(position))
  assert.equal(bot.blockAt(null), stone)
  assert.deepEqual(originalShapes, [[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]])
  const unaffected = { version: '1.21.11', blockAt: () => bamboo }
  const original = unaffected.blockAt
  installBambooCollision(unaffected)
  assert.equal(unaffected.blockAt, original)
})
