const { Vec3 } = require('vec3')
const { protectedAt } = require('./server-protection')

const sources = {
  cobblestone: ['stone'], cobbled_deepslate: ['deepslate'], coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  dirt: ['dirt', 'grass_block'], sand: ['sand'], gravel: ['gravel']
}
const smelting = {
  iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', charcoal: 'logs',
  cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken',
  cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon',
  baked_potato: 'potato', glass: 'sand', stone: 'cobblestone'
}
const armorSlots = { head: 5, torso: 6, legs: 7, feet: 8 }
const armorDestination = name => /helmet$/.test(name) ? 'head' : /chestplate$/.test(name) ? 'torso' : /leggings$/.test(name) ? 'legs' : /boots$/.test(name) ? 'feet' : 'hand'
const isLog = name => /_log$/.test(name)
const matches = (name, wanted) => wanted === 'logs' ? isLog(name) : wanted === 'planks' ? /_planks$/.test(name) : name === wanted
const vector = p => new Vec3(p.x, p.y, p.z)
const point = p => ({ x: p.x, y: p.y, z: p.z })
const human = name => name.replaceAll('_', ' ')

class Planner {
  constructor(bot, settings) {
    this.bot = bot
    this.settings = settings
    this.Recipe = require('prismarine-recipe')(bot.registry).Recipe
    this.blockedPositions = new Set()
  }

