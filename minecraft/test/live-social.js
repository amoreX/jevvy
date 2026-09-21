if (!process.argv.includes('--run')) throw new Error('Use --run for this opt-in live check.')
require('../protocol-fix')()
const mineflayer = require('mineflayer')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const config = require('../config.json')
const clients = [], replies = []
async function connect(username) {
  const bot = mineflayer.createBot({ ...config, username, hideErrors: true })
  clients.push(bot)
  bot.on('error', e => console.error(e.message))
  bot._client.on('playerChat', p => {
    if (username !== 'JevCheck') return
    if (Object.values(bot.players || {}).some(player => player.uuid === p.sender && player.username === 'Jev')) {
      replies.push(p.plainMessage)
      console.log(JSON.stringify({ reply: p.plainMessage }))
    }
  })
  await once(bot, 'spawn')
  return bot
}
async function waitFor(predicate, label, ms = 25000) {
  const end = Date.now() + ms
  while (!(await predicate())) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(100) }
}
const snapshot = () => fetch('http://127.0.0.1:3007/api/agent').then(r => r.json())
async function main() {
  const a = await connect('JevCheck'), b = await connect('JevCheck2')
  await delay(1500)
  a.chat('@jev stop')
  await waitFor(() => replies.some(t => /Stopped/.test(t)), 'stop')
  await delay(1100)
  a.chat('@jev what is my favorite building material?')
  await waitFor(() => replies.some(t => /birch/i.test(t)), 'recall after process restart')
  await delay(1100)
  a.chat('@jev wait 8 seconds')
  await waitFor(async () => (await snapshot()).community.current?.owner === 'JevCheck', 'first job')
  b.chat('@jev jump once')
  await waitFor(() => replies.some(t => /^JevCheck2: Done:.*Jumped/.test(t)), 'second player job')
  await waitFor(() => replies.some(t => /^JevCheck: Done:.*Wait/.test(t)), 'first player job')
  await delay(1100)
  const visible = (await snapshot()).observation.players
  const target = visible.some(p => p.name === 'JevCheck') ? 'me' : visible[0]?.name
  if (!target) throw new Error('No loaded player is available for the follow integration check.')
  a.chat(`@jev keep following ${target} until I say stop`)
  await waitFor(async () => (await snapshot()).currentAction?.startsWith('Keep following'), 'continuous follow')
  await delay(1000)
  const start = Date.now()
  b.chat('@jev stop')
  await waitFor(async () => { const s = await snapshot(); return s.community.held && !s.busy }, 'other player stop')
  console.log(JSON.stringify({ stopObservedMs: Date.now() - start, metrics: (await snapshot()).community.metrics }))
  console.log('LIVE_SOCIAL_PASS')
}
const timeout = setTimeout(() => { for (const bot of clients) bot.quit(); process.exitCode = 1 }, 65000)
main().catch(e => { console.error(e.message); process.exitCode = 1 }).finally(async () => {
  if (clients[0]) { clients[0].chat('@jev stop'); await delay(1000) }
  clearTimeout(timeout)
  for (const bot of clients) bot.quit()
})
