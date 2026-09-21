const armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const presets = [
  { id: 'iron_armor', label: 'Get iron armor', category: 'Equipment', goal: { kind: 'armor', items: armor } },
  ...['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'iron_sword', 'shield', 'bucket'].map(item => ({
    id: item, label: `Get ${item.replaceAll('_', ' ')}`, category: 'Equipment', goal: { kind: 'acquire', item, count: 1 }
  })),
  ...[['logs', 16], ['cobblestone', 32], ['coal', 16], ['raw_iron', 24], ['iron_ingot', 24], ['torch', 16], ['bread', 6]].map(([item, count]) => ({
    id: item, label: `Get ${count} ${item.replaceAll('_', ' ')}`, category: 'Resources', goal: { kind: 'acquire', item, count }
  })),
  ...['crafting_table', 'furnace'].map(item => ({ id: item, label: `Set up ${item.replaceAll('_', ' ')}`, category: 'Workstations', goal: { kind: 'station', item } })),
  { id: 'eat', label: 'Eat food', category: 'Survival', goal: { kind: 'eat' } },
  { id: 'sleep', label: 'Sleep in a nearby bed', category: 'Survival', goal: { kind: 'sleep' } },
  { id: 'home', label: 'Return home', category: 'Movement', goal: { kind: 'home' } },
  { id: 'look', label: 'Look around', category: 'Observation', goal: { kind: 'look' } }
]

const actions = [
  ['collect', 'Collect natural blocks', 'Find nearby logs, stone, coal and ores; select a suitable tool and collect drops. The home buffer is excluded.'],
  ['craft', 'Craft items', 'Use the installed 26.2 recipe data, obtaining supported ingredients and setting up a crafting table when needed.'],
  ['smelt', 'Smelt and cook', 'Turn raw iron, copper, gold, logs and raw food into products in a furnace, up to eight at a time.'],
  ['equip', 'Equip gear', 'Wear each piece of iron armor, or equip an inventory item in hand.'],
  ['place', 'Set up a workstation', 'Place a crafting table or furnace on a clear, nearby floor.'],
  ['goto', 'Travel to coordinates', 'Walk to x/y/z using Mineflayer Pathfinder. Travel does not dig or build.'],
  ['visit', 'Go to a player', 'Walk within three blocks of a visible player, then finish the goal.'],
  ['home', 'Return home', 'Walk back to the saved home position. Set home from Settings.'],
  ['eat', 'Eat', 'Eat a safe food from the inventory until the food meter is at least 18.'],
  ['sleep', 'Sleep', 'Find a nearby bed, walk to it and try sleeping. Server time and rules still apply.'],
  ['look', 'Look around', 'Turn the player camera through four directions; inspect live inventory and nearby entities in the panel.']
].map(([id, label, description]) => ({ id, label, description }))

function parseGoal(text, registry, players = []) {
  const command = require('./commands').parseCommand(text, registry, players)
  if (command) return command
  const clean = text.trim().replace(/^(?:please |can you |could you )/i, '').toLowerCase().replace(/[.!]$/, '')
  const preset = presets.find(p => p.label.toLowerCase() === clean || p.id === clean)
  if (preset) return structuredClone(preset.goal)
  if (/^(get|make|craft|wear|equip)?\s*(full |a set of |some )?iron (armo[u]r|set)$/.test(clean)) return { kind: 'armor', items: armor }
  const armorSet = clean.match(/^(?:get|make|craft|wear|equip)?\s*(?:full |a set of |some )?(leather|chainmail|gold|golden|diamond|netherite) armo[u]?r$/)
  if (armorSet) { const material = armorSet[1] === 'gold' ? 'golden' : armorSet[1]; return { kind: 'armor', items: ['helmet', 'chestplate', 'leggings', 'boots'].map(part => `${material}_${part}`) } }
  if (/^(go |return |come )?(back )?home$/.test(clean)) return { kind: 'home' }
  if (/^(eat|eat food|fill (my |your )?hunger)$/.test(clean)) return { kind: 'eat' }
  if (/^(sleep|go to sleep)$/.test(clean)) return { kind: 'sleep' }
  if (/^(look|look around|inspect|check surroundings)$/.test(clean)) return { kind: 'look' }
  const coordinates = clean.match(/^(?:go|walk|move)(?: to)?\s+(-?\d+)\s*[, /]\s*(-?\d+)\s*[, /]\s*(-?\d+)$/)
  if (coordinates) return { kind: 'goto', position: { x: +coordinates[1], y: +coordinates[2], z: +coordinates[3] } }
  const player = clean.match(/^(?:visit|go to|walk to|follow)\s+(\w+)$/)
  if (player && players.some(name => name.toLowerCase() === player[1])) return { kind: 'visit', player: players.find(name => name.toLowerCase() === player[1]) }
  const request = clean.match(/^(get|gather|collect|mine|make|craft|equip|smelt|cook|place|set up)\s+(?:(\d+)\s+)?(.+)$/)
  if (request) {
    let item = require('./commands').itemName(request[3], registry)
    if (Object.hasOwn(registry.itemsByName, item) || ['logs', 'planks'].includes(item)) {
      if (request[1] === 'cook') item = ({ beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato' })[item] || item
      const count = request[2] ? +request[2] : 1
      if (count < 1 || count > 256) throw new Error('Choose an item quantity between 1 and 256.')
      if (['place', 'set up'].includes(request[1])) {
        if (!['crafting_table', 'furnace'].includes(item)) throw new Error('Placement currently supports crafting tables and furnaces.')
        return { kind: 'station', item }
      }
      return { kind: request[1] === 'equip' ? 'equip' : 'acquire', item, count }
    }
  }
  return null
}

module.exports = { presets, actions, parseGoal, armor }
