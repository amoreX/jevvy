const { test } = require('node:test')
const assert = require('node:assert/strict')
const { itemName } = require('../agent/commands')
const registry = require('prismarine-registry')('26.2')

test('item normalization preserves every real item ID in the connected version', () => {
  for (const name of Object.keys(registry.itemsByName)) assert.equal(itemName(name, registry), name)
  for (const name of ['logs', 'planks']) assert.equal(itemName(name, registry), name)
})

test('common plurals and formatted names resolve only to real registry items', () => {
  for (const [input, expected] of [
    ['jungle_logs', 'jungle_log'], ['oak logs', 'oak_log'], ['  Minecraft:Jungle_Logs  ', 'jungle_log'],
    ['the crafting tables', 'crafting_table'], ['wooden axes', 'wooden_axe'], ['torches', 'torch'],
    ['oak-planks', 'oak_planks'], ['iron boots', 'iron_boots'], ['jungle leaves', 'jungle_leaves'],
    ['glass', 'glass'], ['compasses', 'compass'], ['wood', 'logs'], ['log', 'logs'], ['plank', 'planks'],
    ['iron', 'iron_ingot'], ['seeds', 'wheat_seeds']
  ]) assert.equal(itemName(input, registry), expected, input)
  for (const name of ['unobtainium_logs', 'mod:jungle_log', '__proto__', 'constructor']) {
    assert.equal(itemName(name, registry), name)
    assert.equal(Object.hasOwn(registry.itemsByName, itemName(name, registry)), false)
  }
})
