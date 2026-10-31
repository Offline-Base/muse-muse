# A 64x48 render of the default-ish scene with one engine, to see whether it starts at all.
#   blender -b --factory-startup --python-exit-code 3 --python probe.py -- <ENGINE> <out.png>
import sys
import time

import bpy

engine, out = sys.argv[sys.argv.index("--") + 1 :][:2]
items = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
print("PROBE engines", items)
if engine not in items and engine == "BLENDER_EEVEE" and "BLENDER_EEVEE_NEXT" in items:
    engine = "BLENDER_EEVEE_NEXT"
scene = bpy.context.scene
scene.render.engine = engine
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 64, 48, 100
scene.render.filepath = out
if engine == "CYCLES":
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
t = time.time()
bpy.ops.render.render(write_still=True)
print(f"PROBE {engine} rendered in {time.time() - t:.2f} s")
