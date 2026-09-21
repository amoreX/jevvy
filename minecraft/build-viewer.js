const fs = require('node:fs')
const path = require('node:path')
const webpack = require('webpack')
const root = __dirname
const viewer = path.dirname(require.resolve('prismarine-viewer/package.json'))
const output = path.join(root, 'viewer-public')
const assets = path.join(root, 'runtime/viewer-build/assets-26.2')

// Existing 26.x model and modern world-height fixes from Prismarine Viewer PR #480.
for (const file of ['viewer/lib/modelsBuilder.js', 'viewer/lib/worker.js', 'viewer/lib/worldrenderer.js']) {
  fs.copyFileSync(path.join(root, 'vendor/viewer-compat', file), path.join(viewer, file))
}
fs.copyFileSync(path.join(viewer, 'LICENSE'), path.join(root, 'vendor/viewer-compat/LICENSE'))
const versionsPath = path.join(viewer, 'viewer/lib/version.js')
const versions = fs.readFileSync(versionsPath, 'utf8')
if (!versions.includes("'26.2'")) fs.writeFileSync(versionsPath, versions.replace("'1.21.4']", "'1.21.4', '26.2']"))

const { makeTextureAtlas } = require('prismarine-viewer/viewer/lib/atlas')
const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder')
const mcAssets = {
  directory: assets,
  blocksStates: JSON.parse(fs.readFileSync(path.join(assets, 'blocks_states.json'))),
  blocksModels: JSON.parse(fs.readFileSync(path.join(assets, 'blocks_models.json')))
}
fs.mkdirSync(path.join(output, 'textures'), { recursive: true })
fs.mkdirSync(path.join(output, 'blocksStates'), { recursive: true })
const atlas = makeTextureAtlas(mcAssets)
fs.writeFileSync(path.join(output, 'textures/26.2.png'), atlas.image)
fs.writeFileSync(path.join(output, 'blocksStates/26.2.json'), JSON.stringify(prepareBlocksStates(mcAssets, atlas)))
// Upstream entity models use this texture layout, independent of block state IDs.
fs.cpSync(path.join(viewer, 'public/textures/1.16.4'), path.join(output, 'textures/1.16.4'), { recursive: true })
fs.copyFileSync(path.join(root, 'viewer.html'), path.join(output, 'index.html'))

const configs = require('./vendor/viewer-compat/webpack.config')
for (const config of configs) {
  config.context = viewer
  config.output.path = output
  config.optimization = { minimize: false }
  config.stats = 'errors-warnings'
  config.resolve.fallback.fs = false
  config.resolve.fallback.path = false
}
configs[0].entry = path.join(root, 'viewer-client.js')
webpack(configs, (error, stats) => {
  if (error) throw error
  console.log(stats.toString({ colors: false, all: false, errors: true, warnings: true, timings: true }))
  if (stats.hasErrors()) process.exitCode = 1
  else console.log('Built Minecraft 26.2 live viewer.')
})
