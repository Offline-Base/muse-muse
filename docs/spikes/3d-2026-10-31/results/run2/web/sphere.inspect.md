
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
| #   | name  | rootName | bboxMin    | bboxMax | renderVertexCount¹ | uploadVertexCount | uploadNaiveVertexCount |
| --- | ---   | ---      | ---        | ---     | ---                | ---               | ---                    |
| 0   | Scene | sphere   | -1, -1, -1 | 1, 1, 1 | 27,072             | 18,724            | 18,724                 |

¹ Expected number of vertices processed by the vertex shader for one render
  pass, without considering the vertex cache.

² Expected number of vertices uploaded to GPU, assuming each Accessor
  is uploaded only once. Actual number uploaded may be higher, 
  dependent on the implementation and vertex buffer layout.

³ Expected number of vertices uploaded to GPU, assuming each Primitive
  is uploaded once, duplicating vertex attributes shared among Primitives.



 MESHES
 ────────────────────────────────────────────
| #   | name   | mode      | meshPrimitives | glPrimitives | vertices | indices | attributes               | instances | size¹     |
| --- | ---    | ---       | ---            | ---          | ---      | ---     | ---                      | ---       | ---       |
| 0   | sphere | TRIANGLES | 1              | 9,024        | 18,724   | u16     | NORMAL:f32, POSITION:f32 | 1         | 503.52 KB |

⁴ size estimates GPU memory required by a mesh, in isolation. If accessors are
  shared by other mesh primitives, but the meshes themselves are not reused, then
  the sum of all mesh sizes will overestimate the asset's total size. See "dedup".



 MATERIALS
 ────────────────────────────────────────────
No materials found.


 TEXTURES
 ────────────────────────────────────────────
No textures found.


 ANIMATIONS
 ────────────────────────────────────────────
No animations found.

