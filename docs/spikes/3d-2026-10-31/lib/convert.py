# Format conversion and decimation, the way a build would prepare an uploaded model: an OBJ and an STL made outside
# Blender (make-meshes.mjs) are imported and exported as GLB, then the OBJ's mesh is decimated and exported again.
#   blender -b --factory-startup --python-exit-code 3 --python convert.py -- <in.obj> <in.stl> <out dir> <ratio>
import json
import os
import sys
import time

import bpy

obj_in, stl_in, out_dir, ratio = sys.argv[sys.argv.index("--") + 1 :][:4]
ratio = float(ratio)


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def tris():
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            me = o.evaluated_get(dg).to_mesh()
            me.calc_loop_triangles()
            n += len(me.loop_triangles)
            o.evaluated_get(dg).to_mesh_clear()
    return n


def load(path):
    t = time.time()
    if path.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    elif hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=path)
    else:
        bpy.ops.import_mesh.stl(filepath=path)
    return round(time.time() - t, 3)


def export(path):
    t = time.time()
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
    return round(time.time() - t, 3), os.path.getsize(path)


rows = []
for src in (obj_in, stl_in):
    fresh()
    load_s = load(src)
    n = tris()
    out = os.path.join(out_dir, os.path.basename(src).rsplit(".", 1)[0] + ".glb")
    export_s, size = export(out)
    rows.append({"step": "convert", "in": os.path.basename(src), "inBytes": os.path.getsize(src), "triangles": n, "importS": load_s, "exportS": export_s, "out": os.path.basename(out), "outBytes": size})

fresh()
load(obj_in)
before = tris()
o = next(o for o in bpy.context.scene.objects if o.type == "MESH")
bpy.context.view_layer.objects.active = o
o.select_set(True)
t = time.time()
mod = o.modifiers.new("Decimate", "DECIMATE")
mod.ratio = ratio
bpy.ops.object.modifier_apply(modifier=mod.name)
dec_s = round(time.time() - t, 3)
after = tris()
out = os.path.join(out_dir, "decimated.glb")
export_s, size = export(out)
rows.append({"step": "decimate", "ratio": ratio, "trianglesBefore": before, "trianglesAfter": after, "decimateS": dec_s, "exportS": export_s, "out": "decimated.glb", "outBytes": size})
for r in rows:
    print("RESULT " + json.dumps(r))
