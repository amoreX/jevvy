// Explicit, opt-in integration check against the configured Minecraft server.
// Creates a clearly named test player and sends a few ordinary chat requests.
if (!process.argv.includes('--run')) throw new Error('Use node test/live-chat.js --run to run the live Minecraft chat check.')
require('../protocol-fix')()
const mineflayer = require('mineflayer')
const { setTimeout: delay } = require('node:timers/promises')
const config = require('../config.json')
const bot = mineflayer.createBot({ ...config, username: 'JevCheck', hideErrors: true })
const messages = []
const deadline = setTimeout(() => { console.error('Live check timed out'); bot.quit(); process.exitCode = 1 }, 90000)
bot._client.on('playerChat', packet => {
  const name = Object.values(bot.players || {}).find(p => p.uuid === packet.sender)?.username
  if (name === 'Jev') { messages.push({ at: Date.now(), text: packet.plainMessage }); console.log(JSON.stringify({ from: name, text: packet.plainMessage })) }
})
bot.on('error', error => console.error(error.message))
bot.on('end', () => clearTimeout(deadline))
async function waitFor(test, label, timeout = 20000) {
  const end = Date.now() + timeout
  while (!test()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(100) }
}
async function ask(text, predicate) {
  const start = Date.now(), offset = messages.length
  console.log(JSON.stringify({ send: text }))
  bot.chat(text)
  await waitFor(() => messages.slice(offset).some(m => predicate(m.text)), text)
  console.log(JSON.stringify({ checked: text, elapsedMs: Date.now() - start }))
  await delay(1100)
}
bot.once('spawn', async () => {
  try {
    await delay(1500)
    console.log(JSON.stringify({ probePosition: bot.entity.position }))
    await ask('@jev stop', t => /Stopped/.test(t))
    await ask('@jev for this chat test, my favorite building material is birch. What material did I say?', t => /birch/i.test(t))
    await ask('@jev jump once', t => /Done:.*Jumped/i.test(t))
    await ask('@jev follow ronis for 2 seconds', t => /Done:.*Followed/i.test(t))
    await ask('@jev stop', t => /Stopped/.test(t))
    console.log('LIVE_CHAT_PASS')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally { bot.chat('@jev stop'); await delay(1000); clearTimeout(deadline); bot.quit() }
})
