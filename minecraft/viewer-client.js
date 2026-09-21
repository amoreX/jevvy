global.THREE = require('three')
const THREE = global.THREE
const { OrbitControls } = require('three/examples/jsm/controls/OrbitControls')
const { Viewer, Entity } = require('prismarine-viewer/viewer')
const socket = require('socket.io-client')()
require('./agent-client')(socket)
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
const sceneElement = document.getElementById('scene')
renderer.setSize(sceneElement.clientWidth, sceneElement.clientHeight)
sceneElement.appendChild(renderer.domElement)
const viewer = new Viewer(renderer)
viewer.listen(socket)
let controls = null
let mode = 'orbit'
let position = null
let selfMesh = null
let ready = false

function setCamera() {
  if (!position) return
  const { pos, yaw, pitch } = position
  if (mode === 'eyes') {
    viewer.setFirstPersonCamera(pos, yaw, pitch)
  } else if (selfMesh) {
    selfMesh.position.set(pos.x, pos.y, pos.z)
    selfMesh.rotation.y = yaw
  }
}

function chooseMode(next) {
  mode = next
  controls?.dispose()
  controls = null
  if (mode === 'orbit' && position) {
    controls = new OrbitControls(viewer.camera, renderer.domElement)
    const { pos } = position
    controls.target.set(pos.x, pos.y + 1, pos.z)
    viewer.camera.position.set(pos.x + 9, pos.y + 7, pos.z + 9)
    controls.update()
  }
  if (selfMesh) selfMesh.visible = mode === 'orbit'
  document.getElementById('eyes').ariaPressed = String(mode === 'eyes')
  document.getElementById('orbit').ariaPressed = String(mode === 'orbit')
  document.getElementById('crosshair').hidden = mode !== 'eyes'
  setCamera()
}
document.getElementById('eyes').onclick = () => chooseMode('eyes')
document.getElementById('orbit').onclick = () => chooseMode('orbit')

socket.on('version', version => {
  ready = false
  viewer.resetAll()
  if (selfMesh) viewer.scene.remove(selfMesh)
  if (!viewer.setVersion(version)) return
  selfMesh = new Entity('1.16.4', 'player', viewer.scene).mesh
  selfMesh.visible = mode === 'orbit'
  viewer.scene.add(selfMesh)
  document.getElementById('connection').textContent = 'Loading world'
})
socket.on('position', data => {
  const wasEmpty = !position
  if (controls && position) {
    const delta = new THREE.Vector3(
      data.pos.x - position.pos.x,
      data.pos.y - position.pos.y,
      data.pos.z - position.pos.z
    )
    viewer.camera.position.add(delta)
    controls.target.add(delta)
  }
  position = data
  if (wasEmpty) chooseMode(mode)
  setCamera()
})
socket.on('connect', () => { document.getElementById('connection').textContent = 'Connected' })
socket.on('disconnect', () => {
  document.getElementById('connection').textContent = 'Disconnected'
  document.getElementById('live').dataset.connected = 'false'
})
socket.on('status', status => {
  document.getElementById('health').textContent = `${status.health ?? '—'} / 20`
  document.getElementById('food').textContent = `${status.food ?? '—'} / 20`
  document.getElementById('live').dataset.connected = String(status.phase === 'spawned')
  if (ready) document.getElementById('connection').textContent = status.phase === 'spawned' ? 'Live' : status.phase
})

function animate() {
  requestAnimationFrame(animate)
  controls?.update()
  viewer.update()
  renderer.render(viewer.scene, viewer.camera)
  const count = Object.keys(viewer.world.sectionMeshs).length
  if (count > 0 && !ready) {
    ready = true
    document.getElementById('connection').textContent = 'Live'
    document.getElementById('loading').hidden = true
  }
}
animate()
window.addEventListener('resize', () => {
  viewer.camera.aspect = sceneElement.clientWidth / sceneElement.clientHeight
  viewer.camera.updateProjectionMatrix()
  renderer.setSize(sceneElement.clientWidth, sceneElement.clientHeight)
})
