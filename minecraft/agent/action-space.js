const { createHash } = require('node:crypto')
const { Vec3 } = require('vec3')
const { point, armorDestination } = require('./planner')

// Concrete options use current item slots, entity IDs and block positions. A model
// never supplies a function name or argument that was absent from this snapshot.
const definitions = {
  inspect: ['Observation', 'Read inventory, position, entities, blocks or the open window.'],
  look: ['Observation', 'Look around in four directions.'],
  look_at: ['Observation', 'Look at a visible entity, block or coordinate.'],
  turn: ['Movement', 'Turn left/right or look up/down by a specified angle.'],
  rotate: ['Movement', 'Perform one full 360-degree rotation.'],
  jump: ['Movement', 'Jump once, then land.'],
  move: ['Movement', 'Walk, sprint, sneak or swim for a bounded distance or duration.'],
  goto: ['Movement', 'Pathfind to a coordinate without digging or placing blocks.'],
  visit: ['Movement', 'Walk to a visible player or entity.'],
  follow: ['Movement', 'Follow a visible player or entity for a requested duration, or keep following until Stop.'],
  explore: ['Movement', 'Walk to a reachable frontier to reveal more terrain.'],
  set_home: ['Movement', 'Save the current position as home.'],
  collect: ['Blocks', 'Mine a selected natural resource with a suitable tool and collect its drops.'],
  dig: ['Blocks', 'Break the explicitly selected block.'],
  place_entity: ['Blocks', 'Place an inventory boat, minecart, armor stand, painting or item frame on a suitable surface.'],
  place_block: ['Blocks', 'Place an inventory block on an observed empty adjacent face.'],
  interact_block: ['Blocks', 'Right-click a door, button, lever, workstation or other block.'],
  harvest: ['Blocks', 'Harvest a mature crop.'],
  till: ['Blocks', 'Use a hoe on grass or dirt.'],
  plant: ['Blocks', 'Plant an available seed on suitable farmland or soul sand.'],
  craft: ['Crafting', 'Craft an available 26.2 recipe using inventory ingredients.'],
  place: ['Crafting', 'Set up a crafting table or furnace.'],
  smelt: ['Crafting', 'Smelt or cook a batch and collect the result.'],
  equip: ['Inventory', 'Equip an inventory item in hand, off-hand or an armor slot.'],
  unequip: ['Inventory', 'Remove equipped armor or a held item.'],
  hotbar: ['Inventory', 'Select a hotbar slot.'],
  drop: ['Inventory', 'Drop a specified number of an inventory item.'],
  move_slot: ['Inventory', 'Move an inventory stack to another slot.'],
  click_slot: ['Inventory', 'Left-click, right-click or shift-click a current inventory/window slot.'],
  open_container: ['Containers', 'Open a nearby chest, barrel, shulker box, hopper or other container.'],
  close_window: ['Containers', 'Close the current container or workstation.'],
  withdraw: ['Containers', 'Take an observed item from an open container.'],
  deposit: ['Containers', 'Put inventory items into an open container.'],
  furnace_take: ['Containers', 'Take output, remaining input or fuel from the open furnace.'],
  furnace_put: ['Containers', 'Put inventory items in the open furnace input or fuel slot.'],
  enchant_put: ['Workstations', 'Put an item or lapis into an open enchanting table.'],
  enchant: ['Workstations', 'Select an available enchantment with sufficient levels and lapis.'],
  enchant_take: ['Workstations', 'Take the enchanted item.'],
  anvil: ['Workstations', 'Combine, repair or rename inventory items at an open anvil.'],
  trade: ['Workstations', 'Perform a displayed villager trade with available payment items.'],
  eat: ['Survival', 'Eat an available food item.'],
  sleep: ['Survival', 'Enter a nearby bed when the server permits sleeping.'],
  wake: ['Survival', 'Get out of bed.'],
  respawn: ['Survival', 'Respawn after death.'],
  use_item: ['Items', 'Use an item in hand, including shields, bows, potions and buckets.'],
  release_item: ['Items', 'Release the held item after charging or blocking.'],
  fish: ['Items', 'Cast an equipped fishing rod and reel in a catch.'],
  swing: ['Items', 'Swing the selected arm.'],
  attack: ['Entities', 'Attack a target in melee reach.'],
  interact_entity: ['Entities', 'Interact with a reachable entity, including feeding, shearing or trading.'],
  mount: ['Vehicles', 'Mount a reachable boat, minecart or rideable animal.'],
  dismount: ['Vehicles', 'Leave the current vehicle.'],
  steer: ['Vehicles', 'Steer the mounted vehicle for a bounded duration.'],
  elytra: ['Movement', 'Start gliding while airborne with an equipped elytra.'],
  creative_fly: ['Creative', 'Fly or hover in server-authorized creative mode.'],
  creative_item: ['Creative', 'Set an inventory slot in server-authorized creative mode.'],
  chat: ['Communication', 'Send only the exact message explicitly supplied by the user.'],
  sign: ['Communication', 'Write the user-supplied text on a reachable sign.'],
  book: ['Communication', 'Write the user-supplied pages in an inventory writable book.'],
  wait: ['Observation', 'Wait briefly for the world or an interaction to update.']
}
const containers = /^(chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|.*shulker_box)$/
const cropSeeds = { wheat_seeds: 'farmland', carrot: 'farmland', potato: 'farmland', beetroot_seeds: 'farmland', melon_seeds: 'farmland', pumpkin_seeds: 'farmland', nether_wart: 'soul_sand' }
const fuelNames = /^(coal|charcoal|coal_block|blaze_rod|dried_kelp_block|lava_bucket|stick)$|_(planks|log|wood)$/
const faces = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]
const compact = value => JSON.parse(JSON.stringify(value))
const human = value => String(value).replaceAll('_', ' ')
function actionId(action) {
  const { id, label, category, preconditions, effect, progress, ...args } = action
  return `${action.kind}_${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`
}

