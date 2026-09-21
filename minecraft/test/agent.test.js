const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.2')
const Block = require('prismarine-block')(registry)
const { Planner, armorSlots, armorDestination } = require('../agent/planner')
const { parseGoal, armor } = require('../agent/catalog')
const { JevDecisions, MODEL } = require('../agent/jev')
const { Agent } = require('../agent')
const { Executor } = require('../agent/executor')

function fakeBot() {
  const bot = new EventEmitter()
  const counts = {}
  const slots = []
  const world = new Map()
  bot.registry = registry
  bot.inventory = { items: () => Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })), slots }
  bot.entity = { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 }
  bot.health = 20
  bot.food = 20
  bot.world = {}
  bot.entities = {}
  bot.players = {}
  bot.game = { dimension: 'overworld' }
  function block(name, p) {
    const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0)
    b.position = p
    return b
  }
  bot.blockAt = p => world.get(p.toString()) || block('air', p)
  bot.findBlocks = ({ matching }) => [...world.values()].filter(b => matching.includes(b.type)).map(b => b.position)
  bot.putBlock = (name, p) => world.set(p.toString(), block(name, p))
  return { bot, counts, slots }
}

test('OpenRouter SDK uses Jev alpha decisions, including cancellation and normalized usage', async () => {
  const { HTTPClient } = await import('@openrouter/sdk/lib/http.js')
  let captured
  const model = new JevDecisions(() => 'local-test-key', { httpClient: new HTTPClient({ fetcher: async req => {
    captured = { url: req.url, authorization: req.headers.get('authorization'), body: await req.json() }
    return new Response(JSON.stringify({ model: MODEL, answers: { next: { type: 'choice', choice: 'mine', confidence: 0.91, probabilities: { mine: 0.91, pause: 0.09 } } }, usage: { input_tokens: 55, output_tokens: 0, cost: 0.00000231 } }), { headers: { 'content-type': 'application/json' } })
  } }) })
  const result = await model.choose({ goal: 'iron' }, 'Choose next action', { mine: 'Mine exposed iron', pause: 'Stop' })
  assert.equal(captured.url, 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(captured.authorization, 'Bearer local-test-key')
  assert.equal(captured.body.model, MODEL)
  assert.equal(captured.body.questions.next.type, 'choice')
  assert.equal(result.usage.inputTokens, 55)
  assert.equal(result.choice, 'mine')
})

test('model rejects invented choices and hides credentials in SDK errors', async () => {
  const { HTTPClient } = await import('@openrouter/sdk/lib/http.js')
  const model = new JevDecisions(() => 'secret-test-value', { httpClient: new HTTPClient({ fetcher: async () => new Response(JSON.stringify({ model: MODEL, answers: { next: { type: 'choice', choice: 'execute_shell', confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } }), { headers: { 'content-type': 'application/json' } }) }) })
  await assert.rejects(model.choose({}, 'choose', { a: 'look' }), /outside the offered actions/)
  const bad = new JevDecisions(() => 'secret-test-value', { httpClient: new HTTPClient({ fetcher: async () => new Response(JSON.stringify({ error: { message: 'secret-test-value', code: 401 } }), { status: 401, headers: { 'content-type': 'application/json' } }) }) })
  await assert.rejects(bad.choose({}, 'choose', { a: 'look' }), error => !error.message.includes('secret-test-value') && /key/.test(error.message))
})

test('parse concrete quantities, sequential goal types and unsupported inputs', () => {
  assert.deepEqual(parseGoal('get 24 iron', registry), { kind: 'acquire', item: 'iron_ingot', count: 24 })
  assert.deepEqual(parseGoal('cook 4 beef', registry), { kind: 'acquire', item: 'cooked_beef', count: 4 })
  assert.equal(parseGoal('get iron armor', registry).items.length, 4)
  assert.deepEqual(parseGoal('go to -240, 121, -1180', registry).position, { x: -240, y: 121, z: -1180 })
  assert.equal(parseGoal('build a castle', registry), null)
  assert.throws(() => parseGoal('get 999 iron', registry), /quantity/)
})

test('real 26.2 recipes progress from no gear to all four iron armor pieces in a simulated world', () => {
  const { bot, counts, slots } = fakeBot()
  bot.putBlock('jungle_log', new Vec3(12, 64, 0))
  bot.putBlock('jungle_leaves', new Vec3(12, 67, 0))
  bot.putBlock('stone', new Vec3(14, 64, 0))
  bot.putBlock('iron_ore', new Vec3(16, 64, 0))
  const planner = new Planner(bot, () => ({ home: { x: 0, y: 64, z: 0 }, protectRadius: 8, travelRadius: 96 }))
  const goal = { kind: 'armor', items: armor }
  const performed = []
  for (let step = 0; step < 250; step++) {
    const plan = planner.plan(goal)
    if (plan.complete) break
    assert.ok(plan.candidates.length, `Planner blocked: ${plan.reasons.join('; ')}; inventory=${JSON.stringify(counts)}`)
    const a = plan.candidates[0]
    performed.push(a.kind)
    if (a.kind === 'collect') counts[a.item] = (counts[a.item] || 0) + 1
    else if (a.kind === 'craft') {
      const recipe = planner.Recipe.find(registry.itemsByName[a.item].id, null)[a.recipeIndex]
      for (const d of recipe.delta) {
        const name = registry.items[d.id].name
        counts[name] = (counts[name] || 0) + d.count * a.times
        assert.ok(counts[name] >= 0, `Craft used missing ingredient ${name}`)
      }
    } else if (a.kind === 'place') {
      counts[a.item]--
      bot.putBlock(a.item, new Vec3(a.item === 'furnace' ? 3 : 2, 64, 0))
    } else if (a.kind === 'smelt') {
      counts[a.input] -= a.count
      counts[a.fuel] -= a.fuelCount
      counts[a.item] = (counts[a.item] || 0) + a.count
      assert.ok(counts[a.input] >= 0 && counts[a.fuel] >= 0)
    } else if (a.kind === 'equip') {
      counts[a.item]--
      slots[armorSlots[armorDestination(a.item)]] = { name: a.item }
    } else assert.fail(`Unexpected action ${a.kind}`)
  }
  assert.equal(planner.complete(goal), true)
  for (const kind of ['collect', 'craft', 'place', 'smelt', 'equip']) assert.ok(performed.includes(kind))
})

test('home buffer and missing resources never produce a mining action', () => {
  const { bot } = fakeBot()
  bot.putBlock('iron_ore', new Vec3(2, 64, 0))
  const planner = new Planner(bot, () => ({ home: { x: 0, y: 64, z: 0 }, protectRadius: 8, travelRadius: 96 }))
  const plan = planner.plan({ kind: 'acquire', item: 'raw_iron', count: 1 })
  assert.equal(plan.candidates.length, 0)
  assert.match(plan.reasons.join(), /home buffer/)
})

function fixture(t) {
  const { bot } = fakeBot()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const agent = new Agent(bot, directory, () => {})
  agent.apiKey = 'fake-key-for-tests'
  agent.executor = { busy: false, cancel() {}, async run(a) { return a.label } }
  agent.model = { choose: async (state, instruction, criteria) => ({ choice: Object.keys(criteria)[0], confidence: 0.99, usage: { inputTokens: 10 } }) }
  return agent
}

test('two queued goals complete in order and persist across restart without autorun', async t => {
  const agent = fixture(t)
  agent.addGoals({ text: 'look around then look around' })
  const seen = []
  agent.executor.run = async action => { seen.push(action.kind); return 'looked' }
  agent.start()
  await agent.runPromise
  assert.deepEqual(seen, ['look', 'look'])
  assert.ok(agent.state.goals.every(g => g.status === 'done'))
  const restored = new Agent(agent.bot, path.dirname(agent.file), () => {})
  assert.equal(restored.running, false)
  assert.equal(restored.state.goals.filter(g => g.status === 'done').length, 2)
})

test('pause during model request prevents late decisions from executing', async t => {
  const agent = fixture(t)
  agent.addGoals({ text: 'look around' })
  let release
  agent.model.choose = () => new Promise(resolve => { release = resolve })
  let executed = false
  agent.executor.run = async () => { executed = true }
  agent.start()
  await new Promise(resolve => setImmediate(resolve))
  agent.pause()
  assert.throws(() => agent.start(), /still stopping/)
  release({ choice: 'a0', confidence: 1, usage: {} })
  await agent.runPromise
  assert.equal(executed, false)
  assert.equal(agent.state.goals[0].status, 'queued')
})

test('submitting a task starts immediately and replaces unfinished work', async t => {
  const agent = fixture(t)
  agent.addGoals({ text: 'get iron armor' })
  agent.submitTask('look around')
  assert.equal(agent.running, true)
  assert.equal(agent.state.goals.length, 1)
  assert.equal(agent.state.goals[0].text, 'look around')
  assert.throws(() => agent.submitTask('get iron armor'), /Stop the current task/)
  await agent.runPromise
  assert.equal(agent.state.goals[0].status, 'done')
  assert.equal(agent.message, 'Done. What next?')
})

test('invalid task input preserves existing work without starting it', t => {
  const agent = fixture(t)
  agent.addGoals({ text: 'get iron armor' })
  const id = agent.state.goals[0].id
  assert.throws(() => agent.submitTask('get 999 iron'), /quantity/)
  assert.equal(agent.state.goals[0].id, id)
  assert.equal(agent.running, false)
})

test('an unoffered model choice never executes, and Stop cancels remaining work', async t => {
  const agent = fixture(t)
  agent.addGoals({ text: 'look around then get iron armor' })
  agent.model.choose = async () => ({ choice: 'pause', confidence: 0.2, usage: {} })
  let executed = false
  agent.executor.run = async () => { executed = true }
  agent.start()
  await agent.runPromise
  assert.equal(executed, false)
  assert.match(agent.message, /outside the offered choices/)
  agent.stop()
  assert.ok(agent.state.goals.every(g => g.status === 'cancelled'))
})

test('a valid executable choice runs even with a low separation score', async t => {
  const agent = fixture(t)
  agent.model.choose = async (state, instruction, criteria) => ({ choice: Object.keys(criteria)[0], confidence: 0.09, usage: {} })
  let executed = false
  agent.executor.run = async () => { executed = true; return 'Looked around' }
  agent.submitTask('look around')
  await agent.runPromise
  assert.equal(executed, true)
  assert.equal(agent.state.goals[0].status, 'done')
})

test('remembered key is private and never present in public state or events', async t => {
  const agent = fixture(t)
  await agent.configureKey('a-secret-for-testing', true)
  assert.equal(fs.statSync(agent.keyFile).mode & 0o777, 0o600)
  assert.equal(JSON.stringify(agent.snapshot()).includes('a-secret-for-testing'), false)
  agent.forgetKey()
  assert.equal(fs.existsSync(agent.keyFile), false)
})

test('26.2 outgoing interaction packet numbers match the published upstream fix', () => {
  require('../protocol-fix')()
  const serializer = require('minecraft-protocol').createSerializer({ state: 'play', isServer: false, version: '26.2' })
  assert.deepEqual(serializer.createPacketBuffer({ name: 'arm_animation', params: { hand: 1 } }), Buffer.from([0x3f, 1]))
  assert.equal(registry.protocol.play.toServer.types.packet[1][0].type[1].mappings['0x42'], 'block_place')
  assert.equal(registry.protocol.play.toServer.types.packet[1][0].type[1].mappings['0x43'], 'use_item')
})

test('collection movement can only dig the selected target, and travel cannot dig or build', () => {
  const { bot } = fakeBot()
  bot.putBlock('stone', new Vec3(12, 64, 0))
  bot.putBlock('stone', new Vec3(13, 64, 0))
  const executor = new Executor(bot, {}, {}, () => {})
  const travel = executor.movements()
  assert.equal(travel.canDig, false)
  assert.equal(travel.allow1by1towers, false)
  assert.deepEqual(travel.scafoldingBlocks, [])
  const mining = executor.movements(new Vec3(12, 64, 0))
  assert.equal(mining.safeToBreak(bot.blockAt(new Vec3(12, 64, 0))), true)
  assert.equal(mining.safeToBreak(bot.blockAt(new Vec3(13, 64, 0))), false)
})

test('smelting refuses an occupied furnace before moving inventory', async () => {
  const { bot } = fakeBot()
  bot.putBlock('furnace', new Vec3(0, 64, 0))
  let closed = false
  bot.openFurnace = async () => ({ inputItem: () => ({ name: 'raw_iron', count: 4 }), outputItem: () => null, fuelItem: () => null, close: () => { closed = true } })
  const state = { smeltJob: null }
  const executor = new Executor(bot, {}, state, () => {})
  executor.travel = async () => {}
  await assert.rejects(executor.smelt({ position: { x: 0, y: 64, z: 0 }, item: 'iron_ingot', input: 'raw_iron', count: 4 }, new AbortController().signal), /occupied/)
  assert.equal(state.smeltJob, null)
  assert.equal(closed, true)
})

test('resuming a partial furnace batch collects remaining output without inserting duplicate input', async () => {
  const { bot } = fakeBot()
  bot.putBlock('furnace', new Vec3(0, 64, 0))
  let output = { name: 'iron_ingot', count: 3 }
  let input = { name: 'raw_iron', count: 3 }
  let received = 0
  bot.openFurnace = async () => ({
    inputItem: () => input, outputItem: () => output, fuelItem: () => ({ name: 'coal', count: 1 }),
    takeOutput: async () => { received += output.count; output = input ? { name: 'iron_ingot', count: input.count } : null; input = null },
    putInput: async () => assert.fail('Duplicate input'), putFuel: async () => assert.fail('Unneeded fuel'), close() {}
  })
  const state = { smeltJob: { position: { x: 0, y: 64, z: 0 }, item: 'iron_ingot', input: 'raw_iron', count: 8, collected: 2 } }
  const executor = new Executor(bot, {}, state, () => {})
  executor.travel = async () => {}
  await executor.smelt({}, new AbortController().signal)
  assert.equal(received, 6)
  assert.equal(state.smeltJob, null)
})

const { ActionSpace, definitions } = require('../agent/action-space')
const { handlers } = require('../agent/primitive-executor')
const { splitTasks } = require('../agent/commands')

test('every registered action has an executor, and compound repeats keep their quantities', () => {
  const existing = new Set(['goto', 'visit', 'look', 'collect', 'craft', 'place', 'smelt', 'equip', 'eat', 'sleep'])
  for (const kind of Object.keys(definitions)) assert.ok(existing.has(kind) || handlers[kind], `Missing executor for ${kind}`)
  const tasks = splitTasks('jump three times and rotate 6 times then walk forward 2 blocks')
  assert.equal(tasks.length, 3)
  assert.deepEqual(tasks.slice(0, 2).map(t => parseGoal(t, registry)), [
    { kind: 'action', action: 'jump', args: {}, repeat: 3 },
    { kind: 'action', action: 'rotate', args: { direction: 'right' }, repeat: 6 }
  ])
  assert.equal(parseGoal('follow ronis for 12 seconds', registry).action, 'follow')
  assert.equal(parseGoal('interact with oak door', registry).action, 'interact_block')
  assert.equal(parseGoal('drop 12 torches', registry).args.count, 12)
  assert.equal(parseGoal('equip shield in offhand', registry).args.destination, 'off-hand')
  assert.deepEqual(splitTasks('say "hello and jump then bye" then jump'), ['say "hello and jump then bye"', 'jump'])
})

test('live action options change with death, sleeping, inventory, targets and creative mode', () => {
  const { bot, counts, slots } = fakeBot()
  const planner = new Planner(bot, () => ({}))
  const space = new ActionSpace(bot, planner, {})
  bot.entity.onGround = true
  const first = space.enumerate().actions
  assert.ok(first.some(a => a.kind === 'jump'))
  assert.ok(!first.some(a => a.kind === 'eat' || a.kind === 'attack' || a.kind === 'creative_item' || a.kind === 'chat'))
  bot.health = 0
  assert.deepEqual(space.enumerate().actions.map(a => a.kind), ['respawn'])
  bot.health = 20; bot.isSleeping = true
  assert.ok(space.enumerate().actions.some(a => a.kind === 'wake'))
  assert.ok(!space.enumerate().actions.some(a => a.kind === 'jump'))
  bot.isSleeping = false; bot.food = 10; counts.bread = 2
  assert.ok(space.enumerate().actions.some(a => a.kind === 'eat' && a.item === 'bread'))
  bot.entities[5] = { id: 5, name: 'zombie', position: new Vec3(2, 64, 0) }
  bot.entities[6] = { id: 6, name: 'player', username: 'ronis', position: new Vec3(2, 64, 1) }
  const nearby = space.enumerate().actions
  assert.ok(nearby.some(a => a.kind === 'attack' && a.entityId === 5))
  assert.ok(!nearby.some(a => a.kind === 'attack' && a.entityId === 6))
  assert.ok(space.enumerate({ action: 'attack', args: { target: 'ronis' } }).actions.some(a => a.kind === 'attack' && a.entityId === 6))
  bot.entities[5].position = new Vec3(15, 64, 0)
  assert.ok(!space.enumerate().actions.some(a => a.kind === 'attack' && a.entityId === 5))
  assert.ok(space.prepare({ action: 'attack', args: { target: 'zombie' } }, space.enumerate().actions).every(a => a.kind === 'visit' && a.preparation))
  bot.game.gameMode = 'creative'
  assert.ok(space.enumerate({ action: 'creative_item', args: { item: 'stone' } }).actions.some(a => a.kind === 'creative_item'))
  slots[6] = { name: 'elytra' }; bot.entity.onGround = false
  assert.ok(space.enumerate().actions.some(a => a.kind === 'elytra'))
})

test('action arguments are state-derived, IDs are stable, and container options use the current window', () => {
  const { bot, counts } = fakeBot()
  const planner = new Planner(bot, () => ({}))
  const space = new ActionSpace(bot, planner, {})
  const first = space.enumerate().actions
  const second = space.enumerate().actions
  assert.deepEqual(first.map(a => a.id), second.map(a => a.id))
  counts.coal = 3
  assert.ok(!space.enumerate().actions.some(a => a.kind === 'withdraw'))
  bot.currentWindow = { id: 7, type: 'chest', inventoryStart: 2, slots: [{ name: 'iron_ingot', count: 12, type: registry.itemsByName.iron_ingot.id }, null], deposit() {}, withdraw() {} }
  const spec = { action: 'withdraw', args: { item: 'iron_ingot', count: 5 } }
  const available = space.enumerate(spec).actions
  assert.ok(!available.some(a => a.kind === 'jump' || a.kind === 'dig'))
  const options = space.forGoal(spec, available)
  assert.equal(options.length, 1)
  assert.equal(options[0].windowId, 7)
  assert.equal(options[0].count, 5)
  assert.ok(!available.some(a => a.kind === 'click_slot' && a.mode > 1))
})

test('three jumps and six rotations make nine model choices and nine completed actions in order', async t => {
  const agent = fixture(t)
  const seen = []
  agent.executor.run = async a => { seen.push(a.kind); return { summary: 'verified', evidence: { landed: true, degrees: 360 } } }
  agent.submitTask('jump 3 times and rotate 6 times')
  await agent.runPromise
  assert.deepEqual(seen, [...Array(3).fill('jump'), ...Array(6).fill('rotate')])
  assert.deepEqual(agent.state.goals.map(g => g.completedActions), [3, 6])
  assert.ok(agent.state.goals.every(g => g.status === 'done'))
  assert.equal(agent.state.usage.calls, 9)
  const records = fs.readFileSync(agent.auditFile, 'utf8').trim().split('\n').map(JSON.parse)
  const decisions = records.filter(r => r.type === 'decision')
  assert.equal(decisions.length, 9)
  assert.ok(decisions.every(r => r.state.available_actions.some(a => a.id === r.decision.choice)))
  assert.ok(decisions.every(r => r.state.available_actions.every(a => a.kind !== 'pause')))
})

test('jump completion requires actual takeoff and landing, and Stop releases controls', async () => {
  const { bot } = fakeBot()
  bot.entity.onGround = true
  let presses = 0
  bot.setControlState = (name, value) => {
    if (name === 'jump' && value) { presses++; bot.entity.onGround = false; setTimeout(() => { bot.entity.onGround = true }, 90) }
  }
  const executor = { bot }
  const result = await handlers.jump(executor, {}, new AbortController().signal)
  assert.equal(result.evidence.landed, true)
  assert.equal(presses, 1)
  const controller = new AbortController()
  let released = false
  bot.setControlState = (name, value) => { if (value) { bot.entity.onGround = false; controller.abort() } else released = true }
  await assert.rejects(handlers.jump(executor, {}, controller.signal))
  assert.equal(released, true)
})

test('rotation makes a complete incremental turn and preserves pitch', async () => {
  const { bot } = fakeBot()
  bot.entity.pitch = 0.25
  const views = []
  bot.look = async (yaw, pitch) => { views.push({ yaw, pitch }) }
  await handlers.rotate({ bot, check: signal => signal.throwIfAborted() }, { direction: 'right' }, new AbortController().signal)
  assert.equal(views.length, 24)
  assert.ok(Math.abs(views.at(-1).yaw + Math.PI * 2) < 1e-9)
  assert.ok(views.every(v => v.pitch === 0.25))
})

test('state changes reject stale block and window actions before mutation', async () => {
  const { bot } = fakeBot()
  bot.activateBlock = () => assert.fail('Should not mutate changed block')
  await assert.rejects(handlers.interact_block({ bot }, { block: 'chest', position: { x: 1, y: 64, z: 0 } }), /block changed/)
  bot.currentWindow = { id: 2, deposit: () => assert.fail('Should not touch replacement window') }
  await assert.rejects(handlers.furnace_take({ bot }, { windowId: 1, part: 'output' }), /window changed/)
})

test('container preparation opens first and only finishes after transferring requested items', async t => {
  const agent = fixture(t)
  agent.bot.putBlock('chest', new Vec3(2, 64, 0))
  const seen = []
  agent.executor.run = async a => {
    seen.push(a.kind)
    if (a.kind === 'open_container') agent.bot.currentWindow = { id: 7, type: 'chest', inventoryStart: 1, slots: [{ name: 'iron_ingot', count: 12, type: registry.itemsByName.iron_ingot.id }], withdraw() {} }
    return 'verified'
  }
  agent.submitTask('take 5 iron ingots from chest')
  await agent.runPromise
  assert.deepEqual(seen, ['open_container', 'withdraw'])
  assert.equal(agent.state.goals[0].completedActions, 1)
})

test('26.2 attack, interact and dismount serialize with current packet bodies', async () => {
  require('../protocol-fix')()
  const serializer = require('minecraft-protocol').createSerializer({ state: 'play', isServer: false, version: '26.2' })
  const packets = []
  const bot = { version: '26.2', _client: { write: (name, params) => { packets.push({ name, params, bytes: serializer.createPacketBuffer({ name, params }) }) } }, getControlState: () => false, swingArm() {}, lookAt: async p => { assert.ok([p.x, p.y, p.z].every(Number.isFinite), 'Entity interaction must have finite aim coordinates') }, vehicle: {} }
  require('../entity-compat')(bot)
  const target = { id: 123, height: 2, position: new Vec3(1, 64, 2) }
  bot.attack(target)
  await bot.activateEntity(target)
  bot.dismount()
  assert.deepEqual(packets.map(p => p.name), ['attack', 'use_entity', 'player_input'])
  assert.deepEqual(packets[0].params, { entityId: 123 })
  assert.deepEqual(packets[1].params.location, { x: 0, y: 0, z: 0 })
  assert.equal(packets[2].bytes.at(-1), 32)
})

test('recipe options include the dependency chain explaining why logs advance iron armor', () => {
  const { bot } = fakeBot()
  bot.putBlock('oak_log', new Vec3(12, 64, 0))
  bot.putBlock('oak_leaves', new Vec3(12, 67, 0))
  bot.putBlock('stone', new Vec3(14, 64, 0))
  bot.putBlock('iron_ore', new Vec3(16, 64, 0))
  const planner = new Planner(bot, () => ({ home: { x: 0, y: 64, z: 0 }, protectRadius: 8, travelRadius: 96 }))
  const plan = planner.plan({ kind: 'armor', items: armor })
  assert.ok(plan.candidates.some(a => a.kind === 'collect' && a.block === 'oak_log'))
  assert.ok(plan.requirements.some(r => r.dependencyPath.includes('iron_helmet') && r.dependencyPath.includes('oak_log')))
})

test('open-container inventory uses player slots from that window and confirms transfers before closing', async () => {
  const { bot, counts } = fakeBot()
  counts.iron_ingot = 0
  const iron = { name: 'iron_ingot', count: 5, type: registry.itemsByName.iron_ingot.id, slot: 0 }
  bot.currentWindow = { id: 9, type: 'chest', inventoryStart: 1, inventoryEnd: 3, slots: [iron, null, null], withdraw: async () => {
    bot.currentWindow.slots[0] = null
    bot.currentWindow.slots[1] = { ...iron, slot: 1 }
  } }
  const planner = new Planner(bot, () => ({}))
  await handlers.withdraw({ bot, planner, check: signal => signal.throwIfAborted() }, { item: 'iron_ingot', count: 5, windowId: 9 }, new AbortController().signal)
  assert.equal(planner.count('iron_ingot'), 5)
  assert.equal(bot.inventory.items().length, 0, 'Base inventory stays stale until Mineflayer closes the window')
})

test('enchanting uses the live window item slot, not the stale base inventory slot', async () => {
  const { bot, counts } = fakeBot()
  counts.iron_sword = 1
  const sword = { name: 'iron_sword', count: 1, type: registry.itemsByName.iron_sword.id, slot: 3 }
  let selected
  bot.currentWindow = { id: 4, type: 'enchanting', inventoryStart: 2, inventoryEnd: 38, slots: [null, null, null, sword], putTargetItem: async i => { selected = i.slot } }
  await handlers.enchant_put({ bot }, { item: 'iron_sword', part: 'target', windowId: 4 })
  assert.equal(selected, 3)
})

test('villager options use Mineflayer trade fields and exclude unavailable or unaffordable trades', () => {
  const { bot } = fakeBot()
  const emerald = { name: 'emerald', count: 10, type: registry.itemsByName.emerald.id, slot: 3 }
  const trade = { inputItem1: { name: 'emerald', count: 3 }, outputItem: { name: 'bread', count: 2 }, hasItem2: false, tradeDisabled: false, nbTradeUses: 0, maximumNbTradeUses: 16 }
  bot.currentWindow = { id: 2, type: 'merchant', inventoryStart: 3, inventoryEnd: 39, slots: [null, null, null, emerald], trades: [trade, { ...trade, tradeDisabled: true }, { ...trade, inputItem1: { name: 'emerald', count: 20 } }] }
  const space = new ActionSpace(bot, new Planner(bot, () => ({})), {})
  const options = space.enumerate().actions.filter(a => a.kind === 'trade')
  assert.equal(options.length, 1)
  assert.equal(options[0].tradeIndex, 0)
  assert.equal(options[0].item, 'bread')
})

test('a paraphrased atomic request is interpreted once, then finishes after one matching action', async t => {
  const agent = fixture(t)
  const seen = []
  agent.model.choose = async (state, instruction, criteria) => {
    const choice = criteria.turn ? 'turn' : Object.keys(criteria)[0]
    return { choice, confidence: 0.9, usage: {} }
  }
  agent.executor.run = async a => { seen.push(a); return 'Turned left' }
  agent.submitTask('face toward the left side')
  await agent.runPromise
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'turn')
  assert.equal(seen[0].direction, 'left')
  assert.equal(agent.state.goals[0].status, 'done')
})

test('resource paraphrases retain literal item names and quantities', async t => {
  const agent = fixture(t)
  agent.model.choose = async () => ({ choice: 'craft', confidence: 0.9, usage: {} })
  const goal = { text: 'I would like you to craft 4 oak planks please' }
  await agent.resolve(goal, new AbortController().signal)
  assert.deepEqual(goal.spec, { kind: 'acquire', item: 'oak_planks', count: 4 })
})

test('combat aims with three finite coordinates and waits for an actual hurt event', async () => {
  const { bot } = fakeBot()
  const target = { id: 3, name: 'zombie', position: new Vec3(2, 64, 1), height: 1.95 }
  bot.entities[3] = target
  bot.lookAt = async p => { assert.ok([p.x, p.y, p.z].every(Number.isFinite)); assert.equal(p.z, target.position.z) }
  bot.attack = other => bot.emit('entityHurt', other)
  const result = await handlers.attack({ bot }, { entityId: 3, target: 'zombie' }, new AbortController().signal)
  assert.equal(result.evidence.hurt, true)
  assert.equal(result.evidence.died, false)
  assert.equal(bot.listenerCount('entityHurt'), 0)
})

test('invalid camera angles are rejected before modifying physics or sending movement', () => {
  let calls = 0
  const bot = { version: '26.2', look: () => { calls++ } }
  require('../entity-compat')(bot)
  assert.throws(() => bot.look(NaN, 0), /Invalid camera/)
  assert.throws(() => bot.look(0, Infinity), /Invalid camera/)
  bot.look(0.5, 0)
  assert.equal(calls, 1)
})

test('follow wording separates the player name from continuous-follow instructions', () => {
  for (const text of ['follow ronis around keep moving to him', 'follow ronis around and keep moving to him', 'keep following ronis wherever he goes', 'continue following ronis', 'follow ronis until I press stop']) {
    const spec = parseGoal(text, registry, ['Ronis', 'ronis2'])
    assert.equal(spec.action, 'follow', text)
    assert.equal(spec.args.target, 'Ronis', text)
    assert.equal(spec.args.continuous, true, text)
  }
  const duration = parseGoal('keep following ronis around for twenty seconds', registry, ['ronis'])
  assert.equal(duration.args.target, 'ronis')
  assert.equal(duration.args.seconds, 20)
  assert.equal(duration.args.continuous, undefined, 'An explicit duration overrides indefinite follow')
  assert.equal(parseGoal('follow ronis for 2 minutes', registry).args.seconds, 120)
  assert.equal(parseGoal('follow ronis2 around', registry, ['ronis', 'ronis2']).args.target, 'ronis2')
})

test('navigation preserves named destinations and sprint style instead of selecting a compass direction or home', () => {
  const spec = parseGoal('sprint to ronis', registry, ['ronis'])
  assert.deepEqual(spec, { kind: 'action', action: 'visit', args: { target: 'ronis', style: 'sprint' }, repeat: 1 })
  assert.equal(parseGoal('move to amorex', registry, ['amor3x']).args.target, 'amorex', 'Do not silently replace a misspelled name')
  const { bot } = fakeBot()
  bot.entities[42] = { id: 42, username: 'ronis', position: new Vec3(2, 64, 0) }
  const space = new ActionSpace(bot, new Planner(bot, () => ({})), { home: { x: 0, y: 64, z: 0 } })
  const available = space.enumerate(spec).actions
  const choices = space.forGoal(spec, available)
  assert.equal(choices.length, 1)
  assert.equal(choices[0].target, 'ronis')
  assert.equal(choices[0].style, 'sprint')
  assert.deepEqual(space.forGoal({ action: 'goto', args: {} }, available), [], 'Missing coordinates must never select home')
})

test('resuming a saved malformed follow goal reparses the original request without a model guess', async t => {
  const agent = fixture(t)
  agent.bot.players.ronis = { username: 'ronis' }
  agent.model.choose = async () => assert.fail('Concrete navigation needs no intent-classification call')
  const goal = { text: 'follow ronis around keep moving to him', spec: { kind: 'action', action: 'follow', args: { target: 'ronis around keep moving to him', seconds: 15 }, repeat: 1 } }
  await agent.resolve(goal, new AbortController().signal)
  assert.equal(goal.spec.args.target, 'ronis')
  assert.equal(goal.spec.args.continuous, true)
})

test('continuous follow stays active beyond its default duration and Stop clears the path and controls', async () => {
  const { bot } = fakeBot()
  const target = { id: 7, username: 'ronis', position: new Vec3(2, 64, 0) }
  bot.entities[7] = target
  bot.players.ronis = { username: 'ronis', entity: target }
  const goals = []
  let clears = 0
  bot.pathfinder = { setMovements() {}, setGoal: (goal, dynamic) => goals.push({ goal, dynamic }) }
  bot.stopDigging = () => {}
  bot.clearControlStates = () => { clears++ }
  bot.deactivateItem = () => {}
  bot.quit = () => assert.fail('Stopping follow must not disconnect Minecraft')
  const executor = new Executor(bot, {}, {}, () => {})
  executor.movements = () => ({ canDig: false })
  const controller = new AbortController()
  let settled = false
  const run = executor.run({ kind: 'follow', label: 'Keep following ronis', entityId: 7, target: 'ronis', seconds: 0.01, continuous: true }, controller.signal)
  const checked = assert.rejects(run, /stop|abort/i).finally(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(settled, false)
  assert.equal(executor.busy, true)
  assert.equal(goals[0].dynamic, true)
  controller.abort(new Error('stop'))
  await checked
  assert.equal(executor.busy, false)
  assert.equal(goals.at(-1).goal, null)
  assert.ok(clears > 0)
})

test('timed follow completes and retargets the same player after their entity changes', async () => {
  const { bot } = fakeBot()
  const target = { id: 7, username: 'ronis', position: new Vec3(2, 64, 0) }
  const replacement = { ...target, id: 8 }
  bot.entities[7] = target
  bot.players.ronis = { username: 'ronis', entity: target }
  const tracked = []
  bot.pathfinder = { setMovements() {}, setGoal: goal => tracked.push(goal.entity.id) }
  const changed = setTimeout(() => {
    delete bot.entities[7]
    bot.entities[8] = replacement
    bot.players.ronis.entity = replacement
  }, 30)
  try {
    const result = await handlers.follow({ bot, state: {}, movements: () => ({}), check: signal => signal.throwIfAborted() }, { entityId: 7, target: 'ronis', seconds: 0.3 }, new AbortController().signal)
    assert.deepEqual(tracked, [7, 8])
    assert.equal(result.evidence.target, 'ronis')
    assert.equal(result.evidence.finalDistance, 2)
  } finally { clearTimeout(changed) }
})

test('a missing named target reports that name and the actual visible players', async t => {
  const agent = fixture(t)
  const target = { id: 8, username: 'amor3x', position: new Vec3(2, 64, 0) }
  agent.bot.entities[8] = target
  agent.bot.players.amor3x = { username: 'amor3x', entity: target }
  agent.submitTask('follow ronis around keep moving to him')
  await agent.runPromise
  assert.match(agent.message, /target named “ronis”/)
  assert.match(agent.message, /Visible players: amor3x/)
  assert.ok(!agent.message.includes('ronis around keep moving'))
})
