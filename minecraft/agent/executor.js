const { setTimeout: delay } = require('node:timers/promises')
const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { armorDestination, armorSlots, vector, point } = require('./planner')
const { handlers } = require('./primitive-executor')
const { allowWoodenDoors, openNearbyDoors, naturalPaths } = require('./navigation')

class Executor {
  constructor(bot, planner, state, save) {
    this.bot = bot
    this.planner = planner
    this.state = state
    this.save = save
    this.busy = false
  }

  movements(target = null, style = 'walk') {
    const moves = new Movements(this.bot)
    moves.canDig = !!target
    moves.canOpenDoors = true
    moves.allow1by1towers = false
    moves.allowParkour = false
    moves.allowSprinting = style === 'sprint' && this.bot.food > 6
    moves.maxDropDown = 2
    moves.scafoldingBlocks = []
    return naturalPaths(allowWoodenDoors(moves), this.state, target, this.bot.game?.dimension)
  }

  cancel() {
    const bot = this.bot
    bot.pathfinder?.setGoal(null)
    bot.stopDigging()
    bot.clearControlStates()
    bot.deactivateItem()
    if (this.activeKind === 'fish') bot.activateItem()
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    if (bot.isSleeping) bot.wake().catch(() => {})
    // cancelTask may wait for a physics tick; do not hold up the Stop API.
    bot.collectBlock?.cancelTask().catch(() => {})
  }

  check(signal) {
    signal.throwIfAborted()
    if (!this.bot.entity || this.bot.health <= 0) throw new Error('Jev is not alive and connected.')
  }

