const { Vec3 } = require('vec3')
const { point, vector, armorDestination, armorSlots } = require('./planner')

const empty = block => block && ['air', 'cave_air'].includes(block.name)
const directions = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function layout(origin, width, length, height, shelter) {
  const blocks = []
  if (!shelter) {
    for (let x = 0; x < width; x++) for (let z = 0; z < length; z++) blocks.push(point(origin.offset(x, 0, z)))
    return blocks
  }
  for (let y = 0; y <= height; y++) for (let x = 0; x < width; x++) for (let z = 0; z < length; z++) {
    if (y !== height && x !== 0 && x !== width - 1 && z !== 0 && z !== length - 1) continue
    if (x === Math.floor(width / 2) && z === 0 && y < 2) continue
    blocks.push(point(origin.offset(x, y, z)))
  }
  return blocks
}

function findSite(bot, width, length, height) {
  const origin = bot.entity.position.floored()
  for (const radius of [4, 7, 10]) for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
    const start = origin.offset(dx, 0, dz)
    let clear = true
    for (let x = -1; x <= width && clear; x++) for (let z = -1; z <= length && clear; z++) {
      const p = start.offset(x, 0, z)
      const floor = bot.blockAt(p.offset(0, -1, 0))
      if (floor?.boundingBox !== 'block' || !/^(grass_block|dirt|podzol|coarse_dirt|moss_block|stone|sand|gravel|cobblestone|deepslate)$/.test(floor.name)) { clear = false; break }
      for (let y = 0; y <= height; y++) if (!empty(bot.blockAt(p.offset(0, y, 0)))) { clear = false; break }
    }
    if (clear && !Object.values(bot.entities || {}).some(e => e.position && e.position.x >= start.x - 1 && e.position.x <= start.x + width + 1 && e.position.z >= start.z - 1 && e.position.z <= start.z + length + 1)) return start
  }
  return null
}

function placement(agent, destination, item) {
  const bot = agent.bot, pos = vector(destination)
  for (const face of directions) {
    const reference = bot.blockAt(pos.minus(face))
    if (reference?.boundingBox !== 'block') continue
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(reference.position.offset(0.5, 0.5, 0.5)) > 4.5) continue
    if (Object.values(bot.entities || {}).some(e => e.position?.distanceTo(pos.offset(0.5, 0, 0.5)) < 1.2)) continue
    return { kind: 'place_block', item, position: point(reference.position), block: reference.name, face: point(face), destination, label: `Build ${item} at ${pos}`, owned: true }
  }
  return null
}

