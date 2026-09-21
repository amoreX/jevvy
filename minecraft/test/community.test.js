const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.2')
const Block = require('prismarine-block')(registry)
const { Agent } = require('../agent')
const { Community } = require('../agent/community')
const { Language, CHAT_MODEL, fastPlan, validateStep } = require('../agent/language')
const { WorldMemory } = require('../agent/memory')
const { idleCatalog, planSkill, layout } = require('../agent/skills')
const { allowWoodenDoors } = require('../agent/navigation')

async function until(fn, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!fn()) { if (Date.now() > deadline) throw new Error('Condition did not become true'); await delay(10) }
}
function fixture(t, language) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-social-'))
  const bot = new EventEmitter(), counts = {}, world = new Map(), sent = []
  Object.assign(bot, { username: 'Jev', registry, _client: new EventEmitter(), health: 20, food: 20, game: { dimension: 'overworld', gameMode: 'survival' }, world: {}, isSleeping: false })
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true }
  bot.players = { Alice: { username: 'Alice', uuid: 'alice-id', entity: { id: 2, username: 'Alice', position: new Vec3(2, 64, 0) } }, Bob: { username: 'Bob', uuid: 'bob-id', entity: { id: 3, username: 'Bob', position: new Vec3(3, 64, 0) } }, Jev: { username: 'Jev', uuid: 'jev-id', entity: bot.entity } }
  bot.entities = Object.fromEntries(Object.values(bot.players).map(p => [p.entity.id, p.entity]))
  bot.inventory = { slots: Array(46).fill(null), items: () => Object.entries(counts).filter(([, n]) => n > 0).map(([name, count], i) => ({ name, count, slot: 9 + i, type: registry.itemsByName[name].id })) }
  bot.blockAt = p => {
    const b = Block.fromStateId(registry.blocksByName[world.get(p.toString()) || (p.y < 64 ? 'dirt' : 'air')].minStateId, 0)
    b.position = p.clone(); return b
  }
  bot.findBlocks = () => []
  bot.chat = text => sent.push(text)
  const agent = new Agent(bot, runtime, () => {})
  agent.apiKey = 'unit-test-key'
  agent.model.choose = async (state, instruction, choices) => ({ choice: Object.keys(choices)[0], confidence: 1 })
  const actions = []
  agent.executor.cancel = () => {}
  agent.executor.run = async (action, signal) => {
    actions.push(action)
    if (action.kind === 'follow' || action.kind === 'wait') await delay(60000, null, { signal })
    return { summary: `${action.kind} confirmed`, evidence: { performed: true } }
  }
  const community = new Community(agent, runtime, { world: 'test-server', timers: false, language })
  const replies = []
  community.say = async (name, text) => replies.push({ name, text })
  bot.emit('spawn')
  community.nextIdle = 0
  t.after(async () => { await community.stop(); community.close(); fs.rmSync(runtime, { recursive: true, force: true }) })
  return { bot, agent, community, runtime, counts, world, sent, actions, replies }
}

test('Luna uses strict structured output through OpenRouter and hides provider error bodies', async () => {
  let request
  const language = new Language(() => 'unit-secret', async (url, options) => {
    request = { url, body: JSON.parse(options.body) }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ intent: 'chat', reply: 'Hi!', ongoing: false, urgency: 'normal', memories: [], steps: [] }) } }] })
  })
  assert.equal((await language.interpret('hi', { speaker: 'Alice' })).reply, 'Hi!')
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(request.body.model, CHAT_MODEL)
  assert.equal(request.body.response_format.json_schema.strict, true)
  assert.equal(request.body.reasoning.effort, 'none')
  const bad = new Language(() => 'unit-secret', async () => new Response('unit-secret', { status: 401 }))
  await assert.rejects(bad.interpret('hi', {}), e => !e.message.includes('unit-secret') && /401/.test(e.message))
})

