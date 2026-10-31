# Builds a small low-poly scene from nothing (a faceted rock, a tree, a metal ring, a checker ground, a camera and a sun),
# exports it as GLB, and renders it with one engine. Made-up content only.
#   blender -b --factory-startup --python-exit-code 3 --python scene.py -- [--glb out.glb] [--engine E --out out.png]
#       [--samples 32] [--size 640x480] [--work /tmp/work]
import argparse
import json
import random
import resource
import sys
import time

import bpy
from mathutils import Vector

ap = argparse.ArgumentParser()
ap.add_argument("--glb")
ap.add_argument("--engine")
ap.add_argument("--out")
ap.add_argument("--samples", type=int, default=32)
ap.add_argument("--size", default="640x480")
ap.add_argument("--work", default="/tmp/work")
ap.add_argument("--no-denoise", action="store_true")
ap.add_argument("--turntable", type=int, default=0, help="render this many frames of the camera circling the scene")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1 :])
result = {"blender": bpy.app.version_string}
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
random.seed(7)


def material(name, color, rough=0.5, metal=0.0, image=None):
    m = bpy.data.materials.new(name)
    if hasattr(m, "use_nodes") and not m.use_nodes:
        m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None) or nodes.new("ShaderNodeOutputMaterial")
        links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if image is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = image
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    m.diffuse_color = (*color, 1.0)  # What Workbench shows in material color mode.
    return m


def flat(obj, mat):
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj


# A 256x256 checker, saved as a PNG first so the glTF exporter embeds a real image.
img = bpy.data.images.new("checker", 256, 256)
img.generated_type = "COLOR_GRID"
img.filepath_raw = f"{args.work}/checker.png"
img.file_format = "PNG"
img.save()

bpy.ops.mesh.primitive_plane_add(size=7, location=(0, 0, 0))
flat(bpy.context.object, material("Ground", (0.8, 0.8, 0.8), 0.9, image=img)).name = "Ground"

bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0, location=(0, 0, 1.0))
rock = bpy.context.object
for v in rock.data.vertices:
    v.co *= 0.85 + random.random() * 0.3
flat(rock, material("Rock", (0.85, 0.42, 0.18), 0.45)).name = "Rock"

bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=0.7, depth=1.6, location=(2.0, 1.2, 1.3))
flat(bpy.context.object, material("Leaves", (0.15, 0.55, 0.22), 0.7)).name = "Leaves"
bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.15, depth=0.6, location=(2.0, 1.2, 0.3))
flat(bpy.context.object, material("Trunk", (0.35, 0.2, 0.1), 0.8)).name = "Trunk"

bpy.ops.mesh.primitive_torus_add(major_segments=12, minor_segments=6, major_radius=0.6, minor_radius=0.18, location=(-1.9, -0.7, 0.18))
flat(bpy.context.object, material("Ring", (0.9, 0.85, 0.7), 0.25, 1.0)).name = "Ring"

bpy.ops.object.camera_add(location=(6.0, -6.0, 4.5))
cam = bpy.context.object
cam.rotation_euler = (Vector((0, 0, 0.7)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
bpy.ops.object.light_add(type="SUN", rotation=(0.87, 0.0, 0.52))
bpy.context.object.data.energy = 3.0

world = bpy.data.worlds.new("Sky")
scene.world = world
if hasattr(world, "use_nodes") and not world.use_nodes:
    world.use_nodes = True
bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
if bg is not None:
    bg.inputs["Color"].default_value = (0.55, 0.65, 0.85, 1.0)
    bg.inputs["Strength"].default_value = 0.7
world.color = (0.55, 0.65, 0.85)

dg = bpy.context.evaluated_depsgraph_get()
tris = 0
for o in scene.objects:
    if o.type == "MESH":
        me = o.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        o.evaluated_get(dg).to_mesh_clear()
result.update(triangles=tris, objects=len(scene.objects), buildS=round(time.time() - t0, 3))

if args.glb:
    t = time.time()
    bpy.ops.export_scene.gltf(filepath=args.glb, export_format="GLB")
    result.update(glb=args.glb, exportS=round(time.time() - t, 3))

if args.engine:
    items = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    engine = args.engine
    if engine == "BLENDER_EEVEE" and engine not in items and "BLENDER_EEVEE_NEXT" in items:
        engine = "BLENDER_EEVEE_NEXT"
    r = scene.render
    r.engine = engine
    w, h = (int(x) for x in args.size.split("x"))
    r.resolution_x, r.resolution_y, r.resolution_percentage = w, h, 100
    r.image_settings.file_format = "PNG"
    r.filepath = args.out
    if engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = args.samples
        # Blender 5.2 has no build_options.openimagedenoise, and the denoiser enum is filled at run time (empty when read
        # statically, run 3), so the Cycles module's own flag says whether OIDN is built in.
        try:
            import _cycles

            oidn = bool(getattr(_cycles, "with_openimagedenoise", False))
        except Exception:
            oidn = None
        scene.cycles.use_denoising = not args.no_denoise
        if scene.cycles.use_denoising:
            scene.cycles.denoiser = "OPENIMAGEDENOISE"
            if hasattr(scene.cycles, "denoising_use_gpu"):
                scene.cycles.denoising_use_gpu = False
        result.update(samples=args.samples, oidnBuilt=oidn, denoiser=scene.cycles.denoiser if scene.cycles.use_denoising else None)
    elif engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
    else:
        scene.eevee.taa_render_samples = args.samples
        result.update(samples=args.samples)
    t = time.time()
    if args.turntable:
        # The camera rides an empty at the scene's middle that turns once over the frames.
        pivot = bpy.data.objects.new("Pivot", None)
        scene.collection.objects.link(pivot)
        pivot.location = (0, 0, 0.7)
        cam.location = cam.location - pivot.location
        cam.parent = pivot
        scene.frame_start, scene.frame_end = 1, args.turntable
        bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert("rotation_euler", index=2, frame=1)
        pivot.rotation_euler = (0, 0, 6.2832 * (args.turntable - 1) / args.turntable)
        pivot.keyframe_insert("rotation_euler", index=2, frame=args.turntable)
        r.filepath = args.out.rsplit(".", 1)[0] + "-####"
        bpy.ops.render.render(animation=True)
        result.update(frames=args.turntable)
    else:
        bpy.ops.render.render(write_still=True)
    result.update(engine=engine, renderS=round(time.time() - t, 3), out=args.out, threads=r.threads)

result["maxRssMB"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
print("RESULT " + json.dumps(result))