function planSkill(agent, spec) {
  const { bot, planner } = agent
  planner.reasons = []
  planner.requirements = []
  planner.woodCache = {}
  const result = (candidates = [], complete = false, reasons = []) => ({ candidates, complete, reasons: [...reasons, ...planner.reasons], requirements: planner.requirements })
  if (bot.currentWindow && spec.skill !== 'store_items') return result([{ kind: 'close_window', windowId: bot.currentWindow.id, label: 'Close the container before continuing' }])
  if (spec.skill.startsWith('build_')) {
    const args = spec.args || {}, width = args.width || 5, length = args.length || 5, height = args.height || 3
    if (!spec.layout) {
      const origin = findSite(bot, width, length, height)
      if (!origin) return result([], false, ['no accessible source: no clear, flat building site nearby; explore for a site.'])
      spec.layout = layout(origin, width, length, height, spec.skill === 'build_shelter')
      spec.material = args.item || planner.wood('_planks')
      if (!bot.registry.blocksByName[spec.material]) return result([], false, ['The chosen building material is not a placeable block.'])
      agent.save()
    }
    const pending = spec.layout.filter(p => bot.blockAt(vector(p))?.name !== spec.material)
    if (!pending.length) return result([], true)
    if (pending.some(p => { const b = bot.blockAt(vector(p)); return b && !empty(b) })) return result([], false, ['The building site changed. I will not overwrite the new blocks.'])
    if (planner.count(spec.material) < pending.length) return result(planner.ensure(spec.material, pending.length))
    const actions = pending.map(p => placement(agent, p, spec.material)).filter(Boolean).slice(0, 8)
    if (actions.length) return result(actions)
    const p = pending[0]
    return result([{ kind: 'goto', position: p, range: 3, label: 'Approach the next part of the build' }])
  }
  if (spec.skill === 'light_area') {
    if (!spec.positions) {
      const origin = bot.entity.position.floored()
      spec.positions = [new Vec3(3, 0, 0), new Vec3(-3, 0, 0), new Vec3(0, 0, 3), new Vec3(0, 0, -3)]
        .map(d => origin.plus(d)).filter(p => empty(bot.blockAt(p)) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block').map(point)
      if (!spec.positions.length) return result([], false, ['There are no clear torch positions nearby.'])
      agent.save()
    }
    const pending = spec.positions.filter(p => !/torch/.test(bot.blockAt(vector(p))?.name || ''))
    if (!pending.length) return result([], true)
    if (planner.count('torch') < pending.length) return result(planner.ensure('torch', pending.length))
    const p = pending[0], action = placement(agent, p, 'torch')
    return result(action ? [action] : [{ kind: 'goto', position: p, range: 2, label: 'Approach the unlit area' }])
  }
  if (spec.skill === 'store_items') {
    if (spec.finished && !bot.currentWindow) return result([], true)
    const owned = Object.values(agent.memory?.data.places || {}).find(p => p.owned && !p.stale && p.name === 'chest' && p.dimension === bot.game.dimension)
    if (!owned) {
      if (!planner.count('chest')) return result(planner.ensure('chest', 1))
      const origin = bot.entity.position.floored()
      for (const direction of directions.slice(1)) {
        const p = origin.plus(direction.scaled(2))
        if (empty(bot.blockAt(p))) { const action = placement(agent, point(p), 'chest'); if (action) return result([action]) }
      }
      return result([], false, ['No clear place for an owned storage chest.'])
    }
    const target = bot.blockAt(vector(owned.position))
    if (target && target.name !== 'chest') return result([], false, ['The remembered storage chest is gone.'])
    if (bot.entity.position.distanceTo(vector(owned.position)) > 3) return result([{ kind: 'goto', position: owned.position, range: 2, label: 'Go to my storage chest' }])
    if (!bot.currentWindow) return result([{ kind: 'open_container', position: owned.position, block: 'chest', label: 'Open my storage chest' }])
    const surplus = Object.entries(planner.inventory()).find(([name, count]) => !/pickaxe|axe$|sword|shovel|hoe$|helmet|chestplate|leggings|boots|shield|bucket|torch/.test(name) && !bot.registry.foodsByName[name] && count > (/log|plank/.test(name) ? 16 : 32))
    if (!surplus) { spec.finished = true; return result([{ kind: 'close_window', windowId: bot.currentWindow.id, label: 'Close my storage chest' }]) }
    spec.stored = true
    const count = surplus[1] - (/log|plank/.test(surplus[0]) ? 16 : 32)
    return result([{ kind: 'deposit', item: surplus[0], count, windowId: bot.currentWindow.id, label: `Store ${count} surplus ${surplus[0]}` }])
  }
  return result([], false, ['Unknown building or inventory skill.'])
}

function idleCatalog(agent, memory) {
  const { planner, bot } = agent, entries = []
  const add = (tag, label, specs, eligible = true, cooldown = 120000) => {
    const past = memory.data.skills[tag]
    const wait = past?.lastResult && past.failures > past.successes ? Math.min(600000, 30000 * 2 ** Math.min(past.failures, 4)) : cooldown
    if (eligible && (!past || Date.now() - past.lastAt > wait)) entries.push({ tag, label, specs })
  }
  const acquire = (item, count) => [{ kind: 'acquire', item, count }]
  const action = (action, args = {}) => [{ kind: 'action', action, args, repeat: 1 }]
  add('eat', 'Eat available food to restore hunger', [{ kind: 'eat' }], bot.food < 18 && !!planner.safeFood(), 0)
  for (const i of planner.items()) {
    const dest = armorDestination(i.name)
    if (dest !== 'hand' && !bot.inventory.slots[armorSlots[dest]]) add(`wear_${dest}`, `Wear available ${i.name}`, [{ kind: 'equip', item: i.name }], true, 0)
  }
  add('wood', 'Gather a reserve of 16 natural logs', acquire('logs', 16), planner.count('logs') < 16)
  add('stone_tools', 'Progress to a stone pickaxe', acquire('stone_pickaxe', 1), !planner.items().some(i => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)))
  add('coal', 'Mine a reserve of coal', acquire('coal', 16), planner.count('coal') < 16 && planner.items().some(i => /pickaxe$/.test(i.name)))
  add('stone', 'Mine building cobblestone', acquire('cobblestone', 48), planner.count('cobblestone') < 48 && planner.items().some(i => /pickaxe$/.test(i.name)))
  add('iron', 'Obtain iron for better equipment', acquire('iron_ingot', 8), planner.count('iron_ingot') < 8 && planner.count('stone_pickaxe') > 0)
  add('iron_pickaxe', 'Upgrade to an iron pickaxe', acquire('iron_pickaxe', 1), planner.count('iron_ingot') >= 3 && !planner.count('iron_pickaxe'))
  add('armor', 'Make and wear iron armor', [{ kind: 'armor', items: require('./catalog').armor }], planner.count('iron_ingot') >= 8 && !bot.inventory.slots[6])
  add('torches', 'Craft torches for caves and paths', acquire('torch', 16), planner.count('coal') > 0 && planner.count('torch') < 16)
  add('cook', 'Cook raw food for a survival reserve', acquire('cooked_beef', planner.count('cooked_beef') + planner.count('beef')), planner.count('beef') > 0)
  add('explore', 'Explore reachable new terrain and remember resources', action('explore'), true, 15000)
  add('shelter', 'Build a small shelter on a clear natural site', [{ kind: 'skill', skill: 'build_shelter', args: {} }], planner.count('planks') >= 48 || planner.count('logs') >= 16, 3600000)
  add('platform', 'Build a small work platform on a clear natural site', [{ kind: 'skill', skill: 'build_platform', args: { width: 3, length: 3 } }], planner.count('planks') >= 16, 3600000)
  add('light', 'Light the surrounding area', [{ kind: 'skill', skill: 'light_area', args: {} }], planner.count('torch') >= 4, 600000)
  add('storage', 'Store surplus while keeping tools, food and supplies', [{ kind: 'skill', skill: 'store_items', args: {} }], planner.items().length >= 24, 60000)
  add('farm', 'Harvest mature crops and replant', [...action('harvest'), ...action('plant')], planner.localBlocks().some(b => /wheat|carrots|potatoes/.test(b.name)))
  add('fish', 'Catch a fish for food', action('fish'), planner.count('fishing_rod') > 0 && planner.localBlocks().some(b => b.name === 'water'))
  add('rest', 'Rest in a nearby bed at night', [{ kind: 'sleep' }], bot.time?.timeOfDay > 12500 && planner.localBlocks().some(b => b.name.endsWith('_bed')), 120000)
  add('survey', 'Observe the surroundings and update world memory', [{ kind: 'look' }], true, 180000)
  return entries
}

module.exports = { planSkill, idleCatalog, layout, findSite, placement }
