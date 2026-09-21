const { setTimeout: delay } = require('node:timers/promises')
const { goals } = require('mineflayer-pathfinder')
const { vector, point } = require('./planner')

async function until(test, signal, timeout, message) {
  const end = Date.now() + timeout
  while (!test()) {
    signal.throwIfAborted()
    if (Date.now() >= end) throw new Error(message)
    await delay(50, null, { signal })
  }
}
function item(bot, name) {
  const items = bot.currentWindow ? bot.currentWindow.slots.slice(bot.currentWindow.inventoryStart, bot.currentWindow.inventoryEnd).filter(Boolean) : bot.inventory.items()
  const found = items.find(i => i.name === name)
  if (!found) throw new Error(`${name} is no longer in the inventory.`)
  return found
}
function entity(bot, a, reach = 40) {
  const found = bot.entities[a.entityId]
  if (!found || found.isValid === false) throw new Error(`${a.target || 'The target'} is no longer visible.`)
  if (found.position.distanceTo(bot.entity.position) > reach) throw new Error('The target moved out of reach.')
  return found
}
function block(bot, a) {
  const found = bot.blockAt(vector(a.position))
  if (!found || (a.block && found.name !== a.block)) throw new Error('The selected block changed; a fresh action is required.')
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(found.position.offset(0.5, 0.5, 0.5)) > 5) throw new Error('The block is out of reach.')
  return found
}
function windowFor(bot, a) {
  const window = bot.currentWindow
  if (!window || window.id !== a.windowId) throw new Error('The window changed; a fresh action is required.')
  return window
}
const handlers = {
  inspect: async (e, a) => {
    const world = e.planner.observe()
    const details = a.section === 'inventory' ? world.inventory : a.section === 'position' ? world.position : a.section === 'window' ? world.window : a.section === 'nearby' ? { entities: world.entities, blocks: world.nearbyBlocks } : world
    return { summary: `Observed ${a.section}: ${JSON.stringify(details)}`, evidence: details }
  },
  wait: async (e, a, signal) => { await delay(a.seconds * 1000, null, { signal }) },
  jump: async (e, a, signal) => {
    const bot = e.bot
    if (!bot.entity.onGround || bot.vehicle) throw new Error('Cannot jump: Jev must be on the ground and outside a vehicle.')
    const start = point(bot.entity.position)
    bot.setControlState('jump', true)
    try {
      await until(() => !bot.entity.onGround, signal, 1500, 'The server did not let Jev jump.')
      bot.setControlState('jump', false)
      await until(() => bot.entity.onGround, signal, 8000, 'Jev has not landed yet.')
      return { summary: 'Jumped once and landed.', evidence: { start, end: point(bot.entity.position), landed: true } }
    } finally { bot.setControlState('jump', false) }
  },
  turn: async (e, a) => {
    const { yaw, pitch } = e.bot.entity
    const radians = a.degrees * Math.PI / 180
    await e.bot.look(yaw + (a.direction === 'left' ? radians : a.direction === 'right' ? -radians : 0), Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + (a.direction === 'up' ? radians : a.direction === 'down' ? -radians : 0))))
  },
  rotate: async (e, a, signal) => {
    const { yaw, pitch } = e.bot.entity
    for (let part = 1; part <= 24; part++) {
      e.check(signal)
      await e.bot.look(yaw + (a.direction === 'left' ? 1 : -1) * 2 * Math.PI * part / 24, pitch, true)
      await delay(50, null, { signal })
    }
    return { summary: 'Completed one full 360-degree rotation.', evidence: { degrees: 360, direction: a.direction } }
  },
  look_at: async (e, a) => { await e.bot.lookAt(a.entityId !== undefined ? entity(e.bot, a).position.offset(0, 1, 0) : vector(a.position).offset(0.5, 0.5, 0.5), true) },
  move: async (e, a, signal) => {
    const bot = e.bot
    const start = bot.entity.position.clone()
    const compass = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 }
    const control = { up: 'jump', down: 'sneak' }[a.direction] || (compass[a.direction] !== undefined ? 'forward' : a.direction)
    if (compass[a.direction] !== undefined) await bot.look(compass[a.direction], bot.entity.pitch, true)
    const deadline = Date.now() + (a.seconds || Math.min(60, Math.max(3, a.blocks * 2))) * 1000
    bot.setControlState(control, true)
    if (a.style === 'sprint') bot.setControlState('sprint', true)
    if (a.style === 'sneak') bot.setControlState('sneak', true)
    let lastProgress = Date.now(), last = start.clone()
    try {
      while (Date.now() < deadline) {
        e.check(signal)
        const p = bot.entity.position
        if (a.blocks && p.distanceTo(start) >= a.blocks - 0.1) break
        if (e.state.home && Math.hypot(p.x - e.state.home.x, p.z - e.state.home.z) > e.state.travelRadius) throw new Error('Reached the configured travel boundary.')
        if (p.distanceTo(last) > 0.15) { lastProgress = Date.now(); last = p.clone() }
        if (a.blocks && Date.now() - lastProgress > 2000) throw new Error('Movement is blocked by the terrain.')
        await delay(50, null, { signal })
      }
    } finally { bot.clearControlStates() }
    const distance = bot.entity.position.distanceTo(start)
    if (a.blocks && distance < a.blocks - 0.15) throw new Error(`Moved ${distance.toFixed(1)} of the requested ${a.blocks} blocks before timing out.`)
    return { summary: `Moved ${distance.toFixed(1)} blocks ${a.direction}.`, evidence: { start: point(start), end: point(bot.entity.position), distance } }
  },
  follow: async (e, a, signal) => {
    const bot = e.bot
    const findTarget = () => {
      const player = Object.values(bot.players || {}).find(p => p.username?.toLowerCase() === a.target?.toLowerCase())
      return entity(bot, player?.entity ? { ...a, entityId: player.entity.id } : a, 64)
    }
    let target = findTarget()
    await require('./navigation').openNearbyDoors(bot, signal)
    e.bot.pathfinder.setMovements(e.movements(null, a.style))
    e.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    const started = Date.now()
    const deadline = a.continuous ? Infinity : started + a.seconds * 1000
    let lastProgress = started
    let lastPosition = bot.entity.position.clone()
    while (Date.now() < deadline) {
      e.check(signal)
      const current = findTarget()
      if (current !== target) {
        target = current
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      }
      if (e.state.home && !e.state.autonomous && Math.hypot(target.position.x - e.state.home.x, target.position.z - e.state.home.z) > e.state.travelRadius) throw new Error('The target left the configured travel area.')
      const distance = bot.entity.position.distanceTo(target.position)
      if (distance <= 3.5 || bot.entity.position.distanceTo(lastPosition) >= 0.5) {
        lastProgress = Date.now()
        lastPosition = bot.entity.position.clone()
      } else if (Date.now() - lastProgress > 10000) {
        throw new Error(`Cannot reach ${a.target}: movement has been blocked for 10 seconds.`)
      }
      await delay(200, null, { signal })
    }
    return { summary: `Followed ${a.target} for ${a.seconds} seconds.`, evidence: { target: a.target, finalDistance: bot.entity.position.distanceTo(target.position) } }
  },
  explore: async (e, a, signal) => { await e.travel(a.position, 2, signal) },
  set_home: async e => { e.state.home = point(e.bot.entity.position); e.save() },
  dig: async (e, a, signal) => {
    const target = block(e.bot, a)
    if (!e.bot.canDigBlock(target)) throw new Error('This block cannot currently be broken.')
    await e.bot.tool.equipForBlock(target, { requireHarvest: false, getFromChest: false })
    e.check(signal)
    await e.bot.dig(target, true)
    await until(() => e.bot.blockAt(target.position)?.type !== target.type, signal, 2500, 'The server did not confirm the block breaking.')
  },
  harvest: async (e, a, signal) => handlers.dig(e, a, signal),
  till: async (e, a, signal) => {
    const target = block(e.bot, a)
    await e.bot.equip(item(e.bot, a.item), 'hand')
    await e.bot.activateBlock(target)
    await until(() => e.bot.blockAt(target.position)?.name === 'farmland', signal, 2500, 'The server did not create farmland.')
  },
  plant: async (e, a, signal) => {
    const target = block(e.bot, a)
    await e.bot.equip(item(e.bot, a.item), 'hand')
    e.check(signal)
    await e.bot.placeBlock(target, vector({ x: 0, y: 1, z: 0 }))
    if (e.bot.blockAt(target.position.offset(0, 1, 0))?.name === 'air') throw new Error('Planting was not confirmed.')
  },
  place_block: async (e, a, signal) => {
    const target = block(e.bot, a)
    if (!['air', 'cave_air'].includes(e.bot.blockAt(vector(a.destination))?.name)) throw new Error('The placement space is no longer empty.')
    await e.bot.equip(item(e.bot, a.item), 'hand')
    e.check(signal)
    await e.bot.placeBlock(target, vector(a.face))
    if (e.bot.blockAt(vector(a.destination))?.name === 'air') throw new Error('The server did not confirm placement.')
  },
  place_entity: async (e, a, signal) => {
    const target = block(e.bot, a)
    await e.bot.equip(item(e.bot, a.item), 'hand')
    e.check(signal)
    // Mineflayer's placeEntity still assumes old boat names and lacks minecart/
    // frame support. Reuse its generic placement and observe the spawned entity.
    let placed
    const names = new Set([a.item, a.item.replace(/_spawn_egg$/, ''), /boat|raft/.test(a.item) ? 'boat' : a.item])
    const onSpawn = other => { if (names.has(other.name) && other.position.distanceTo(target.position) <= 4) placed = other }
    e.bot.on('entitySpawn', onSpawn)
    try {
      if (/boat|raft/.test(a.item)) { await e.bot.lookAt(target.position.offset(0.5, 0.8, 0.5), true); e.bot.activateItem() }
      else await e.bot._genericPlace(target, vector(a.face), { forceLook: true, swingArm: 'right' })
      await until(() => !!placed, signal, 4000, 'The server did not confirm entity placement.')
      return { summary: `Placed ${a.item}.`, evidence: { entityId: placed.id } }
    } finally { e.bot.off('entitySpawn', onSpawn) }
  },
  interact_block: async (e, a, signal) => {
    const target = block(e.bot, a), before = target.getProperties()
    if (a.open !== undefined && before.open === a.open) return `The ${target.name} is already ${a.open ? 'open' : 'closed'}.`
    await e.bot.activateBlock(target)
    if (typeof before.open === 'boolean') await until(() => e.bot.blockAt(target.position)?.getProperties().open !== before.open, signal, 2500, 'The server did not confirm the door opening/closing.')
  },
  unequip: async (e, a) => { await e.bot.unequip(a.destination) },
  hotbar: async (e, a) => { e.bot.setQuickBarSlot(a.slot) },
  drop: async (e, a, signal) => {
    const before = e.planner.count(a.item)
    if (before < a.count) throw new Error('Not enough of that item remains.')
    await e.bot.toss(item(e.bot, a.item).type, null, a.count)
    e.check(signal)
    if (e.planner.count(a.item) > before - a.count) throw new Error('Dropping the items was not confirmed.')
  },
  move_slot: async (e, a) => {
    if (e.bot.inventory.slots[a.from]?.name !== a.item) throw new Error('The source slot changed.')
    await e.bot.moveSlotItem(a.from, a.to)
  },
  click_slot: async (e, a) => {
    const window = e.bot.currentWindow || e.bot.inventory
    if (window.id !== a.windowId || a.slot >= window.slots.length || ![0, 1].includes(a.mode)) throw new Error('The slot or click mode is no longer valid.')
    await e.bot.clickWindow(a.slot, a.button, a.mode)
  },
  open_container: async (e, a) => {
    const bot = e.bot
    if (bot.currentWindow) throw new Error('Close the current window first.')
    if (a.entityId !== undefined) {
      const target = entity(bot, a, 3.5)
      if (/villager|wandering_trader/.test(target.name)) {
        // Both use merchant windows; the installed plugin asserts the villager type.
        await bot.openVillager(target.name === 'wandering_trader' ? { ...target, entityType: bot.registry.entitiesByName.villager.id } : target)
      }
      else await bot.openContainer(target)
    } else {
      const target = block(bot, a)
      if (/furnace|smoker/.test(target.name)) await bot.openFurnace(target)
      else if (target.name === 'enchanting_table') await bot.openEnchantmentTable(target)
      else if (/anvil/.test(target.name)) await bot.openAnvil(target)
      else await bot.openContainer(target)
    }
    if (!bot.currentWindow) throw new Error('The server did not open a window.')
  },
  close_window: async (e, a) => { e.bot.closeWindow(windowFor(e.bot, a)) },
  withdraw: async (e, a, signal) => {
    const window = windowFor(e.bot, a)
    const found = window.slots.slice(0, window.inventoryStart).find(i => i?.name === a.item)
    if (!found) throw new Error('The item is no longer in this container.')
    const before = e.planner.count(a.item)
    await window.withdraw(found.type, null, a.count)
    e.check(signal)
    if (e.planner.count(a.item) < before + a.count) throw new Error('Withdrawal was not confirmed.')
  },
  deposit: async (e, a, signal) => {
    const before = e.planner.count(a.item)
    await windowFor(e.bot, a).deposit(item(e.bot, a.item).type, null, a.count)
    e.check(signal)
    if (e.planner.count(a.item) > before - a.count) throw new Error('Deposit was not confirmed.')
  },
  furnace_take: async (e, a) => { await windowFor(e.bot, a)[`take${a.part[0].toUpperCase()}${a.part.slice(1)}`]() },
  furnace_put: async (e, a) => { await windowFor(e.bot, a)[a.part === 'fuel' ? 'putFuel' : 'putInput'](item(e.bot, a.item).type, null, a.count) },
  enchant_put: async (e, a) => { await windowFor(e.bot, a)[a.part === 'lapis' ? 'putLapis' : 'putTargetItem'](item(e.bot, a.item)) },
  enchant: async (e, a) => { await windowFor(e.bot, a).enchant(a.choice) },
  enchant_take: async (e, a) => { await windowFor(e.bot, a).takeTargetItem() },
  anvil: async (e, a) => {
    const window = windowFor(e.bot, a)
    const first = window.slots[a.firstSlot]
    const second = window.slots[a.secondSlot]
    if (first?.name !== a.first || (a.second && second?.name !== a.second)) throw new Error('The selected anvil items changed.')
    if (a.second) await window.combine(first, second, a.text)
    else await window.rename(first, a.text)
  },
  trade: async (e, a) => { await e.bot.trade(windowFor(e.bot, a), a.tradeIndex, a.count) },
  wake: async e => { await e.bot.wake() },
  respawn: async (e, a, signal) => { e.bot.respawn(); await until(() => e.bot.health > 0, signal, 10000, 'The server did not respawn Jev.') },
  use_item: async (e, a, signal) => {
    if ((a.offhand ? e.bot.inventory.slots[45] : e.bot.heldItem)?.name !== a.item) throw new Error('The held item changed.')
    e.bot.activateItem(a.offhand || false)
    try { await delay(a.seconds * 1000, null, { signal }) } finally { e.bot.deactivateItem() }
  },
  release_item: async e => { e.bot.deactivateItem() },
  fish: async (e, a, signal) => {
    if (e.bot.heldItem?.name !== 'fishing_rod') throw new Error('Equip a fishing rod first.')
    await e.bot.fish()
    e.check(signal)
  },
  swing: async (e, a) => { e.bot.swingArm(a.hand) },
  attack: async (e, a, signal) => {
    const bot = e.bot, target = entity(bot, a, 3.5)
    let hurt = false, died = false
    const onHurt = other => { if (other.id === target.id) hurt = true }
    const onDead = other => { if (other.id === target.id) died = true }
    bot.on('entityHurt', onHurt)
    bot.on('entityDead', onDead)
    try {
      await bot.lookAt(target.position.offset(0, target.height / 2 || 0.5, 0), true)
      bot.attack(target)
      await until(() => hurt || died, signal, 2000, 'The server did not confirm a hit. The target may be protected or out of reach.')
      await delay(250, null, { signal })
      return { summary: `${died ? 'Defeated' : 'Hit'} ${a.target}.`, evidence: { entityId: target.id, hurt, died } }
    } finally { bot.off('entityHurt', onHurt); bot.off('entityDead', onDead) }
  },
  interact_entity: async (e, a) => { await e.bot.activateEntity(entity(e.bot, a, 3.5)) },
  mount: async (e, a, signal) => { e.bot.mount(entity(e.bot, a, 3.5)); await until(() => !!e.bot.vehicle, signal, 3000, 'The server did not mount this vehicle or animal.') },
  dismount: async (e, a, signal) => { e.bot.dismount(); await until(() => !e.bot.vehicle, signal, 3000, 'The server did not dismount Jev.') },
  steer: async (e, a, signal) => {
    if (!e.bot.vehicle) throw new Error('Jev is no longer mounted.')
    const inputs = { forward: [0, 1], back: [0, -1], left: [1, 0], right: [-1, 0] }[a.direction]
    e.bot.moveVehicle(...inputs)
    try { await delay(a.seconds * 1000, null, { signal }) } finally { e.bot.moveVehicle(0, 0) }
  },
  elytra: async e => { await e.bot.elytraFly() },
  creative_fly: async (e, a, signal) => {
    if (e.bot.game.gameMode !== 'creative') throw new Error('The server must put Jev in creative mode first.')
    e.bot._client.write('abilities', { flags: a.flying ? 2 : 0 })
    if (!a.flying) { e.bot.creative.stopFlying(); return }
    e.bot.creative.startFlying()
    if (a.position) {
      const destination = vector(a.position)
      if (destination.distanceTo(e.bot.entity.position) > 32) throw new Error('Creative flight is limited to 32 blocks per action.')
      // Reuse Mineflayer flight in short segments so Stop is observed promptly.
      while (destination.distanceTo(e.bot.entity.position) > 0.1) {
        e.check(signal)
        const delta = destination.minus(e.bot.entity.position)
        const next = e.bot.entity.position.plus(delta.scaled(Math.min(0.5, delta.norm()) / delta.norm()))
        if (e.bot.blockAt(next)?.boundingBox !== 'empty' || e.bot.blockAt(next.offset(0, 1, 0))?.boundingBox !== 'empty') throw new Error('Flight is blocked by terrain.')
        await e.bot.creative.flyTo(next)
      }
    }
  },
  creative_item: async (e, a) => {
    if (e.bot.game.gameMode !== 'creative') throw new Error('The server must put Jev in creative mode first.')
    const Item = require('prismarine-item')(e.bot.registry)
    await e.bot.creative.setInventorySlot(a.slot, new Item(e.bot.registry.itemsByName[a.item].id, a.count))
  },
  chat: async (e, a) => { e.bot.chat(a.text) },
  sign: async (e, a) => { await e.bot.updateSign(block(e.bot, a), a.text.replaceAll('|', '\n')) },
  book: async (e, a) => { await e.bot.writeBook(a.slot, a.pages) }
}
module.exports = { handlers, until }
