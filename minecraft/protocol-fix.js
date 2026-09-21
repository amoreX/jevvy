// Backport of zkonikishi/Mineflayer commit f9e7db4447afda7838f08aa13430ec768738c178.
// https://github.com/zkonikishi/Mineflayer/commit/f9e7db4447afda7838f08aa13430ec768738c178
// The pinned Complexity dataset predates the 26.2 serverbound interaction fix.
module.exports = function fixProtocol() {
  const types = require('minecraft-data')('26.2').protocol.play.toServer.types
  const mapping = types.packet[1][0].type[1].mappings
  const expected = ['spectator_action', 'arm_animation', 'teleport_to_entity', 'test_instance_block_action', 'block_place', 'use_item', 'custom_click_action']
  if (!['arm_animation', 'spectator_action'].includes(mapping['0x3e'])) throw new Error('Unexpected 26.2 protocol dataset; review the interaction backport.')
  expected.forEach((name, i) => { mapping[`0x${(0x3e + i).toString(16)}`] = name })
  types.packet[1][1].type[1].fields.teleport_to_entity = 'packet_teleport_to_entity'
  types.packet_teleport_to_entity = ['container', [{ name: 'target', type: 'UUID' }]]
}
