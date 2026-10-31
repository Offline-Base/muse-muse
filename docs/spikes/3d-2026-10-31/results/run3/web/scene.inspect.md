
 OVERVIEW
 ────────────────────────────────────────────
| key                | value                            |
| ---                | ---                              |
| version            | 2.0                              |
| generator          | Khronos glTF Blender I/O v5.2.41 |
| extensionsUsed     | none                             |
| extensionsRequired | none                             |



 SCENES
 ────────────────────────────────────────────
| #   | name  | rootName | bboxMin       | bboxMax       | renderVertexCount¹ | uploadVertexCount | uploadNaiveVertexCount |
| --- | ---   | ---      | ---           | ---           | ---                | ---               | ---                    |
| 0   | Scene | Ground   | -3.5, 0, -3.5 | 3.5, 2.1, 3.5 | 774                | 552               | 552                    |

¹ Expected number of vertices processed by the vertex shader for one render
  pass, without considering the vertex cache.

² Expected number of vertices uploaded to GPU, assuming each Accessor
  is uploaded only once. Actual number uploaded may be higher, 
  dependent on the implementation and vertex buffer layout.

³ Expected number of vertices uploaded to GPU, assuming each Primitive
  is uploaded once, duplicating vertex attributes shared among Primitives.



 MESHES
 ────────────────────────────────────────────
| #   | name      | mode      | meshPrimitives | glPrimitives | vertices | indices | attributes                               | instances | size¹     |
| --- | ---       | ---       | ---            | ---          | ---      | ---     | ---                                      | ---       | ---       |
| 0   | Plane     | TRIANGLES | 1              | 2            | 4        | u16     | NORMAL:f32, POSITION:f32, TEXCOORD_0:f32 | 1         | 140 Bytes |
| 1   | Cone      | TRIANGLES | 1              | 12           | 28       | u16     | NORMAL:f32, POSITION:f32, TEXCOORD_0:f32 | 1         | 968 Bytes |
| 2   | Torus     | TRIANGLES | 1              | 144          | 244      | u16     | NORMAL:f32, POSITION:f32, TEXCOORD_0:f32 | 1         | 8.67 KB   |
| 3   | Icosphere | TRIANGLES | 1              | 80           | 240      | u16     | NORMAL:f32, POSITION:f32, TEXCOORD_0:f32 | 1         | 8.16 KB   |
| 4   | Cylinder  | TRIANGLES | 1              | 20           | 36       | u16     | NORMAL:f32, POSITION:f32, TEXCOORD_0:f32 | 1         | 1.27 KB   |

⁴ size estimates GPU memory required by a mesh, in isolation. If accessors are
  shared by other mesh primitives, but the meshes themselves are not reused, then
  the sum of all mesh sizes will overestimate the asset's total size. See "dedup".



 MATERIALS
 ────────────────────────────────────────────
| #   | name   | instances | textures         | alphaMode | doubleSided |
| --- | ---    | ---       | ---              | ---       | ---         |
| 0   | Ground | 1         | baseColorTexture | OPAQUE    | ✓           |
| 1   | Leaves | 1         |                  | OPAQUE    | ✓           |
| 2   | Ring   | 1         |                  | OPAQUE    | ✓           |
| 3   | Rock   | 1         |                  | OPAQUE    | ✓           |
| 4   | Trunk  | 1         |                  | OPAQUE    | ✓           |



 TEXTURES
 ────────────────────────────────────────────
| #   | name    | uri | slots            | instances | mimeType  | compression | resolution | size     | gpuSize⁵  |
| --- | ---     | --- | ---              | ---       | ---       | ---         | ---        | ---      | ---       |
| 0   | checker |     | baseColorTexture | 1         | image/png |             | 256x256    | 17.87 KB | 349.52 KB |

⁵ gpuSize estimates minimum VRAM memory allocation. Older devices may require
  additional memory for GPU compression formats.



 ANIMATIONS
 ────────────────────────────────────────────
No animations found.

