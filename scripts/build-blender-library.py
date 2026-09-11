"""Run in Blender with --background --python, or through the Blender bridge.
Imports exact runtime geometry; saves a separate editable library and review render.
"""
import bpy
import math
import json
from pathlib import Path
from mathutils import Vector

ROOT = Path(args['project_root']) if globals().get('args', {}).get('project_root') else Path(__file__).resolve().parent.parent
ART = ROOT / 'art'
(ART / 'previews').mkdir(parents=True, exist_ok=True)

# Separate scene: never delete the user's existing Blender scene.
previous = bpy.data.scenes.get('Night_Hunt_Art_Library')
if previous and previous.get('generated_by') == 'night-hunt-art':
    for obj in list(previous.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(previous.collection.children):
        bpy.data.collections.remove(collection)
    bpy.data.scenes.remove(previous)
scene = bpy.data.scenes.new('Night_Hunt_Art_Library')
scene['generated_by'] = 'night-hunt-art'
bpy.context.window.scene = scene
manifest = json.loads((ART / 'manifest.json').read_text(encoding='utf-8'))
stage = bpy.data.collections.new('00_REVIEW_STAGE')
scene.collection.children.link(stage)

def move_to_collection(obj, collection):
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    collection.objects.link(obj)

def mat(name, color):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = .86
    return m

floor_mat = mat('Review_stage_slate', (.055, .082, .09))
label_mat = mat('Review_labels', (.64, .72, .68))

for idx, asset in enumerate(manifest['assets']):
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(ART / asset['file']))
    imported = set(scene.objects) - before
    collection = bpy.data.collections.new(f'{idx+1:02d}_{asset["id"]}')
    scene.collection.children.link(collection)
    for obj in imported:
        move_to_collection(obj, collection)
    roots = [obj for obj in imported if obj.parent not in imported]
    anchor = bpy.data.objects.new(f'ASSET_{asset["id"]}', None)
    collection.objects.link(anchor)
    for obj in roots:
        obj.parent = anchor
    anchor['source'] = asset['file']
    anchor['runtime_units'] = 'metres; restore display scale to 1 for export'
    anchor['reference'] = 'docs/art-reference-index.md'
    anchor.asset_mark()
    anchor.asset_data.description = asset['label'] + ' | editable runtime geometry'
    display_scale = {'survivor': 1.7, 'hunter': 1.5, 'lantern': 6, 'switch': 2.2, 'grass': 2.8, 'manor': .22, 'ground-tile': 1.2, 'wall': .68}.get(asset['id'], 1)
    anchor.scale = (display_scale,) * 3
    anchor['display_scale'] = display_scale
    x, y = (idx % 6 - 2.5) * 6.1, (1 - idx // 6) * 7.0
    anchor.location = (x, y, .18)
    # Small presentation plinths are isolated in the review collection.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, .025))
    plinth = bpy.context.object
    plinth.name = f'Plinth_{idx+1:02d}'
    plinth.dimensions = (5.55, 5.8, .18)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = plinth.modifiers.new('Small edge highlight', 'BEVEL')
    bevel.width = .055
    bevel.segments = 1
    plinth.data.materials.append(floor_mat)
    move_to_collection(plinth, stage)
    bpy.ops.object.text_add(location=(x-2.4, y-2.6, .14), rotation=(0, 0, 0))
    label = bpy.context.object
    label.name = f'Label_{idx+1:02d}'
    label.data.body = f'{idx+1:02d}  {asset["id"].upper()}'
    label.data.size = .24
    label.data.extrude = .001
    label.data.materials.append(label_mat)
    move_to_collection(label, stage)

world = bpy.data.worlds.new('Night_Hunt_Studio')
world.use_nodes = True
background = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
if background is None:
    background = world.node_tree.nodes.new('ShaderNodeBackground')
    output = next((n for n in world.node_tree.nodes if n.type == 'OUTPUT_WORLD'), None) or world.node_tree.nodes.new('ShaderNodeOutputWorld')
    world.node_tree.links.new(background.outputs[0], output.inputs[0])
background.inputs[0].default_value = (.065, .09, .11, 1)
background.inputs[1].default_value = .5
scene.world = world

def area(name, loc, energy, color, size):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.color, data.shape, data.size = energy, color, 'DISK', size
    obj = bpy.data.objects.new(name, data)
    stage.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector((0, 0, 0)) - obj.location).to_track_quat('-Z', 'Y').to_euler()

area('Warm_key', (0, -12, 24), 6500, (1, .85, .67), 18)
area('Cool_rim', (5, 15, 20), 8000, (.53, .78, 1), 16)
data = bpy.data.cameras.new('Asset_library_camera')
camera = bpy.data.objects.new('Asset_library_camera', data)
stage.objects.link(camera)
camera.location = (23, -36, 33)
camera.rotation_euler = (Vector((0, 0, 1.5))-camera.location).to_track_quat('-Z', 'Y').to_euler()
data.type, data.ortho_scale = 'ORTHO', 46
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1920, 1320
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(ART / 'previews' / 'asset-library.png')
scene.view_settings.view_transform = 'AgX'
bpy.ops.wm.save_as_mainfile(filepath=str(ART / 'night-hunt-art-library.blend'))
bpy.ops.render.render(write_still=True)
__result__ = {'blend': bpy.data.filepath, 'preview': scene.render.filepath, 'assets': len(manifest['assets']), 'objects': len(scene.objects)}
print(json.dumps(__result__))