  items() {
    const window = this.bot.currentWindow
    return window ? window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean) : this.bot.inventory.items()
  }

  inventory() {
    const result = {}
    for (const item of this.items()) result[item.name] = (result[item.name] || 0) + item.count
    return result
  }

  count(item) {
    return Object.entries(this.inventory()).reduce((sum, [name, count]) => sum + (matches(name, item) ? count : 0), 0)
  }

  equipped(item) {
    const dest = armorDestination(item)
    return dest === 'hand' ? this.bot.heldItem?.name === item : this.bot.inventory.slots[armorSlots[dest]]?.name === item
  }

  nearby(names, collect = false) {
    const bot = this.bot
    if (!bot.entity || !bot.world) return []
    const ids = names.map(name => bot.registry.blocksByName[name]?.id).filter(id => id !== undefined)
    if (!ids.length) return []
    return bot.findBlocks({ matching: ids, maxDistance: 32, count: 96 })
      .map(p => bot.blockAt(p)).filter(Boolean)
      .filter(block => !collect || this.collectable(block))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  }

  collectable(block) {
    const { home, protectRadius, travelRadius } = this.settings()
    const p = block.position
    if (this.blockedPositions.has(p.toString()) || !block.diggable) return false
    if (protectedAt(p, this.settings(), this.bot.game?.dimension)) return false
    if (home) {
      const distance = Math.hypot(p.x - home.x, p.z - home.z)
      if (distance < protectRadius || (!this.settings().autonomous && distance > travelRadius)) return false
    }
    if (p.equals(this.bot.entity.position.floored().offset(0, -1, 0))) return false
    // Only surface-accessible resources. A goal never starts a blind tunnel.
    if (![new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
      .some(offset => this.bot.blockAt(p.plus(offset))?.boundingBox === 'empty')) return false
    if (isLog(block.name)) {
      let leaves = false
      for (let x = -3; x <= 3 && !leaves; x++) for (let z = -3; z <= 3 && !leaves; z++) {
        for (let y = 0; y <= 5 && !leaves; y++) leaves = /_leaves$/.test(this.bot.blockAt(p.offset(x, y, z))?.name || '')
      }
      if (!leaves) return false
    }
    return true
  }

  station(name) { return this.nearby([name])[0] }

  localBlocks() {
    if (!this.bot.entity || !this.bot.blockAt) return []
    const origin = this.bot.entity.position.floored()
    const blocks = []
    for (let x = -3; x <= 3; x++) for (let y = -2; y <= 3; y++) for (let z = -3; z <= 3; z++) {
      const b = this.bot.blockAt(origin.offset(x, y, z))
      if (b && !['air', 'cave_air', 'void_air'].includes(b.name) && (!this.bot.canSeeBlock || this.bot.canSeeBlock(b))) blocks.push({ name: b.name, position: point(b.position), properties: b.getProperties?.() })
    }
    const useful = b => /ore$|door$|gate$|button$|lever|chest$|barrel|furnace|crafting_table|bed$|water|lava|wheat|carrot|potato|farmland|_log$/.test(b.name)
    return blocks.sort((a, b) => +useful(b) - +useful(a) || vector(a.position).distanceTo(origin) - vector(b.position).distanceTo(origin)).slice(0, 96)
  }

  observe() {
    const bot = this.bot
    return {
      health: bot.health, food: bot.food, position: bot.entity ? point(bot.entity.position) : null,
      inventory: this.inventory(), armor: Object.fromEntries(Object.entries(armorSlots).map(([name, slot]) => [name, bot.inventory.slots[slot]?.name || null])),
      heldItem: bot.heldItem?.name || null, dimension: bot.game?.dimension,
      gameMode: bot.game?.gameMode, onGround: bot.entity?.onGround, inWater: bot.entity?.isInWater,
      yaw: bot.entity?.yaw, pitch: bot.entity?.pitch, sleeping: bot.isSleeping || false,
      vehicle: bot.vehicle ? { id: bot.vehicle.id, name: bot.vehicle.name } : null,
      experience: bot.experience, hotbarSlot: bot.quickBarSlot,
      slots: bot.inventory.slots.flatMap((i, slot) => i ? [{ slot, item: i.name, count: i.count }] : []),
      window: bot.currentWindow ? {
        id: bot.currentWindow.id, type: bot.currentWindow.type,
        slots: bot.currentWindow.slots.flatMap((i, slot) => i ? [{ slot, item: i.name, count: i.count }] : []),
        inventoryStart: bot.currentWindow.inventoryStart,
        enchantments: bot.currentWindow.enchantments,
        trades: bot.currentWindow.trades?.map((t, index) => ({ index, input: t.inputItem1?.name, count: t.inputItem1?.count, output: t.outputItem?.name, disabled: t.tradeDisabled }))
      } : null,
      players: Object.values(bot.players || {}).filter(p => p.entity && p.username !== bot.username).map(p => ({ name: p.username, position: point(p.entity.position) })),
      entities: Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 32)
        .slice(0, 32).map(e => ({ id: e.id, name: e.username || e.name || e.type, position: point(e.position), distance: Math.round(e.position.distanceTo(bot.entity.position)) })),
      nearbyBlocks: this.localBlocks(),
      home: this.settings().home
    }
  }

  complete(goal) {
    switch (goal.kind) {
      case 'acquire': return this.count(goal.item) >= goal.count
      case 'armor': return goal.items.every(item => this.equipped(item))
      case 'equip': return this.equipped(goal.item)
      case 'station': return !!this.station(goal.item)
      case 'eat': return this.bot.food >= 18
      case 'home': return !!this.settings().home && this.bot.entity.position.distanceTo(vector(this.settings().home)) <= 2
      case 'goto': return this.bot.entity.position.distanceTo(vector(goal.position)) <= 2
      case 'visit': return !!this.bot.players[goal.player]?.entity && this.bot.entity.position.distanceTo(this.bot.players[goal.player].entity.position) <= 3
      default: return false
    }
  }

  plan(goal) {
    this.reasons = []
    this.woodCache = {}
    this.requirements = []
    let candidates = []
    if (this.complete(goal)) return { complete: true, candidates, reasons: [] }
    if (goal.kind === 'armor') {
      for (const item of goal.items) if (!this.equipped(item)) {
        candidates = this.count(item) ? [{ kind: 'equip', item, label: `Wear ${human(item)}` }] : this.ensure(item, 1)
        break
      }
    } else if (goal.kind === 'acquire') candidates = this.ensure(goal.item, goal.count)
    else if (goal.kind === 'equip') candidates = this.count(goal.item) ? [{ kind: 'equip', item: goal.item, label: `Equip ${human(goal.item)}` }] : this.ensure(goal.item, 1)
    else if (goal.kind === 'station') candidates = this.ensureStation(goal.item)
    else if (goal.kind === 'home') {
      if (this.settings().home) candidates = [{ kind: 'goto', position: this.settings().home, label: 'Walk back home' }]
      else this.reasons.push('No home position has been saved yet.')
    } else if (goal.kind === 'goto') candidates = [{ kind: 'goto', position: goal.position, label: 'Walk to the requested coordinates' }]
    else if (goal.kind === 'visit') {
      const player = this.bot.players[goal.player]?.entity
      if (player) candidates = [{ kind: 'visit', player: goal.player, label: `Go to ${goal.player}` }]
      else this.reasons.push(`${goal.player} is outside the loaded area or offline.`)
    } else if (goal.kind === 'sleep') {
      const bed = this.nearby(Object.keys(this.bot.registry.blocksByName).filter(n => n.endsWith('_bed')))[0]
      if (bed) candidates = [{ kind: 'sleep', position: point(bed.position), label: 'Sleep in the nearby bed' }]
      else this.reasons.push('No bed within 32 blocks.')
    } else if (goal.kind === 'look') candidates = [{ kind: 'look', label: 'Look around in four directions' }]
    else if (goal.kind === 'eat') {
      const food = this.safeFood()
      if (food) candidates = [{ kind: 'eat', item: food.name, label: `Eat ${human(food.name)}` }]
      else this.reasons.push('No safe food in the inventory. Add food or ask me to cook first.')
    }
    // Food can be chosen as a prerequisite during another goal.
    if (this.bot.food < 14 && this.safeFood() && goal.kind !== 'eat') candidates.unshift({ kind: 'eat', item: this.safeFood().name, label: 'Eat to restore hunger before continuing' })
    const unique = new Map(candidates.map(a => [JSON.stringify(a), a]))
    return { complete: false, candidates: [...unique.values()].slice(0, 12), reasons: [...new Set(this.reasons)].slice(0, 5), requirements: this.requirements }
  }

  safeFood() {
    const unsafe = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew', 'chorus_fruit', 'golden_apple', 'enchanted_golden_apple'])
    return this.bot.inventory.items().filter(i => this.bot.registry.foodsByName[i.name] && !unsafe.has(i.name))
      .sort((a, b) => this.bot.registry.foodsByName[b.name].foodPoints - this.bot.registry.foodsByName[a.name].foodPoints)[0]
  }

  wood(suffix) {
    if (this.woodCache?.[suffix]) return this.woodCache[suffix]
    const names = Object.keys(this.bot.registry.itemsByName).filter(n => n.endsWith(suffix))
    const owned = names.filter(n => this.count(n)).sort((a, b) => this.count(b) - this.count(a))
    if (owned.length) return owned[0]
    const log = this.nearby(Object.keys(this.bot.registry.blocksByName).filter(isLog), true)[0]?.name || 'oak_log'
    const result = suffix === '_log' ? log : log.replace(/_log$/, '_planks')
    if (this.woodCache) this.woodCache[suffix] = result
    return result
  }

  ensureStation(item, visited = new Set()) {
    if (this.station(item)) return []
    if (this.count(item)) return [{ kind: 'place', item, label: `Place a ${human(item)} on a clear floor` }]
    return this.ensure(item, 1, visited)
  }

  ensure(wanted, target, visited = new Set()) {
    if (this.count(wanted) >= target) return []
    const item = wanted === 'logs' ? this.wood('_log') : wanted === 'planks' ? this.wood('_planks') : wanted
    if (visited.has(item) || visited.size > 12) return []
    visited = new Set([...visited, item])
    const missing = target - this.count(wanted)
    this.requirements?.push({ item: wanted, needed: target, owned: this.count(wanted), dependencyPath: [...visited] })
    const direct = sources[item] || (isLog(item) ? [item] : null)
    if (direct) {
      const blocks = this.nearby(direct, true).slice(0, 4)
      if (!blocks.length) {
        this.reasons.push(`Need ${missing} ${human(wanted)}: no accessible source within 32 blocks outside the home buffer. Move closer to resources, then resume.`)
        return []
      }
      const block = blocks[0]
      const tools = this.bot.inventory.items().filter(i => block.canHarvest(i.type))
      if (!block.canHarvest(null) && !tools.length) {
        const pickaxe = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'].find(n => block.canHarvest(this.bot.registry.itemsByName[n].id))
        return pickaxe ? this.ensure(pickaxe, 1, visited) : []
      }
      return blocks.map(b => ({ kind: 'collect', item: wanted, block: b.name, position: point(b.position), label: `Collect ${human(wanted)} from ${human(b.name)} at ${b.position}` }))
    }
    if (smelting[item]) {
      const station = this.station('furnace')
      if (!station) return this.ensureStation('furnace', visited)
      const input = smelting[item]
      const amount = Math.min(8, missing)
      if (this.count(input) < amount) return this.ensure(input, amount, visited)
      const fuels = this.bot.inventory.items().filter(i => ['coal', 'charcoal'].includes(i.name) || /_planks$/.test(i.name))
      const fuel = fuels.find(i => ['coal', 'charcoal'].includes(i.name) && i.count >= Math.ceil(amount / 8)) || fuels.find(i => i.count >= Math.ceil(amount / 1.5))
      if (!fuel) return this.ensure('planks', Math.ceil(amount / 1.5), visited)
      const actualInput = input === 'logs' ? this.wood('_log') : input
      return [{ kind: 'smelt', item, input: actualInput, count: Math.min(amount, this.count(actualInput)), fuel: fuel.name, fuelCount: Math.ceil(amount / (fuel.name.endsWith('_planks') ? 1.5 : 8)), position: point(station.position), label: `Smelt ${amount} ${human(item)}` }]
    }
    const type = this.bot.registry.itemsByName[item]?.id
    const recipes = type === undefined ? [] : this.Recipe.find(type, null)
    const ranked = recipes.map((recipe, index) => {
      const inputs = recipe.delta.filter(d => d.count < 0).map(d => ({ item: this.bot.registry.items[d.id]?.name, count: -d.count }))
      let score = 0
      for (const input of inputs) {
        score += Math.max(0, input.count - this.count(input.item)) * 10
        if (visited.has(input.item)) score += 10000
        if (input.item?.endsWith('_planks') && input.item !== this.wood('_planks')) score += 100
        if (/(?:_block|_nugget)$/.test(input.item)) score += 500
        if (this.count(input.item) < input.count) {
          const source = sources[input.item] || (isLog(input.item) ? [input.item] : null)
          if (source && !this.nearby(source, true).length) score += 1000
          if (!source && !smelting[input.item] && !this.Recipe.find(this.bot.registry.itemsByName[input.item]?.id, null).length) score += 2000
        }
      }
      return { recipe, index, inputs, score }
    }).sort((a, b) => a.score - b.score)
    const best = ranked[0]
    if (!best || best.score >= 10000) {
      this.reasons.push(`No supported way to obtain ${human(item)} here. Supply it in Jev's inventory, or choose another goal.`)
      return []
    }
    const times = Math.min(8, Math.ceil(missing / best.recipe.result.count))
    const missingInputs = best.inputs.filter(i => this.count(i.item) < i.count * times)
    if (missingInputs.length) return missingInputs.flatMap(i => this.ensure(i.item, i.count * times, visited))
    const table = this.station('crafting_table')
    if (best.recipe.requiresTable && !table) return this.ensureStation('crafting_table', visited)
    return [{ kind: 'craft', item, recipeIndex: best.index, times, count: best.recipe.result.count * times, position: best.recipe.requiresTable ? point(table.position) : null, label: `Craft ${best.recipe.result.count * times} ${human(item)}` }]
  }
}

module.exports = { Planner, armorDestination, armorSlots, vector, point, matches, smelting }