test('tree, crafting table and axe plan accepts named equipment slots and obtains prerequisites', async t => {
  // Captured from the live model for the request that produced "Invalid slot".
  const steps = [
    { skill: 'collect', args: '{"item":"oak_log","count":4}' },
    { skill: 'acquire', args: '{"item":"crafting_table","count":1}' },
    { skill: 'acquire', args: '{"item":"wooden_axe","count":1}' },
    { skill: 'equip', args: '{"item":"wooden_axe","slot":"hand"}' }
  ]
  const { community, agent, actions, counts } = fixture(t, { interpret: async () => ({ intent: 'task', reply: 'On it.', memories: [], steps }) })
  // Existing supplies let us reach the real action selector's equip step.
  Object.assign(counts, { oak_log: 4, crafting_table: 1, wooden_axe: 1 })
  await community.receive('local', 'mine nearest tree to get wood to make crafting table and a axe', 'local')
  await agent.runPromise
  assert.deepEqual(agent.state.goals.map(g => g.spec), [
    { kind: 'acquire', item: 'oak_log', count: 4 },
    { kind: 'acquire', item: 'crafting_table', count: 1 },
    { kind: 'acquire', item: 'wooden_axe', count: 1 },
    { kind: 'action', action: 'equip', args: { item: 'wooden_axe', destination: 'hand' }, repeat: 1 }
  ])
  assert.ok(agent.state.goals.every(g => g.status === 'done'))
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'equip')
  assert.equal(actions[0].destination, 'hand')
  assert.equal(actions[0].item, 'wooden_axe')
})

test('equipment aliases do not weaken inventory slot validation', () => {
  const bot = { registry }
  const original = { skill: 'equip', args: { item: 'shield', slot: 'offhand' } }
  assert.deepEqual(validateStep(original, bot).args, { item: 'shield', destination: 'off-hand' })
  assert.equal(original.args.slot, 'offhand')
  assert.equal(validateStep({ skill: 'unequip', args: { slot: 'helmet' } }, bot).args.destination, 'head')
  assert.equal(validateStep({ skill: 'hotbar', args: { slot: 0 } }, bot).args.slot, 0)
  assert.throws(() => validateStep({ skill: 'hotbar', args: { slot: 'hand' } }, bot), /Invalid slot/)
  assert.throws(() => validateStep({ skill: 'click_slot', args: { slot: -1 } }, bot), /Invalid slot/)
  for (const slot of ['invented', '__proto__', 36]) assert.throws(() => validateStep({ skill: 'equip', args: { item: 'wooden_axe', slot } }, bot), /Equipment destination/)
  assert.throws(() => validateStep({ skill: 'equip', args: { slot: 'head', destination: 'hand' } }, bot), /different destinations/)
})

test('model resource steps retain requested quantities and use recipe planning', () => {
  const bot = { registry }
  for (const skill of ['collect', 'craft', 'smelt']) assert.deepEqual(validateStep({ skill, args: { item: 'iron_ingot', count: 12 } }, bot), { kind: 'acquire', item: 'iron_ingot', count: 12 })
  assert.deepEqual(validateStep({ skill: 'collect', args: { target: 'oak_log', count: 4 } }, bot), { kind: 'acquire', item: 'oak_log', count: 4 })
  assert.throws(() => validateStep({ skill: 'collect', args: { target: 'invented_item' } }, bot), /Unknown Minecraft item/)
  assert.deepEqual(validateStep({ skill: 'place', args: { item: 'crafting_table' } }, bot), { kind: 'station', item: 'crafting_table' })
})

test('model plans normalize plural items across collection, recipes, equipment and anvil inputs', () => {
  const bot = { registry }
  assert.deepEqual(validateStep({ skill: 'acquire', args: '{"item":"jungle_logs","count":4}' }, bot), { kind: 'acquire', item: 'jungle_log', count: 4 })
  assert.deepEqual(validateStep({ skill: 'collect', args: { target: 'Jungle Logs', count: 4 } }, bot), { kind: 'acquire', item: 'jungle_log', count: 4 })
  assert.deepEqual(validateStep({ skill: 'craft', args: { item: 'crafting tables', count: 1 } }, bot), { kind: 'acquire', item: 'crafting_table', count: 1 })
  assert.deepEqual(validateStep({ skill: 'equip', args: { item: 'minecraft:wooden_axes', slot: 'hand' } }, bot).args, { item: 'wooden_axe', destination: 'hand' })
  assert.deepEqual(validateStep({ skill: 'anvil', args: { first: 'iron swords', second: 'iron swords' } }, bot).args, { first: 'iron_sword', second: 'iron_sword' })
  for (const item of ['unobtainium_logs', 'mod:jungle_log', '__proto__', 'constructor']) assert.throws(() => validateStep({ skill: 'acquire', args: { item } }, bot), /Unknown Minecraft item/)
  assert.deepEqual(fastPlan('get 4 jungle logs', bot, 'local').specs, [{ kind: 'acquire', item: 'jungle_log', count: 4 }])
})

