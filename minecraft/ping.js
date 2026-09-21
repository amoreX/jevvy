const { ping } = require('minecraft-protocol')
const { host, port, version } = require('./config.json')

ping({ host, port, version, closeTimeout: 10000 }, (error, result) => {
  if (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  const { favicon, ...status } = result
  console.log(JSON.stringify(status, null, 2))
})
