const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { deniedPosition, protectedAt, installServerProtection } = require('../agent/server-protection')
const { naturalPaths } = require('../agent/navigation')
const { Planner } = require('../agent/planner')

function denial(position = '-24, 65, -14') {
  return { isActionBar: true, content: { type: 'compound', value: {
    translate: { type: 'string', value: 'build.spawn_protection' },
    with: { type: 'list', value: { type: 'string', value: [position] } }
  } } }
}

test('only structured server spawn-protection messages identify a blocked position', () => {
  assert.deepEqual(deniedPosition(denial()), { x: -24, y: 65, z: -14 })
  assert.equal(deniedPosition({ content: 'build.spawn_protection -24, 65, -14', isActionBar: true }), null)
  assert.equal(deniedPosition({ ...denial(), isActionBar: false }), null)
  assert.equal(deniedPosition(denial('invalid coordinates')), null)
})

test('a server denial aborts optimistic digging and persists only the confirmed area', async () => {
  let finish, abort, predictedAir = false, records = 0, digs = 0
  const bot = { _client: new EventEmitter(), spawnPoint: new Vec3(-32, 88, 0), game: { dimension: 'overworld' },
    dig: async () => {
      digs++
      await new Promise((resolve, reject) => { finish = resolve; abort = reject })
      predictedAir = true
    },
    stopDigging: () => abort(new Error('Digging aborted')) }
  const state = {}
  installServerProtection(bot, state, () => records++)
  const result = bot.dig({ position: new Vec3(-24, 65, -14) })
  bot._client.emit('system_chat', denial())
  finish()
  await assert.rejects(result, /Server spawn protection/)
  assert.equal(predictedAir, false)
  assert.deepEqual(state.serverSpawnProtection, { x: -32, z: 0, dimension: 'overworld', radius: 14 })
  assert.equal(protectedAt(new Vec3(-32, 100, 14), state, 'overworld'), true)
  assert.equal(protectedAt(new Vec3(-32, 100, 15), state, 'overworld'), false)
  assert.equal(protectedAt(new Vec3(-32, 100, 14), state, 'the_nether'), false)
  await assert.rejects(bot.dig({ position: new Vec3(-24, 65, -14) }), /spawn protection/)
  assert.equal(digs, 1)
  bot._client.emit('system_chat', denial('-32, 70, -16'))
  bot._client.emit('system_chat', denial())
  assert.equal(state.serverSpawnProtection.radius, 16)
  assert.equal(records, 2)
})

test('resource selection and path clearing both avoid confirmed spawn protection', () => {
  const state = { autonomous: true, serverSpawnProtection: { x: -32, z: 0, dimension: 'overworld', radius: 14 } }
  const inside = { name: 'bamboo', diggable: true, position: new Vec3(-24, 65, -14) }
  const outside = { ...inside, position: new Vec3(-24, 65, -17) }
  const moves = naturalPaths({ safeToBreak: () => true }, state, inside.position, 'overworld')
  assert.equal(moves.safeToBreak(inside), false)
  assert.equal(moves.safeToBreak(outside), true)
  const planner = Object.create(Planner.prototype)
  planner.settings = () => state
  planner.blockedPositions = new Set()
  planner.bot = { game: { dimension: 'overworld' }, entity: { position: new Vec3(-23, 65, -14) }, blockAt: () => ({ boundingBox: 'empty' }) }
  assert.equal(planner.collectable(inside), false)
  assert.equal(planner.collectable(outside), true)
})