test('spectator mining reports the server mode without starting work; observation still works', async t => {
  const { bot, community, agent, actions } = fixture(t)
  bot.game.gameMode = 'spectator'
  await assert.rejects(community.receive('local', 'get 4 logs', 'local'), /spectator mode/)
  assert.equal(actions.length, 0)
  assert.equal(community.state.current, null)
  community.lastSpoke.clear()
  await community.receive('local', 'look around', 'local')
  await agent.runPromise
  assert.equal(actions[0].kind, 'look')
  community.nextIdle = 0
  await community.tick()
  assert.equal(actions.length, 1)
})

test('modern chat resolves sender UUID, deduplicates legacy event and ignores unaddressed/self/spoofed chat', async t => {
  const { bot, community, actions, agent } = fixture(t)
  bot._client.emit('playerChat', { sender: 'alice-id', plainMessage: '@jev jump once' })
  bot.emit('chat', 'Alice', '@jev jump once')
  bot._client.emit('playerChat', { sender: 'jev-id', plainMessage: '@jev jump once' })
  bot._client.emit('playerChat', { sender: 'unknown-id', plainMessage: '@jev jump once' })
  bot.emit('chat', 'Alice', 'I found some coal')
  await community.chain
  await agent.runPromise
  assert.equal(actions.filter(a => a.kind === 'jump').length, 1)
  assert.ok(community.memory.data.players.Alice.conversations.some(c => c.text === 'I found some coal'))
})

test('contextual multi-step mining uses actual speaker and persists reported facts', async t => {
  let context
  const { bot, community, agent, runtime } = fixture(t, { interpret: async (text, value) => {
    context = value
    return { intent: 'task', reply: 'Coming.', ongoing: true, urgency: 'normal', memories: ['Alice found a coal cave.'], steps: [{ skill: 'visit', args: '{"target":"me"}' }, { skill: 'acquire', args: '{"item":"coal","count":8}' }] }
  } })
  agent.executor.run = async (action, signal) => { await delay(60000, null, { signal }) }
  await community.receive('Alice', '@jev come to me and help mine coal in this cave until I say stop')
  assert.equal(context.speaker, 'Alice')
  assert.deepEqual(context.world.players.find(p => p.name === 'Alice').position, { x: 2, y: 64, z: 0 })
  assert.equal(community.state.current.specs[0].args.target, 'Alice')
  assert.equal(community.state.current.specs[1].item, 'coal')
  assert.equal(community.state.current.ongoing, true)
  const restored = new WorldMemory(runtime, 'test-server')
  assert.equal(restored.data.players.Alice.facts[0].provenance, 'player_report')
  assert.match(restored.data.players.Alice.facts[0].source, /coal/)
  assert.throws(() => validateStep({ skill: 'goto', args: '{"position":{"x":999,"y":64,"z":99}}' }, bot, 'come here', 'Alice'), /not grounded/)
  assert.throws(() => validateStep({ skill: 'execute_shell', args: '{}' }, bot), /unknown/)
})

test('stop cancels an outstanding chat model immediately and prevents late work', async t => {
  let called, aborted = false
  const { community, actions } = fixture(t, { interpret: (text, context, signal) => new Promise((resolve, reject) => {
    called = true
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) })
  }) })
  const pending = community.receive('Alice', '@jev do a complicated dance for me')
  await until(() => called)
  const start = Date.now()
  await community.receive('Bob', '@jev stop')
  await pending
  assert.ok(Date.now() - start < 500)
  assert.equal(aborted, true)
  assert.equal(community.state.held, true)
  assert.equal(actions.length, 0)
})

