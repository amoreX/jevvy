// Parse literal arguments locally. Jev selects only concrete, validated options;
// the decision model is never asked to invent coordinates, counts or message text.
const words = { once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 }
const verbs = 'jump|hop|rotate|spin|turn|look|walk|run|sprint|sneak|swim|move|go|follow|visit|attack|hit|kill|equip|unequip|drop|open|close|take|withdraw|deposit|store|craft|make|get|collect|mine|dig|break|place|plant|harvest|till|eat|sleep|wake|fish|use|activate|interact|mount|ride|dismount|wait|inspect|check|select|trade|enchant|repair|rename|say|chat|write|set'
function splitTasks(text) {
  const parts = []
  let start = 0
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') quoted = !quoted
    if (quoted) continue
    const match = text.slice(i).match(new RegExp(`^(?:\\n|;|→|\\s+(?:and\\s+)?then\\s+|\\s+and\\s+(?=(?:${verbs})\\b))`, 'i'))
    if (match) { parts.push(text.slice(start, i).trim()); i += match[0].length - 1; start = i + 1 }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}
function bounded(n, min, max, label) {
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`)
  return n
}
function itemName(text, registry) {
  const name = text.trim().toLowerCase().replace(/^(?:a|an|the|some)\s+/, '').replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')
  const exists = candidate => Object.hasOwn(registry.itemsByName, candidate)
  // Preserve real plural IDs such as oak_planks, iron_boots and jungle_leaves.
  if (exists(name)) return name
  const aliases = { wood: 'logs', log: 'logs', plank: 'planks', iron: 'iron_ingot', seeds: 'wheat_seeds' }
  if (Object.hasOwn(aliases, name)) return aliases[name]
  // Accept a plural only when its singular is an actual item in this version.
  for (const singular of [name.replace(/s$/, ''), name.replace(/es$/, ''), name.replace(/ies$/, 'y')]) {
    if (exists(singular)) return singular
  }
  return name
}
function parseNavigation(text, players = []) {
  const clean = text.trim().replace(/[.!?]+$/, '').replace(/^(?:please |can you |could you )/i, '')
  const follow = clean.match(/^(?:(keep|continue)(?:\s+on)?\s+)?follow(?:ing)?\s+(.+)$/i)
  const visit = clean.match(/^(visit|go to|walk to|move to|run to|sprint to)\s+(.+)$/i)
  if (!follow && !visit) return null
  const body = (follow || visit)[2]
  // Match a complete username token, never an arbitrary substring or the
  // sentence after it. Keep unknown names so they produce a useful error.
  const token = body.match(/^([a-z0-9_]{1,16})(?=\s|$)/i)
  if (!token || /^-?\d+$/.test(token[1]) || token[1].toLowerCase() === 'home') return null
  const target = players.find(name => name.toLowerCase() === token[1].toLowerCase()) || token[1]
  let tail = body.slice(token[0].length).trim()
  let seconds
  const duration = tail.match(/\bfor\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+(seconds?|secs?|minutes?|mins?)\b/i)
  if (duration) {
    const count = words[duration[1].toLowerCase()] ?? +duration[1]
    seconds = bounded(count * (/^min/i.test(duration[2]) ? 60 : 1), 1, 1200, 'Duration')
    tail = tail.replace(duration[0], '').trim()
  }
  const continuous = !!follow && seconds === undefined && (!!follow[1] || /\baround\b|\bwherever\b|\bkeep\b|\buntil\b|\bcontinuously\b/.test(tail.toLowerCase()))
  // Extra wording describes following, not another player name. Other clauses
  // still go through intent classification rather than being silently ignored.
  const descriptors = /^(?:(?:and\s+)?(?:around|closely|please|continuously)|wherever\s+(?:he|she|they)\s+(?:goes?|moves?)|(?:and\s+)?keep\s+(?:moving|going|running|sprinting|walking|following)(?:\s+(?:to|towards?|after))?\s+(?:him|her|them|me)|until\s+(?:i\s+(?:say|press|tell you to)\s+stop|stopped|stop))\s*/i
  while (tail && descriptors.test(tail)) tail = tail.replace(descriptors, '').trim()
  if (tail) return null
  if (follow) return { kind: 'action', action: 'follow', args: { target, seconds: seconds || 15, ...(continuous ? { continuous: true } : {}) }, repeat: 1 }
  return { kind: 'action', action: 'visit', args: { target, style: /^(run|sprint)/i.test(visit[1]) ? 'sprint' : 'walk' }, repeat: 1 }
}
function parseCommand(text, registry, players = []) {
  const literal = text.trim().replace(/^(?:please |can you |could you )/i, '')
  const navigation = parseNavigation(literal, players)
  if (navigation) return navigation
  let clean = literal.toLowerCase().replace(/[.!]$/, '').replace(/\b(once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/g, w => `${words[w]}${/^(once|twice|thrice)$/.test(w) ? ' times' : ''}`)
  const command = (action, args = {}, repeat = 1) => ({ kind: 'action', action, args, repeat: bounded(repeat, 1, 100, 'Repeat count') })
  let m
  if ((m = literal.match(/^(?:say|chat|send (?:a )?message)\s+(.+)$/is))) return command('chat', { text: m[1].replace(/^"|"$/g, '') })
  if ((m = literal.match(/^write (?:on (?:the )?)?(sign|book)\s+(.+)$/is))) return command(m[1].toLowerCase(), { text: m[2].replace(/^"|"$/g, '') })
  if ((m = clean.match(/^(?:jump|hop)(?:\s+(\d+)(?:\s+times?)?)?$/))) return command('jump', {}, +(m[1] || 1))
  if ((m = clean.match(/^(?:rotate|spin)(?:\s+(left|right))?(?:\s+(\d+)(?:\s+(?:times?|turns?))?)?$/))) return command('rotate', { direction: m[1] || 'right' }, +(m[2] || 1))
  if ((m = clean.match(/^(?:turn|look)\s+(?:to\s+)?(?:your\s+)?(left|right|up|down)(?:\s+(\d+)(?:\s+degrees?)?)?$/))) return command('turn', { direction: m[1], degrees: bounded(+(m[2] || 90), 1, 360, 'Angle') })
  if ((m = clean.match(/^(walk|run|sprint|sneak|swim|move)\s+(forward|backward|back|left|right|north|south|east|west|up|down)(?:\s+(?:for\s+)?(\d+(?:\.\d+)?)(?:\s+(blocks?|seconds?|secs?))?)?$/))) return command('move', { style: ({ run: 'sprint', move: 'walk' })[m[1]] || m[1], direction: m[2] === 'backward' ? 'back' : m[2], ...(/sec/.test(m[4] || '') ? { seconds: bounded(+(m[3] || 1), 0.1, 60, 'Duration') } : { blocks: bounded(+(m[3] || 1), 0.1, 64, 'Distance') }) })
  if ((m = clean.match(/^(?:look at|attack|hit|kill|mount|ride|interact with|feed|shear)\s+(?:the\s+)?(.+)$/))) {
    if (!/^-?\d/.test(m[1])) {
      const verb = clean.slice(0, clean.indexOf(m[1])).trim()
      let action = /look at/.test(verb) ? 'look_at' : /attack|hit|kill/.test(verb) ? 'attack' : /mount|ride/.test(verb) ? 'mount' : /interact|feed|shear/.test(verb) ? 'interact_entity' : 'visit'
      if (action === 'interact_entity' && registry.blocksByName[m[1].replaceAll(' ', '_')]) action = 'interact_block'
      if (m[1] !== 'home') return command(action, { target: m[1], ...(verb.startsWith('kill') ? { untilDead: true } : {}) })
    }
  }
  if (/^(?:set|remember)(?: this as| my| your)? home$/.test(clean)) return command('set_home')
  if (/^(?:wake|wake up)$/.test(clean)) return command('wake')
  if (/^respawn$/.test(clean)) return command('respawn')
  if (/^(?:dismount|get out)$/.test(clean)) return command('dismount')
  if (/^(?:close|close (?:the )?(?:window|container|chest|inventory))$/.test(clean)) return command('close_window')
  if (/^(?:fish|go fishing|catch a fish)$/.test(clean)) return command('fish')
  if (/^(?:glide|start gliding)$/.test(clean)) return command('elytra')
  if ((m = clean.match(/^(?:wait)(?:\s+(\d+)(?:\s+seconds?)?)?$/))) return command('wait', { seconds: bounded(+(m[1] || 1), 1, 60, 'Duration') })
  if ((m = clean.match(/^(?:inspect|check|show)(?:\s+(?:my|your|the))?\s+(inventory|position|nearby|surroundings|window|everything)$/))) return command('inspect', { section: ({ surroundings: 'nearby', everything: 'all' })[m[1]] || m[1] })
  if ((m = clean.match(/^(?:select|hotbar)(?:\s+hotbar)?(?:\s+slot)?\s+([1-9])$/))) return command('hotbar', { slot: +m[1] - 1 })
  if ((m = clean.match(/^unequip\s+(helmet|chestplate|leggings|boots|head|torso|legs|feet|hand|off.?hand)$/))) return command('unequip', { destination: ({ helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet', offhand: 'off-hand', 'off hand': 'off-hand' })[m[1]] || m[1] })
  if ((m = clean.match(/^equip\s+(.+?)(?:\s+(?:in|to)\s+(?:the\s+)?(hand|off.?hand|head|torso|legs|feet))$/))) return command('equip', { item: itemName(m[1], registry), destination: m[2].replace(/^off.?hand$/, 'off-hand') })
  if ((m = clean.match(/^(drop|deposit|store|withdraw|take|plant)\s+(?:(\d+)\s+)?(.+?)(?:\s+(?:from|in|into)\s+(?:the\s+)?(chest|barrel|hopper|furnace))?$/))) return command(({ store: 'deposit', take: 'withdraw' })[m[1]] || m[1], { item: itemName(m[3], registry), count: bounded(+(m[2] || 1), 1, 256, 'Item quantity'), ...(m[4] ? { container: m[4] } : {}) })
  if ((m = clean.match(/^(open|close)\s+(?:the\s+|a\s+)?(?:(\w+)\s+)?(door|gate)(?:\s+.*)?$/))) return command('interact_block', { target: m[2] && registry.blocksByName[`${m[2]}_${m[3]}`] ? `${m[2]}_${m[3]}` : m[3], open: m[1] === 'open' })
  if ((m = clean.match(/^(?:open)\s+(?:the\s+|a\s+)?(.+)$/))) return command('open_container', { target: m[1].replaceAll(' ', '_') })
  if ((m = clean.match(/^(?:dig|break|interact with|activate|harvest|till)\s+(?:the\s+|a\s+)?(.+)$/))) return command(/^(dig|break)/.test(clean) ? 'dig' : clean.startsWith('harvest') ? 'harvest' : clean.startsWith('till') ? 'till' : 'interact_block', { target: m[1].replaceAll(' ', '_') })
  if ((m = clean.match(/^place\s+(?:a\s+)?(.+)$/))) {
    const item = itemName(m[1], registry)
    if (!['crafting_table', 'furnace'].includes(item) && registry.itemsByName[item]) return command(/boat|raft|minecart|armor_stand|item_frame|painting/.test(item) ? 'place_entity' : 'place_block', { item })
  }
  if ((m = clean.match(/^(?:use|hold|charge)\s+(.+?)(?:\s+for\s+(\d+)\s+seconds?)?$/))) return command('use_item', { item: itemName(m[1], registry), seconds: bounded(+(m[2] || 1), 1, 30, 'Duration') })
  if (/^(?:release|release item|stop using)$/.test(clean)) return command('release_item')
  if ((m = clean.match(/^(?:move|swap)\s+slot\s+(\d+)\s+to\s+(\d+)$/))) return command('move_slot', { from: bounded(+m[1], 9, 44, 'Source slot'), to: bounded(+m[2], 9, 44, 'Destination slot') })
  if ((m = clean.match(/^(left.click|right.click|shift.click)\s+slot\s+(\d+)$/))) return command('click_slot', { button: m[1].startsWith('right') ? 1 : 0, mode: m[1].startsWith('shift') ? 1 : 0, slot: +m[2] })
  if ((m = clean.match(/^enchant(?:\s+(?:option\s+)?([1-3]))?$/))) return command('enchant', m[1] ? { choice: +m[1] - 1 } : {})
  if ((m = clean.match(/^trade(?:\s+for)?\s+(.+)$/))) return command('trade', { item: itemName(m[1], registry) })
  if ((m = literal.match(/^rename\s+(.+?)\s+to\s+(.+)$/i))) return command('anvil', { first: itemName(m[1], registry), text: m[2].replace(/^"|"$/g, '') })
  if ((m = clean.match(/^(?:steer|drive)\s+(forward|back|left|right)(?:\s+for\s+(\d+)\s+seconds?)?$/))) return command('steer', { direction: m[1], seconds: bounded(+(m[2] || 1), 1, 30, 'Duration') })
  if (/^(?:explore|explore around|explore nearby)$/.test(clean)) return command('explore')
  if (/^(?:start|stop) flying$/.test(clean)) return command('creative_fly', { flying: clean.startsWith('start') })
  if ((m = clean.match(/^creative give\s+(?:(\d+)\s+)?(.+)$/))) return command('creative_item', { item: itemName(m[2], registry), count: bounded(+(m[1] || 1), 1, 64, 'Item quantity') })
  return null
}
module.exports = { splitTasks, parseCommand, parseNavigation, itemName }
