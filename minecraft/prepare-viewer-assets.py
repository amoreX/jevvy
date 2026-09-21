"""Prepare verified vanilla 26.2 assets for Prismarine Viewer's existing builder."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'runtime' / 'viewer-build'
CACHE.mkdir(parents=True, exist_ok=True)
CLIENT = {
    'sha1': '2dc72797acbc1b63fc16a11c4ac393605f453754',
    'url': 'https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar',
}
jar = CACHE / 'client-26.2.jar'
if not jar.exists():
    temporary = jar.with_suffix('.download')
    with urllib.request.urlopen(CLIENT['url'], timeout=60) as source, temporary.open('wb') as target:
        while data := source.read(1024 * 1024):
            target.write(data)
    temporary.replace(jar)
if hashlib.sha1(jar.read_bytes()).hexdigest() != CLIENT['sha1']:
    raise ValueError('Minecraft 26.2 client jar checksum mismatch')

assets = CACHE / 'assets-26.2'
assets.mkdir(exist_ok=True)
models = {}
states = {}
with zipfile.ZipFile(jar) as archive:
    for name in archive.namelist():
        if name.startswith('assets/minecraft/textures/') and not name.endswith('/'):
            parts = list(PurePosixPath(name).relative_to('assets/minecraft/textures').parts)
            if '..' in parts:
                raise ValueError(name)
            if parts[0] == 'block':
                parts[0] = 'blocks'
            target = assets.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
        elif name.startswith('assets/minecraft/models/block/') and name.endswith('.json'):
            key = name.removeprefix('assets/minecraft/models/block/').removesuffix('.json')
            models[key] = json.loads(archive.read(name))
        elif name.startswith('assets/minecraft/blockstates/') and name.endswith('.json'):
            key = name.removeprefix('assets/minecraft/blockstates/').removesuffix('.json')
            states[key] = json.loads(archive.read(name))
(assets / 'blocks_models.json').write_text(json.dumps(models))
(assets / 'blocks_states.json').write_text(json.dumps(states))
print(f'Prepared verified 26.2 assets: {len(models)} models, {len(states)} block states.')