test('Jev arbitrates a second player request, resumes the interrupted continuous job, and anyone can stop', async t => {
  const { community, agent, actions } = fixture(t)
  await community.receive('Alice', '@jev keep following me until I say stop')
  await until(() => actions.some(a => a.kind === 'follow'))
  assert.equal(community.state.current.owner, 'Alice')
  await community.receive('Bob', '@jev jump once')
  assert.equal(community.state.current.owner, 'Bob')
  assert.equal(community.state.pending[0].owner, 'Alice')
  await agent.runPromise
  await until(() => community.state.current === null)
  community.nextIdle = 0
  await community.tick()
  assert.equal(community.state.current.owner, 'Alice')
  await community.receive('Bob', '@jev stop')
  assert.equal(community.state.current, null)
  assert.equal(community.state.pending.length, 0)
  assert.equal(agent.running, false)
})

test('indefinite acquisition targets another fixed-size batch each cycle', async t => {
  const { community, counts } = fixture(t)
  counts.coal = 8
  const job = { id: 'ongoing', owner: 'Alice', text: 'keep mining coal', specs: [{ kind: 'acquire', item: 'coal', count: 8 }], source: 'chat', ongoing: true, created: Date.now(), goals: [{ status: 'done', lastResult: '8 coal collected' }] }
  community.state.current = job
  await community.finished(job)
  const next = community.state.pending.shift()
  assert.equal(next.specs[0].count, 8)
  community.launch(next)
  assert.equal(next.goals[0].spec.count, 16)
  await community.stop()
})

test('idle selection is broad, uses Jev and starts a real skill; failures cool down', async t => {
  const { community, agent, counts, actions } = fixture(t)
  Object.assign(counts, { oak_log: 16, oak_planks: 64, torch: 8, coal: 4, stone_pickaxe: 1, iron_ingot: 10, beef: 3 })
  const options = idleCatalog(agent, community.memory).map(c => c.tag)
  for (const tag of ['explore', 'shelter', 'platform', 'coal', 'iron_pickaxe', 'armor', 'light', 'cook']) assert.ok(options.includes(tag), tag)
  community.memory.data.skills.shelter = { successes: 0, failures: 1, lastAt: Date.now(), lastResult: 'No site' }
  assert.ok(!idleCatalog(agent, community.memory).some(c => c.tag === 'shelter'))
  agent.model.choose = async (s, i, choices) => ({ choice: choices.survey ? 'survey' : Object.keys(choices)[0], confidence: 1 })
  await community.tick()
  await agent.runPromise
  assert.ok(actions.some(a => a.kind === 'look'))
  assert.ok(community.memory.data.skills.survey.successes > 0)
})

test('building advances only on observed placements and never overwrites occupied sites', async t => {
  const { agent, counts, world } = fixture(t)
  counts.oak_planks = 64
  const spec = { kind: 'skill', skill: 'build_platform', args: { width: 3, length: 3, item: 'oak_planks' } }
  for (let n = 0; n < 12; n++) {
    const plan = planSkill(agent, spec)
    if (plan.complete) break
    const a = plan.candidates[0]
    assert.ok(a, plan.reasons.join(' '))
    if (a.kind === 'goto') agent.bot.entity.position = new Vec3(a.position.x - 2, a.position.y, a.position.z)
    else { assert.equal(a.kind, 'place_block'); world.set(vectorKey(a.destination), a.item); counts[a.item]-- }
  }
  assert.equal(planSkill(agent, spec).complete, true)
  assert.equal(layout(new Vec3(0, 64, 0), 5, 5, 3, true).some(p => p.x === 2 && p.y === 64 && p.z === 0), false)
  const blocked = { ...spec, layout: [{ x: 0, y: 63, z: 0 }] }
  assert.match(planSkill(agent, blocked).reasons.join(' '), /not overwrite/)
})
function vectorKey(p) { return new Vec3(p.x, p.y, p.z).toString() }