  async travel(position, range, signal, style = 'walk') {
    this.check(signal)
    const p = vector(position)
    const home = this.state.home
    if (home && !this.state.autonomous && Math.hypot(p.x - home.x, p.z - home.z) > this.state.travelRadius) {
      throw new Error(`Destination is beyond the ${this.state.travelRadius}-block travel radius from home.`)
    }
    await openNearbyDoors(this.bot, signal)
    this.bot.pathfinder.setMovements(this.movements(null, style))
    await this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, range))
    this.check(signal)
  }

  async run(action, signal) {
    if (this.busy) throw new Error('The previous action is still stopping.')
    this.busy = true
    this.activeKind = action.kind
    const bot = this.bot
    const onAbort = () => this.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    const navigation = ['goto', 'visit', 'follow', 'explore', 'collect', 'craft', 'smelt', 'sleep'].includes(action.kind)
    const doorController = new AbortController()
    const doorSignal = AbortSignal.any([signal, doorController.signal])
    let opening = false
    const doors = navigation ? setInterval(async () => {
      if (opening || doorSignal.aborted || !bot.pathfinder?.isMoving?.()) return
      opening = true
      try { await openNearbyDoors(bot, doorSignal) } catch {} finally { opening = false }
    }, 500) : null
    // Continuous following is a cancellable loop with no blocking plugin await.
    // It must remain active until Stop, rather than disconnect after 125 seconds.
    const watchdog = action.kind === 'follow' ? null : setTimeout(() => {
      this.cancel()
      // Disconnecting is the final backstop if a plugin cannot settle an action.
      bot.quit('Jev action timed out')
    }, 125000)
    try {
      signal.throwIfAborted()
      if (action.kind !== 'respawn') this.check(signal)
      if (handlers[action.kind]) {
        const result = await handlers[action.kind](this, action, signal)
        signal.throwIfAborted()
        return result || `${action.label}: done`
      }
      if (action.kind === 'goto') await this.travel(action.position, action.range || 1.5, signal)
      else if (action.kind === 'visit') {
        const player = action.entityId !== undefined ? bot.entities[action.entityId] : bot.players[action.player]?.entity
        if (!player) throw new Error('That player is no longer visible.')
        await this.travel(player.position, 2.5, signal, action.style)
      } else if (action.kind === 'look') {
        const yaw = bot.entity.yaw
        const pitch = bot.entity.pitch
        for (let step = 1; step <= 4; step++) {
          this.check(signal)
          await bot.look(yaw + step * Math.PI / 2, 0)
          await delay(300, null, { signal })
        }
        await bot.look(yaw, pitch)
      } else if (action.kind === 'collect') {
        const block = bot.blockAt(vector(action.position))
        if (block?.name !== action.block || !this.planner.collectable(block)) throw new Error('The target block changed or is protected.')
        const before = this.planner.count(action.item)
        const movement = this.movements(block.position)
        if (!movement.safeToBreak(block)) throw new Error('This block cannot be mined safely: liquid, falling blocks or an entity are nearby.')
        bot.pathfinder.setMovements(movement)
        // Keep collectblock from disabling its movement safety checks.
        bot.collectBlock.movements = null
        await bot.tool.equipForBlock(block, { requireHarvest: true, getFromChest: false })
        this.check(signal)
        await bot.collectBlock.collect(block, { chestLocations: [] })
        this.check(signal)
        if (this.planner.count(action.item) <= before) throw new Error('No requested resource reached the inventory.')
      } else if (action.kind === 'craft') {
        const before = this.planner.count(action.item)
        const recipe = this.planner.Recipe.find(bot.registry.itemsByName[action.item].id, null)[action.recipeIndex]
        if (!recipe) throw new Error('Recipe is no longer available.')
        let table = null
        if (recipe.requiresTable) {
          await this.travel(action.position, 3, signal)
          table = bot.blockAt(vector(action.position))
          if (table?.name !== 'crafting_table') throw new Error('Crafting table is no longer present.')
        }
        this.check(signal)
        await bot.craft(recipe, action.times, table)
        this.check(signal)
        if (this.planner.count(action.item) < before + action.count) throw new Error('Crafting did not produce the expected inventory change.')
      } else if (action.kind === 'place') await this.placeStation(action.item, signal)
      else if (action.kind === 'smelt') await this.smelt(action, signal)
      else if (action.kind === 'equip') {
        const item = bot.inventory.items().find(i => i.name === action.item)
        if (!item) throw new Error('The item is no longer in inventory.')
        const destination = action.destination || armorDestination(item.name)
        await bot.equip(item, destination)
        this.check(signal)
        const equipped = destination === 'hand' ? bot.heldItem : bot.inventory.slots[destination === 'off-hand' ? 45 : armorSlots[destination]]
        if (equipped?.name !== action.item) throw new Error('Equipment change was not observed.')
      } else if (action.kind === 'eat') {
        const item = bot.inventory.items().find(i => i.name === action.item)
        if (!item || !this.planner.safeFood()) throw new Error('No food is available.')
        const before = bot.food
        await bot.equip(item, 'hand')
        this.check(signal)
        await bot.consume()
        this.check(signal)
        if (bot.food <= before) throw new Error('Eating did not increase the food meter.')
      } else if (action.kind === 'sleep') {
        await this.travel(action.position, 2, signal)
        await bot.sleep(bot.blockAt(vector(action.position)))
        this.check(signal)
        if (!bot.isSleeping) throw new Error('The server did not put Jev to sleep.')
      } else throw new Error('Unknown action')
      return `${action.label}: done`
    } finally {
      clearTimeout(watchdog)
      clearInterval(doors)
      doorController.abort()
      signal.removeEventListener('abort', onAbort)
      bot.pathfinder?.setGoal(null)
      bot.clearControlStates()
      this.busy = false
      this.activeKind = null
    }
  }

  async placeStation(name, signal) {
    if (!['crafting_table', 'furnace'].includes(name)) throw new Error('Unsupported placement')
    const bot = this.bot
    const origin = bot.entity.position.floored()
    const options = []
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
      if (x === 0 && z === 0) continue
      const pos = origin.offset(x, 0, z)
      const floor = bot.blockAt(pos.offset(0, -1, 0))
      if (bot.blockAt(pos)?.name === 'air' && bot.blockAt(pos.offset(0, 1, 0))?.name === 'air' && floor?.boundingBox === 'block' && !['crafting_table', 'furnace', 'chest', 'barrel'].includes(floor.name)) options.push({ pos, floor })
    }
    options.sort((a, b) => a.pos.distanceTo(origin) - b.pos.distanceTo(origin))
    const target = options.find(o => !Object.values(bot.entities).some(e => e.position.distanceTo(o.pos.offset(0.5, 0, 0.5)) < 1))
    if (!target) throw new Error('No clear floor nearby for the workstation.')
    const item = bot.inventory.items().find(i => i.name === name)
    if (!item) throw new Error(`No ${name} in inventory.`)
    await bot.equip(item, 'hand')
    this.check(signal)
    await bot.placeBlock(target.floor, new Vec3(0, 1, 0))
    this.check(signal)
    if (bot.blockAt(target.pos)?.name !== name) throw new Error('Placement was not confirmed by the world state.')
  }

  async smelt(action, signal) {
    const bot = this.bot
    const job = this.state.smeltJob || { ...action, collected: 0 }
    await this.travel(job.position, 3, signal)
    const block = bot.blockAt(vector(job.position))
    if (block?.name !== 'furnace') throw new Error('The furnace is no longer present.')
    const furnace = await bot.openFurnace(block)
    try {
      this.check(signal)
      if (!this.state.smeltJob && [furnace.inputItem(), furnace.outputItem(), furnace.fuelItem()].some(Boolean)) {
        throw new Error('This furnace is occupied. Empty it or provide an empty furnace for Jev.')
      }
      if (furnace.inputItem() && furnace.inputItem().name !== job.input) throw new Error('The furnace input was changed. Check it before resuming.')
      if (furnace.outputItem() && furnace.outputItem().name !== job.item) throw new Error('The furnace output was changed. Check it before resuming.')
      this.state.smeltJob = job
      this.save()
      const existing = (furnace.inputItem()?.count || 0) + (furnace.outputItem()?.count || 0) + job.collected
      const needed = job.count - existing
      if (needed < 0) throw new Error('The furnace contents changed. Check it before resuming.')
      if (needed) {
        const input = bot.inventory.items().find(i => i.name === job.input)
        if (!input || input.count < needed) throw new Error(`Need ${needed} ${job.input} to finish the furnace batch.`)
        await furnace.putInput(input.type, null, needed)
        this.check(signal)
      }
      if (!furnace.fuelItem() && !furnace.fuel) {
        const fuel = bot.inventory.items().find(i => i.name === job.fuel)
        if (!fuel) throw new Error('The furnace needs more fuel.')
        await furnace.putFuel(fuel.type, null, Math.min(job.fuelCount, fuel.count))
        this.check(signal)
      }
      const deadline = Date.now() + 95000
      while (job.collected < job.count) {
        this.check(signal)
        const output = furnace.outputItem()
        if (output) {
          if (output.name !== job.item) throw new Error('Unexpected furnace output.')
          const count = output.count
          await furnace.takeOutput()
          job.collected += count
          this.save()
        }
        if (Date.now() > deadline) throw new Error('Furnace is taking too long. Check its fuel, then resume.')
        if (job.collected < job.count) await delay(500, null, { signal })
      }
      this.state.smeltJob = null
      this.save()
    } finally { furnace.close() }
  }
}

module.exports = { Executor }