class ActionSpace {
  constructor(bot, planner, state) {
    this.bot = bot
    this.planner = planner
    this.state = state
    this.last = null
    this.explored = new Map()
  }

  nearbyBlocks(radius = 4) {
    const bot = this.bot
    if (!bot.entity?.position) return []
    const origin = bot.entity.position.floored()
    const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
    const blocks = []
    for (let x = -radius; x <= radius; x++) for (let y = -radius; y <= radius; y++) for (let z = -radius; z <= radius; z++) {
      const block = bot.blockAt(origin.offset(x, y, z))
      if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) continue
      if (eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.5) continue
      if (bot.canSeeBlock && !bot.canSeeBlock(block)) continue
      blocks.push(block)
    }
    return blocks.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
  }

  option(kind, label, args = {}, preconditions = [], effect = label) {
    const action = { kind, ...compact(args), label, category: definitions[kind]?.[0] || 'Task', preconditions, effect }
    action.id = actionId(action)
    return action
  }

  enumerate(goal = null, plan = null) {
    const bot = this.bot
    const list = []
    const add = (kind, label, args, conditions, effect) => list.push(this.option(kind, label, args, conditions, effect))
    if (!bot.entity) return { actions: [], unavailable: this.unavailable([]), at: new Date().toISOString() }
    if (bot.health <= 0) {
      add('respawn', 'Respawn now', {}, ['Player is dead'])
      return { actions: list, unavailable: this.unavailable(list), at: new Date().toISOString() }
    }
    const requested = goal?.args || {}
    const wants = goal?.action
    const inventory = this.planner.items()
    const window = bot.currentWindow
    const blocks = this.nearbyBlocks()
    const entities = Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && e.isValid !== false && e.position.distanceTo(bot.entity.position) <= 32)
    const items = new Map(inventory.map(i => [i.name, i]))
    const inventoryCount = name => inventory.filter(i => i.name === name).reduce((s, i) => s + i.count, 0)

    for (const section of ['inventory', 'position', 'nearby', 'window', 'all']) add('inspect', `Inspect ${section}`, { section })
    add('wait', 'Wait for the world to update', { seconds: requested.seconds || 1 })
    if (window) add('close_window', `Close ${window.type}`, { windowId: window.id })
    if (bot.isSleeping) {
      add('wake', 'Wake up', {}, ['Player is sleeping'])
      return { actions: list, unavailable: this.unavailable(list), at: new Date().toISOString() }
    }
    if (!window) {
      add('look', 'Look around in four directions')
      add('rotate', 'Rotate one full turn', { direction: requested.direction || 'right' })
      for (const direction of ['left', 'right', 'up', 'down']) add('turn', `Turn ${direction} ${requested.degrees || 90} degrees`, { direction, degrees: requested.degrees || 90 })
      if (bot.entity.onGround !== false && !bot.vehicle) add('jump', 'Jump once and land', {}, ['On solid ground'])
      for (const direction of ['forward', 'back', 'left', 'right', 'north', 'south', 'east', 'west', 'up', 'down']) {
        if (['up', 'down'].includes(direction) && !bot.entity.isInWater && !bot.entity.isInLava) continue
        for (const style of ['walk', 'sprint', 'sneak', ...(bot.entity.isInWater ? ['swim'] : [])]) {
          if (style === 'sprint' && bot.food <= 6) continue
          add('move', `${style} ${direction}${requested.blocks ? ` ${requested.blocks} blocks` : ` for ${requested.seconds || 1} second(s)`}`, { direction, style, ...(requested.blocks ? { blocks: requested.blocks } : { seconds: requested.seconds || 1 }) })
        }
      }
      add('set_home', 'Remember this position as home')
      if (!goal || goal.action === 'explore' || goal.kind === 'freeform' || plan?.reasons?.some(r => r.includes('no accessible source'))) for (const position of this.frontiers()) add('explore', `Explore toward ${position.x}, ${position.y}, ${position.z}`, { position })
      if (this.state.home) add('goto', 'Return home', { position: this.state.home, home: true })
      if (requested.position) add('goto', 'Go to the requested coordinates', { position: requested.position })
      if (requested.position) add('look_at', 'Look at the requested coordinates', { position: requested.position })
      for (const entity of entities) {
        const name = entity.username || entity.name || `entity ${entity.id}`
        add('look_at', `Look at ${name}`, { entityId: entity.id, target: name })
        add('visit', `${requested.style === 'sprint' ? 'Sprint' : 'Go'} to ${name}`, { entityId: entity.id, target: name, style: requested.style || 'walk' })
        add('follow', requested.continuous ? `Keep following ${name} until Stop` : `Follow ${name} for ${requested.seconds || 15} seconds`, { entityId: entity.id, target: name, seconds: requested.seconds || 15, continuous: requested.continuous === true, style: requested.style || 'walk' })
        const distance = entity.position.distanceTo(bot.entity.position)
        if (distance <= 3.5 && entity.name !== 'item') {
          // Attacking players is only an option for an explicit attack command.
          if (!entity.username || (wants === 'attack' && requested.target?.toLowerCase() === entity.username.toLowerCase())) add('attack', `Attack ${name}`, { entityId: entity.id, target: name }, ['Target is in melee reach'])
          if (/villager|wandering_trader|chest.*minecart|chest.*boat|chest.*raft/.test(entity.name || '')) add('open_container', `Open ${name}`, { entityId: entity.id, target: name })
          add('interact_entity', `Interact with ${name}`, { entityId: entity.id, target: name })
          if (/boat|raft|minecart|horse|donkey|mule|pig|strider|camel|llama/.test(entity.name || '') && !bot.vehicle) add('mount', `Mount ${name}`, { entityId: entity.id, target: name })
        }
      }
      if (bot.vehicle) {
        add('dismount', 'Get out of the vehicle')
        for (const direction of ['forward', 'back', 'left', 'right']) add('steer', `Steer ${direction}`, { direction, seconds: requested.seconds || 1 })
      }
      if (bot.inventory.slots[6]?.name === 'elytra' && bot.entity.onGround === false) add('elytra', 'Start gliding', {}, ['Elytra equipped', 'Airborne'])
      for (const hand of ['right', 'left']) add('swing', `Swing ${hand} arm`, { hand })
      if (bot.heldItem) {
        add('use_item', `Use ${human(bot.heldItem.name)}`, { item: bot.heldItem.name, seconds: requested.seconds || 1 })
        add('release_item', 'Release the held item')
        if (bot.heldItem.name === 'fishing_rod' && blocks.some(b => b.name === 'water')) add('fish', 'Catch a fish', {}, ['Fishing rod equipped', 'Water in reach'])
      }
      if (bot.inventory.slots[45]) add('use_item', `Use off-hand ${human(bot.inventory.slots[45].name)}`, { item: bot.inventory.slots[45].name, offhand: true, seconds: requested.seconds || 1 })
      const food = this.planner.safeFood()
      if (food && bot.food < 20) add('eat', `Eat ${human(food.name)}`, { item: food.name })
      const placements = new Map()
      for (const block of blocks) {
        const position = point(block.position)
        add('look_at', `Look at ${human(block.name)} at ${block.position}`, { position, block: block.name })
        add('interact_block', `Use ${human(block.name)} at ${block.position}`, { position, block: block.name, ...(/door$|gate$/.test(block.name) && requested.open !== undefined ? { open: requested.open } : {}) })
        if (containers.test(block.name) || /furnace|smoker|enchanting_table|anvil/.test(block.name)) add('open_container', `Open ${human(block.name)} at ${block.position}`, { position, block: block.name })
        if (block.name.endsWith('_bed')) add('sleep', `Sleep in ${human(block.name)}`, { position })
        if (block.diggable && (!bot.canDigBlock || bot.canDigBlock(block))) {
          add('dig', `Break ${human(block.name)} at ${block.position}`, { position, block: block.name }, ['Block is visible and in reach'])
          const age = block.getProperties?.().age
          const maxAge = ({ wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3, sweet_berry_bush: 3 })[block.name]
          if (maxAge !== undefined && +age >= maxAge) add('harvest', `Harvest ripe ${human(block.name)}`, { position, block: block.name })
        }
        if (['dirt', 'grass_block', 'dirt_path'].includes(block.name) && inventory.some(i => i.name.endsWith('_hoe')) && bot.blockAt(block.position.offset(0, 1, 0))?.boundingBox === 'empty') add('till', `Till ${human(block.name)} at ${block.position}`, { position, block: block.name, item: inventory.find(i => i.name.endsWith('_hoe')).name })
        for (const [seed, soil] of Object.entries(cropSeeds)) if (items.has(seed) && block.name === soil && bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air') add('plant', `Plant ${human(seed)} at ${block.position}`, { item: seed, position, block: block.name })
        if (block.boundingBox !== 'block') continue
        for (const face of faces) {
          const destination = block.position.plus(face)
          if (!['air', 'cave_air'].includes(bot.blockAt(destination)?.name)) continue
          if (Object.values(bot.entities || {}).some(e => e.position && e.position.distanceTo(destination.offset(0.5, 0, 0.5)) < 1)) continue
          if (bot.entity.position.distanceTo(destination.offset(0.5, 0, 0.5)) < 1.1) continue
          if (!placements.has(destination.toString())) placements.set(destination.toString(), { position, face: point(face), destination: point(destination), block: block.name })
        }
        if (wants === 'sign' && requested.text && /sign$/.test(block.name)) add('sign', `Write the requested text on ${human(block.name)}`, { position, block: block.name, text: requested.text })
      }
      for (const item of items.values()) {
        if (/boat|raft|minecart|armor_stand|item_frame|painting/.test(item.name)) {
          for (const b of blocks) {
            if (/minecart/.test(item.name) ? !/rail$/.test(b.name) : /boat|raft/.test(item.name) ? b.name !== 'water' : b.boundingBox !== 'block') continue
            const face = /item_frame|painting/.test(item.name) ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0)
            if (!/boat|raft|minecart/.test(item.name) && bot.blockAt(b.position.plus(face))?.name !== 'air') continue
            add('place_entity', `Place ${human(item.name)} by ${b.position}`, { item: item.name, position: point(b.position), block: b.name, face: point(face) })
          }
        }
        if (bot.registry.blocksByName[item.name]) for (const destination of placements.values()) add('place_block', `Place ${human(item.name)} at ${JSON.stringify(destination.destination)}`, { item: item.name, ...destination })
      }
      const table = this.planner.station('crafting_table')
      // Iterate recipe outputs, not every possible combination of empty slots.
      for (const type of Object.keys(bot.registry.recipes || {})) {
        const name = bot.registry.items[type]?.name
        if (!name) continue
        const recipes = this.planner.Recipe.find(+type, null)
        recipes.forEach((recipe, index) => {
          if (recipe.requiresTable && !table) return
          if (!recipe.delta.filter(d => d.count < 0).every(d => inventoryCount(bot.registry.items[d.id].name) >= -d.count)) return
          add('craft', `Craft ${recipe.result.count} ${human(name)}`, { item: name, recipeIndex: index, times: 1, count: recipe.result.count, position: recipe.requiresTable ? point(table.position) : null })
        })
      }
    }
    for (const item of items.values()) {
      if (window) continue
      for (const destination of new Set(['hand', 'off-hand', armorDestination(item.name)])) add('equip', `Equip ${human(item.name)} in ${destination}`, { item: item.name, destination })
      const counts = new Set([1, item.count, ...(requested.count && requested.count <= inventoryCount(item.name) ? [requested.count] : [])])
      for (const count of counts) add('drop', `Drop ${count} ${human(item.name)}`, { item: item.name, count })
      for (let slot = 9; slot < Math.min(bot.inventory.slots.length, 45); slot++) {
        if (Number.isInteger(item.slot) && slot !== item.slot) add('move_slot', `Move ${human(item.name)} from slot ${item.slot} to ${slot}`, { from: item.slot, to: slot, item: item.name })
      }
      if (wants === 'book' && requested.text && item.name === 'writable_book') add('book', 'Write the requested pages', { slot: item.slot, pages: requested.text.split('|') })
    }
    for (const destination of window ? [] : ['head', 'torso', 'legs', 'feet', 'off-hand', 'hand']) {
      const slot = ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 })[destination]
      if (slot ? bot.inventory.slots[slot] : bot.heldItem) add('unequip', `Unequip ${destination}`, { destination })
    }
    for (let slot = 0; slot <= 8; slot++) add('hotbar', `Select hotbar slot ${slot + 1}`, { slot })
    const activeWindow = window || bot.inventory
    for (let slot = 0; slot < activeWindow.slots.length; slot++) {
      if (!activeWindow.slots[slot] && !activeWindow.selectedItem) continue
      for (const [button, mode] of [[0, 0], [1, 0], [0, 1]]) add('click_slot', `${mode ? 'Shift-click' : button ? 'Right-click' : 'Left-click'} slot ${slot}`, { slot, button, mode, windowId: activeWindow.id })
    }
    if (window) {
      const stored = window.slots.slice(0, window.inventoryStart).filter(Boolean)
      if (window.withdraw) for (const item of stored) {
        for (const count of new Set([1, item.count, ...(requested.count && requested.count <= item.count ? [requested.count] : [])])) add('withdraw', `Take ${count} ${human(item.name)} from ${window.type}`, { item: item.name, count, windowId: window.id })
      }
      if (window.deposit) for (const item of items.values()) {
        for (const count of new Set([1, item.count, ...(requested.count && requested.count <= item.count ? [requested.count] : [])])) add('deposit', `Store ${count} ${human(item.name)} in ${window.type}`, { item: item.name, count, windowId: window.id })
      }
      if (window.inputItem) {
        for (const part of ['input', 'fuel', 'output']) if (window[`${part}Item`]()) add('furnace_take', `Take furnace ${part}`, { part, windowId: window.id })
        for (const item of items.values()) for (const part of ['input', ...(fuelNames.test(item.name) ? ['fuel'] : [])]) add('furnace_put', `Put ${human(item.name)} in furnace ${part}`, { item: item.name, part, count: Math.min(requested.count || 1, item.count), windowId: window.id })
      }
      if (window.enchant) {
        for (const item of inventory.filter(i => i.name === 'lapis_lazuli' || i.name === 'book' || ((bot.registry.itemsByName[i.name]?.enchantCategories || []).length && !i.enchants?.length))) add('enchant_put', `Put ${human(item.name)} in enchanting table`, { item: item.name, part: item.name === 'lapis_lazuli' ? 'lapis' : 'target', windowId: window.id })
        for (const [choice, enchantment] of (window.enchantments || []).entries()) {
          if (enchantment.level > 0 && (bot.experience?.level || 0) >= enchantment.level && window.slots[1]?.count >= choice + 1) add('enchant', `Apply enchantment option ${choice + 1}, level ${enchantment.level}`, { choice, windowId: window.id })
        }
        if (window.targetItem()) add('enchant_take', 'Take enchanted item', { windowId: window.id })
      }
      if (window.combine) {
        for (const a of inventory) for (const b of inventory) {
          if (a.slot === b.slot) continue
          const Item = require('prismarine-item')(bot.registry)
          let cost
          try { cost = Item.anvil(a, b, bot.game.gameMode === 'creative').xpCost } catch { continue }
          if (cost > 0 && (bot.game.gameMode === 'creative' || (cost < 40 && (bot.experience?.level || 0) >= cost))) add('anvil', `Combine ${human(a.name)} with ${human(b.name)}`, { first: a.name, second: b.name, firstSlot: a.slot, secondSlot: b.slot, windowId: window.id })
        }
        if (requested.text && requested.text.length <= 35) for (const item of inventory) {
          const Item = require('prismarine-item')(bot.registry)
          let cost
          try { cost = Item.anvil(item, null, bot.game.gameMode === 'creative', requested.text).xpCost } catch { continue }
          if (cost > 0 && (bot.game.gameMode === 'creative' || (bot.experience?.level || 0) >= cost)) add('anvil', `Rename ${human(item.name)} to the requested name`, { first: item.name, firstSlot: item.slot, text: requested.text, windowId: window.id })
        }
      }
      for (const [index, trade] of (window.trades || []).entries()) {
        if (trade.tradeDisabled || (trade.nbTradeUses >= trade.maximumNbTradeUses)) continue
        if (inventoryCount(trade.inputItem1.name) < trade.inputItem1.count) continue
        if (trade.hasItem2 && inventoryCount(trade.inputItem2.name) < trade.inputItem2.count) continue
        add('trade', `Trade for ${trade.outputItem.count} ${human(trade.outputItem.name)}`, { tradeIndex: index, count: 1, item: trade.outputItem.name, windowId: window.id })
      }
    }
    if (bot.game?.gameMode === 'creative') {
      for (const flying of [true, false]) add('creative_fly', flying ? 'Start creative flight' : 'Stop creative flight', { flying })
      if (requested.position) add('creative_fly', 'Fly to the requested position', { flying: true, position: requested.position })
      if (wants === 'creative_item' && requested.item && bot.registry.itemsByName[requested.item]) add('creative_item', `Create ${human(requested.item)}`, { item: requested.item, count: Math.min(requested.count || 1, bot.registry.itemsByName[requested.item].stackSize), slot: requested.slot ?? 36 })
    }
    if (wants === 'chat' && requested.text) add('chat', 'Send the exact user-supplied message', { text: requested.text }, ['Message text was explicitly supplied by the user'])
    for (const action of plan?.candidates || []) {
      const option = this.option(action.kind, action.label, action, [], action.label)
      option.progress = true
      list.push(option)
    }
    const byId = new Map(list.map(a => [a.id, a]))
    const result = { at: new Date().toISOString(), actions: [...byId.values()], unavailable: this.unavailable(list) }
    this.last = result
    return result
  }

  frontiers() {
    const bot = this.bot
    const key = `${bot.entity?.position.floored()}:${this.explored.size}`
    if (this.frontierCache?.key === key && Date.now() - this.frontierCache.at < 10000) return this.frontierCache.positions
    if (!bot.pathfinder?.getPathTo || !bot.entity || bot.currentWindow) return []
    const { Movements, goals } = require('mineflayer-pathfinder')
    const { allowWoodenDoors, naturalPaths, vegetation } = require('./navigation')
    const moves = naturalPaths(allowWoodenDoors(new Movements(bot)), this.state, null, bot.game?.dimension)
    moves.allow1by1towers = false
    moves.allowParkour = false
    moves.canOpenDoors = true
    moves.maxDropDown = 2
    moves.scafoldingBlocks = []
    const origin = bot.entity.position.floored()
    const positions = []
    for (const radius of [4, 8, 12]) for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.75, 0.75], [-0.75, 0.75], [0.75, -0.75], [-0.75, -0.75]]) {
      const dx = Math.round(radius * ux), dz = Math.round(radius * uz)
      for (let dy = 6; dy >= -12; dy--) {
        const p = origin.offset(dx, dy, dz)
        if (this.state.home && !this.state.autonomous && Math.hypot(p.x - this.state.home.x, p.z - this.state.home.z) > this.state.travelRadius) continue
        if ([...this.explored.values()].some(old => Math.hypot(p.x - old.x, p.z - old.z) < 5)) continue
        const clear = b => b?.boundingBox === 'empty' || (this.state.autonomous && vegetation(b))
        if (!clear(bot.blockAt(p)) || !clear(bot.blockAt(p.offset(0, 1, 0))) || bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') continue
        const result = bot.pathfinder.getPathTo(moves, new goals.GoalNear(p.x, p.y, p.z, 2), 35)
        if (result.status === 'success') { positions.push(point(p)); break }
      }
    }
    this.frontierCache = { key, at: Date.now(), positions }
    return positions
  }

  prepare(goal, available) {
    let candidates = this.forGoal(goal, available)
    if (candidates.length) return candidates
    const bot = this.bot, args = goal.args || {}, action = goal.action
    const prep = options => options.map(a => ({ ...a, preparation: true }))
    const windowActions = ['withdraw', 'deposit', 'furnace_take', 'furnace_put', 'enchant', 'enchant_put', 'enchant_take', 'anvil', 'trade', 'close_window', 'click_slot']
    if (bot.currentWindow && !windowActions.includes(action)) return prep(available.filter(a => a.kind === 'close_window'))
    if (windowActions.includes(action) && !bot.currentWindow) {
      const target = args.container || (action.startsWith('enchant') ? 'enchanting_table' : action.startsWith('furnace') ? 'furnace' : action === 'anvil' ? 'anvil' : action === 'trade' ? 'villager' : null)
      candidates = available.filter(a => a.kind === 'open_container' && (!target || [a.block, a.target].some(n => n?.includes(target))))
      if (candidates.length) return prep(candidates)
      return prep(this.approach({ target: target || 'chest' }, available))
    }
    if (['use_item', 'fish'].includes(action)) {
      const item = action === 'fish' ? 'fishing_rod' : args.item
      if (bot.heldItem?.name !== item) return prep(available.filter(a => a.kind === 'equip' && a.item === item && a.destination === 'hand'))
    }
    if (['attack', 'mount', 'interact_entity', 'look_at', 'open_container', 'dig', 'interact_block', 'harvest', 'till', 'plant', 'sign'].includes(action)) return prep(this.approach(args, available))
    return []
  }

  approach(args, available) {
    const target = args.target
    if (!target) return []
    const match = name => name && human(name).toLowerCase().includes(human(target).toLowerCase())
    const entity = available.filter(a => a.kind === 'visit' && match(a.target))
    if (entity.length) return entity
    const names = Object.keys(this.bot.registry.blocksByName).filter(match)
    const blocks = this.planner.nearby(names).slice(0, 5)
    return blocks.filter(b => b.position.distanceTo(this.bot.entity.position) > 3).map(b => this.option('goto', `Approach ${human(b.name)} at ${b.position}`, { position: point(b.position), range: 3 }))
  }

  unavailable(actions) {
    const offered = new Set(actions.map(a => a.kind))
    return Object.entries(definitions).filter(([kind]) => !offered.has(kind)).map(([kind, [category, description]]) => ({ kind, category, description, reason: 'Required item, target, open window, game mode or player state is absent.' }))
  }

  forGoal(goal, available) {
    const target = goal.args || {}
    return available.filter(a => {
      if (a.kind !== goal.action) return false
      if (a.kind === 'goto' && !target.position && !target.home) return false
      for (const key of ['item', 'destination', 'direction', 'style', 'section', 'part', 'slot', 'from', 'to', 'button', 'mode', 'choice', 'tradeIndex', 'first', 'second', 'flying', 'offhand']) {
        if (target[key] !== undefined && a[key] !== target[key]) return false
      }
      if (target.count !== undefined && a.count !== undefined && a.count !== target.count) return false
      if (target.target && ![a.target, a.block].some(n => n && (n.toLowerCase() === target.target.toLowerCase() || human(n).toLowerCase().includes(human(target.target).toLowerCase())))) return false
      if (target.position && a.position && JSON.stringify(point(a.position)) !== JSON.stringify(point(target.position))) return false
      if (target.entityId !== undefined && a.entityId !== target.entityId) return false
      if (target.home && !a.home) return false
      return true
    })
  }
}

module.exports = { ActionSpace, definitions, actionId, cropSeeds }