test('door commands are interactions; navigation treats only wooden doors as openable', () => {
  const bot = { registry, players: {}, entities: {} }
  const plan = fastPlan('open the door between u and ronis', bot, 'ronis')
  assert.equal(plan.specs[0].action, 'interact_block')
  assert.equal(plan.specs[0].args.open, true)
  const make = name => ({ name, safe: false, physical: true, position: { y: 64 }, shapes: [[0, 0, 0, 1, 1, 1]] })
  const moves = allowWoodenDoors({ getBlock: name => make(name) })
  assert.equal(moves.getBlock('acacia_door').safe, true)
  assert.equal(moves.getBlock('iron_door').safe, false)
})

test('player names and facts cannot pollute object prototypes', t => {
  const { community } = fixture(t)
  community.memory.remember('__proto__', ['A legitimate Minecraft username'], 'I live here')
  assert.equal(community.memory.data.players.__proto__.facts.length, 1)
  assert.equal(Object.prototype.facts, undefined)
})

test('unfinished human jobs and step progress survive reconnect', async t => {
  const { community, agent, runtime } = fixture(t)
  await community.receive('Alice', '@jev keep following me until I say stop')
  await until(() => agent.currentAction?.includes('following'))
  const id = community.state.current.id
  community.close()
  agent.pause('Reconnecting')
  await agent.runPromise
  const resumed = new Community(agent, runtime, { world: 'test-server', timers: false })
  assert.equal(resumed.state.pending[0].id, id)
  assert.equal(resumed.state.pending[0].goals[0].spec.args.target, 'Alice')
  assert.equal(resumed.state.current, null)
  resumed.close()
})

test('ongoing blocked jobs keep retrying with backoff instead of silently ending', async t => {
  const { community, agent } = fixture(t)
  const job = { id: 'forever', owner: 'Alice', source: 'chat', text: 'follow until stopped', specs: [], ongoing: true, retries: 5, goals: [{ status: 'queued', spec: { kind: 'action', action: 'follow' } }] }
  agent.message = 'Player is temporarily outside loaded chunks.'
  community.state.current = job
  await community.finished(job)
  assert.equal(community.state.pending[0].id, 'forever')
  assert.equal(community.state.pending[0].retries, 6)
  assert.ok(community.state.pending[0].retryAt - Date.now() > 55000)
  community.nextIdle = 0
  await community.tick()
  assert.equal(community.state.current, null, 'must not start idle work over a waiting human retry')
})

test('autonomous storage uses owned chests, retains supplies and closes the window at completion', t => {
  const { agent, community, bot, counts, world } = fixture(t)
  counts.oak_log = 40
  counts.stone_pickaxe = 1
  world.set(vectorKey({ x: 2, y: 64, z: 0 }), 'chest')
  community.memory.own('chest', { x: 2, y: 64, z: 0 }, 'overworld')
  const spec = { kind: 'skill', skill: 'store_items', args: {} }
  assert.equal(planSkill(agent, spec).candidates[0].kind, 'open_container')
  bot.currentWindow = { id: 5, type: 'chest', inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null) }
  bot.currentWindow.slots[27] = { name: 'oak_log', count: 40 }
  bot.currentWindow.slots[28] = { name: 'stone_pickaxe', count: 1 }
  const deposit = planSkill(agent, spec).candidates[0]
  assert.equal(deposit.kind, 'deposit')
  assert.equal(deposit.count, 24)
  bot.currentWindow.slots[27].count = 16
  assert.equal(planSkill(agent, spec).candidates[0].kind, 'close_window')
  bot.currentWindow = null
  assert.equal(planSkill(agent, spec).complete, true)
})

test('autonomous path clearing only breaks soft vegetation outside the home buffer', () => {
  const { naturalPaths } = require('../agent/navigation')
  const moves = naturalPaths({ safeToBreak: () => true }, { autonomous: true, home: { x: 0, y: 64, z: 0 }, protectRadius: 8 })
  assert.equal(moves.safeToBreak({ name: 'bamboo', position: new Vec3(12, 64, 0) }), true)
  assert.equal(moves.safeToBreak({ name: 'bamboo', position: new Vec3(2, 64, 0) }), false)
  assert.equal(moves.safeToBreak({ name: 'stone', position: new Vec3(12, 64, 0) }), false)
  assert.equal(moves.safeToBreak({ name: 'oak_planks', position: new Vec3(12, 64, 0) }), false)
})
