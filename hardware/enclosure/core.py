"""Parametric 3D-printable core for a Jetson Orin Nano Super Developer Kit.

The core is a rigid box that sits inside a Muse plush or printed shell. The board hangs
upside down on four posts so its fan faces the floor: cool air comes up the intake duct
straight into the fan, warm air leaves through the exhaust duct in the lid. One rear port
panel carries power, Ethernet and USB on short extension cables, and a front panel holds an
addressable LED ring behind a 2 mm diffuser.

Every dimension is a field of ``Params`` below. Fields marked PLACEHOLDER are not verified
yet; see MEASUREMENTS.md for what to measure with calipers before printing.

Coordinates (assembled core): X across the core, -Y is the front (LED), +Y is the rear
(ports), Z is up, the outside of the floor is z = 0. Parts are returned in print
orientation (sitting on the bed at z = 0); ``assembly()`` places them in the core.

Run ``uv run python core.py`` to export STL and STEP files into out/.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from pathlib import Path

from build123d import (
    Align,
    Axis,
    Box,
    Compound,
    Cone,
    Cylinder,
    Plane,
    Polygon,
    Pos,
    RectangleRounded,
    Rot,
    Shape,
    ShapeList,
    export_step,
    export_stl,
    extrude,
    revolve,
)

OUT_DIR = Path(__file__).resolve().parent / "out"


@dataclass(frozen=True)
class Params:
    """All dimensions in millimetres. Sources are in MEASUREMENTS.md."""

    # --- Printer, fits and fasteners -------------------------------------------------
    bed_x: float = 220.0  # printable bed, X
    bed_y: float = 220.0  # printable bed, Y
    max_print_z: float = 200.0  # tallest part we allow
    fit_clr: float = 0.2  # radial clearance for sliding round fits
    slot_clr: float = 0.3  # clearance for panels sliding in their rails
    insert_hole_d: float = 4.0  # pilot hole for an M3 x 5.7 mm brass heat-set insert
    insert_depth: float = 6.2  # insert length plus 0.5 mm
    board_insert_hole_d: float = 4.0  # PLACEHOLDER: 3.6 if the board holes only take M2.5
    m3_clear_d: float = 3.4  # M3 clearance hole
    m3_head_d: float = 6.4  # counterbore for an M3 head
    m3_head_h: float = 1.6  # counterbore depth

    # --- Board: verified envelope (NVIDIA Super Developer Kit datasheet) ---------------
    kit_x: float = 103.0  # along the I/O edge
    kit_y: float = 90.5  # I/O edge to the opposite edge
    kit_z: float = 34.77  # feet + carrier + module + thermal solution

    # --- Board: PLACEHOLDERS, measure with calipers ------------------------------------
    pcb_x: float = 100.0  # PLACEHOLDER carrier PCB along the I/O edge
    pcb_y: float = 79.0  # PLACEHOLDER carrier PCB depth
    pcb_t: float = 1.6  # PLACEHOLDER PCB thickness
    io_overhang: float = 2.0  # PLACEHOLDER how far the I/O connectors stick out past the PCB
    stack_z: float = 31.2  # PLACEHOLDER PCB top face to fan top (34.77 - 2.0 feet - 1.6 PCB)
    underside_z: float = 3.0  # PLACEHOLDER tallest part on the PCB bottom face
    # PLACEHOLDER hole centres, from the PCB corner at the 40-pin header side and module
    # side, component side up, I/O edge away from you (x along the I/O edge).
    holes: tuple[tuple[float, float], ...] = ((4.0, 4.0), (96.0, 4.0), (4.0, 75.0), (96.0, 75.0))
    fan_center: tuple[float, float] = (50.0, 27.0)  # PLACEHOLDER, same corner as holes
    fan_bore_d: float = 38.0  # PLACEHOLDER fan blade tip diameter
    fan_hub_d: float = 20.0  # PLACEHOLDER fan hub diameter

    # --- Housing -------------------------------------------------------------------
    wall_t: float = 2.4  # six 0.4 mm perimeters
    floor_t: float = 3.0
    lid_t: float = 3.0
    corner_r: float = 5.0  # outside corner radius
    side_gap: float = 5.0  # board envelope to side walls (air riser)
    front_gap: float = 22.0  # front wall to board envelope (LED stack lives here)
    cable_bay: float = 42.0  # board envelope to rear wall (extension cables, air riser)
    top_headroom: float = 12.0  # above the tallest bottom-face part, under the lid
    fan_floor_gap: float = 7.5  # floor top to fan face
    duct_tip_gap: float = 1.0  # intake duct tip to fan face, closed by a foam ring
    collar_h: float = 4.5  # guide sleeve for the intake duct, above the floor
    collar_wall: float = 2.4
    post_d: float = 7.0  # board post; needs this much clear pad around each hole
    post_foot_d: float = 12.0  # conical foot where the post meets the floor
    post_zone_clr: float = 0.5  # radial clearance kept between a post and the board parts
    corner_boss_d: float = 8.0  # lid screw bosses
    corner_boss_inset: float = 3.6  # boss centre from the inner walls

    # --- Ducts and vent rings ----------------------------------------------------------
    duct_wall: float = 1.6  # four 0.4 mm perimeters
    intake_duct_id: float = 42.0  # seals on the cooler's top plate around the fan
    exhaust_duct_id: float = 46.0
    vent_open_d: float = 70.0  # round opening; cut the shell or fabric to this size
    vent_ring_h: float = 4.0  # straight ring above the mesh before the 45 degree cone
    vent_flange_w: float = 12.0  # flange glued or sewn to the inside of the shell
    vent_flange_t: float = 2.0
    grille_t: float = 1.6
    mesh_slot_w: float = 3.0
    mesh_rib_w: float = 1.6
    mesh_cross_rib_w: float = 2.0
    mesh_margin: float = 0.8  # solid rim inside the ring
    sew_hole_d: float = 2.0
    sew_hole_pitch: float = 8.0
    intake_reach: float = 25.0  # core floor to the inner face of the shell below
    exhaust_reach: float = 30.0  # lid top to the inner face of the shell above
    socket_h: float = 8.0  # exhaust duct socket on the lid
    socket_wall: float = 2.4

    # --- Rear port panel -----------------------------------------------------------------
    panel_t: float = 3.0
    panel_overlap: float = 6.0  # panel overlap behind the wall on each side of a notch
    rail_t: float = 2.4
    port_notch_w: float = 70.0
    port_notch_bottom: float = 4.0  # notch bottom above the floor top
    # Cutouts: (x, height above the floor top). PLACEHOLDERS until the cables arrive.
    dc_hole_d: float = 8.2  # PLACEHOLDER panel-mount 5.5 x 2.5 mm jack, M8 thread
    dc_pos: tuple[float, float] = (-22.0, 26.0)
    rj45_cut: tuple[float, float] = (17.0, 14.5)  # PLACEHOLDER keystone-free panel RJ45
    rj45_screw_pitch: float = 29.0  # PLACEHOLDER
    rj45_pos: tuple[float, float] = (10.0, 37.0)
    usb_cut: tuple[float, float] = (15.0, 8.0)  # PLACEHOLDER panel-mount USB-A
    usb_screw_pitch: float = 30.0  # PLACEHOLDER
    usb_pos: tuple[float, float] = (10.0, 16.0)

    # --- Front LED ring ----------------------------------------------------------------
    led_ring_od: float = 44.5  # Adafruit 16 pixel ring; 36.8 for the 12 pixel ring
    led_ring_id: float = 31.7  # 23.3 for the 12 pixel ring
    led_ring_t: float = 6.7  # listed ring thickness, used as LED reach from the PCB back
    led_pcb_t: float = 1.6  # PLACEHOLDER ring PCB thickness
    led_ledge: float = 0.5  # radial ledge the PCB rests on
    led_seat_clr: float = 0.3  # radial clearance in the PCB seat
    led_seat_depth: float = 1.3  # PCB stands 0.3 mm proud so the clamp preloads it
    diffuser_t: float = 2.0
    diffuser_lip: float = 1.5  # diffuser overlap past the window on each side
    led_panel_t: float = 3.0
    led_tube_h: float = 10.0  # light mixing tube between ring and diffuser
    led_tube_wall: float = 2.0
    led_center_h: float | None = None  # ring centre above the floor top; None = mid wall
    led_boss_d: float = 8.0
    led_clamp_t: float = 2.5
    led_wire_notch_w: float = 8.0
    led_notch_margin: float = 2.0

    # --- Strap and screw points ----------------------------------------------------------
    tab_l: float = 16.0  # how far a tab sticks out from the side wall
    tab_w: float = 24.0
    tab_t: float = 7.0  # thick enough for a heat-set insert
    tab_r: float = 3.0
    strap_slot: tuple[float, float] = (3.2, 12.0)  # for a 10 mm strap or zip tie
    tab_end_inset: float = 22.0  # tab centre from the front and back outer faces


P = Params()


@dataclass(frozen=True)
class Layout:
    """Derived positions, all in assembled core coordinates."""

    inner_x: float
    inner_y: float
    outer_x: float
    outer_y: float
    env_y0: float  # board envelope, front edge
    env_y1: float  # board envelope, rear (I/O) edge
    env_cy: float
    z_fan: float  # fan face (lowest point of the inverted board stack)
    z_comp: float  # PCB component face (post tops)
    z_solder: float  # PCB bottom face
    z_env_top: float  # top of the tallest bottom-face part
    z_rim: float  # top of the base walls, underside of the lid
    z_lid_top: float
    panel_h: float  # height of both slide-in panels
    holes: tuple[tuple[float, float], ...]  # post centres
    fan_xy: tuple[float, float]
    exhaust_y: float
    corner_bosses: tuple[tuple[float, float], ...]
    led_center_h: float  # above the floor top
    led_window_d: float
    led_pocket_d: float
    led_seat_d: float
    led_tube_od: float
    led_notch_w: float
    led_panel_w: float
    led_bosses: tuple[tuple[float, float], ...]  # panel coordinates (x, height)
    port_panel_w: float
    intake_od: float
    exhaust_od: float
    collar_id: float
    socket_id: float


def layout(p: Params = P) -> Layout:
    inner_x = p.kit_x + 2 * p.side_gap
    inner_y = p.front_gap + p.kit_y + p.cable_bay
    env_y0 = -inner_y / 2 + p.front_gap
    env_y1 = env_y0 + p.kit_y
    env_cy = (env_y0 + env_y1) / 2
    z_fan = p.floor_t + p.fan_floor_gap
    z_comp = z_fan + p.stack_z
    z_solder = z_comp + p.pcb_t
    z_env_top = z_solder + p.underside_z
    z_rim = z_env_top + p.top_headroom

    # Board coordinates: origin at the envelope centre, component side up, I/O edge at +Y,
    # 40-pin header side at -X. The board is mounted upside down (rotated about Y), so a
    # board point (bx, by) lands at core (-bx, env_cy + by).
    pcb_x0 = -p.pcb_x / 2
    pcb_y0 = p.kit_y / 2 - p.io_overhang - p.pcb_y

    def to_core(hx: float, hy: float) -> tuple[float, float]:
        return (-(pcb_x0 + hx), env_cy + pcb_y0 + hy)

    holes = tuple(to_core(hx, hy) for hx, hy in p.holes)
    fan_xy = to_core(*p.fan_center)

    intake_od = p.intake_duct_id + 2 * p.duct_wall
    exhaust_od = p.exhaust_duct_id + 2 * p.duct_wall
    socket_id = exhaust_od + 2 * p.fit_clr
    socket_r = socket_id / 2 + p.socket_wall
    outer_y = inner_y + 2 * p.wall_t
    bay_mid = (env_y1 + inner_y / 2) / 2
    exhaust_y = min(bay_mid, outer_y / 2 - socket_r - 3.0)

    bx = inner_x / 2 - p.corner_boss_inset
    by = inner_y / 2 - p.corner_boss_inset
    corner_bosses = ((-bx, -by), (bx, -by), (-bx, by), (bx, by))

    panel_h = z_rim - p.floor_t
    led_center_h = p.led_center_h if p.led_center_h is not None else panel_h / 2
    led_window_d = p.led_ring_od - 2 * p.led_ledge
    led_pocket_d = led_window_d + 2 * p.diffuser_lip
    led_seat_d = p.led_ring_od + 2 * p.led_seat_clr
    led_tube_od = led_seat_d + 2 * p.led_tube_wall
    led_notch_w = led_pocket_d + 2 * p.led_notch_margin
    led_panel_w = led_notch_w + 2 * p.panel_overlap
    boss_r = led_seat_d / 2 + p.led_boss_d / 2 + 0.5
    d = boss_r / math.sqrt(2)
    led_bosses = ((d, led_center_h + d), (-d, led_center_h - d))

    return Layout(
        inner_x=inner_x,
        inner_y=inner_y,
        outer_x=inner_x + 2 * p.wall_t,
        outer_y=outer_y,
        env_y0=env_y0,
        env_y1=env_y1,
        env_cy=env_cy,
        z_fan=z_fan,
        z_comp=z_comp,
        z_solder=z_solder,
        z_env_top=z_env_top,
        z_rim=z_rim,
        z_lid_top=z_rim + p.lid_t,
        panel_h=panel_h,
        holes=holes,
        fan_xy=fan_xy,
        exhaust_y=exhaust_y,
        corner_bosses=corner_bosses,
        led_center_h=led_center_h,
        led_window_d=led_window_d,
        led_pocket_d=led_pocket_d,
        led_seat_d=led_seat_d,
        led_tube_od=led_tube_od,
        led_notch_w=led_notch_w,
        led_panel_w=led_panel_w,
        led_bosses=led_bosses,
        port_panel_w=p.port_notch_w + 2 * p.panel_overlap,
        intake_od=intake_od,
        exhaust_od=exhaust_od,
        collar_id=intake_od + 2 * p.fit_clr,
        socket_id=socket_id,
    )


# --- Small geometry helpers ------------------------------------------------------------

_MIN = (Align.CENTER, Align.CENTER, Align.MIN)


def box(x0: float, x1: float, y0: float, y1: float, z0: float, z1: float) -> Shape:
    """Axis-aligned box from its corner coordinates."""
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def cyl(x: float, y: float, z0: float, z1: float, d: float) -> Shape:
    """Vertical cylinder from z0 to z1."""
    return Pos(x, y, z0) * Cylinder(d / 2, z1 - z0, align=_MIN)


def ring(x: float, y: float, z0: float, z1: float, od: float, id_: float) -> Shape:
    return cyl(x, y, z0, z1, od).cut(cyl(x, y, z0 - 1, z1 + 1, id_))


def one(result) -> Shape:
    """Boolean results can come back as a ShapeList; wrap those in a Compound."""
    if isinstance(result, ShapeList):
        return result[0] if len(result) == 1 else Compound(list(result))
    return result


def fuse(*shapes: Shape) -> Shape:
    first, *rest = shapes
    return one(first.fuse(*rest)).clean() if rest else first


def cut(shape: Shape, *tools: Shape) -> Shape:
    return one(shape.cut(*tools)).clean() if tools else shape


def common(a: Shape, b: Shape) -> Shape | None:
    """Intersection of two shapes, or None when they do not overlap."""
    result = a.intersect(b)
    if result is None or (isinstance(result, ShapeList) and not result):
        return None
    return one(result)


# --- Checks ------------------------------------------------------------------------------


def validate(p: Params = P) -> None:
    """Raise ValueError when parameters would give a part that cannot work."""
    lay = layout(p)
    problems = []
    if p.floor_t + p.collar_h >= lay.z_fan - p.duct_tip_gap:
        problems.append("intake collar reaches the fan; lower collar_h")
    for name, reach, extra in (("intake", p.intake_reach, 0.0), ("exhaust", p.exhaust_reach, p.socket_h)):
        duct_id = p.intake_duct_id if name == "intake" else p.exhaust_duct_id
        need = p.vent_ring_h + (p.vent_open_d - duct_id) / 2 + extra + 1.0
        if reach < need:
            problems.append(f"{name}_reach must be at least {need:.1f} mm for the cone and socket")
    socket_r = lay.socket_id / 2 + p.socket_wall
    if abs(lay.exhaust_y) + socket_r > lay.outer_y / 2:
        problems.append("exhaust socket hangs off the lid")
    # Port cutouts must sit inside the notch.
    half = p.port_notch_w / 2
    for name, (x, h), (w, ht) in (
        ("dc", p.dc_pos, (p.dc_hole_d + 4, p.dc_hole_d + 4)),
        ("rj45", p.rj45_pos, (p.rj45_screw_pitch + p.m3_clear_d + 2, p.rj45_cut[1])),
        ("usb", p.usb_pos, (p.usb_screw_pitch + p.m3_clear_d + 2, p.usb_cut[1])),
    ):
        if abs(x) + w / 2 > half or h - ht / 2 < p.port_notch_bottom or h + ht / 2 > lay.panel_h:
            problems.append(f"{name} cutout falls outside the rear notch")
    # LED parts must clear the panel rails and fit the wall height.
    rail_x0 = lay.led_notch_w / 2 + 1.0
    for bx, bh in lay.led_bosses:
        if abs(bx) + p.led_boss_d / 2 > rail_x0 or bh - p.led_boss_d / 2 < 0 or bh + p.led_boss_d / 2 > lay.panel_h:
            problems.append("LED clamp boss hits a rail or leaves the panel")
    if lay.led_tube_od / 2 > rail_x0:
        problems.append("LED tube hits the panel rails")
    if lay.led_center_h - lay.led_pocket_d / 2 - p.led_notch_margin < 0:
        problems.append("LED window falls below the floor")
    if lay.led_center_h + lay.led_tube_od / 2 > lay.panel_h:
        problems.append("LED tube is taller than the wall")
    led_stack = p.led_panel_t + p.led_tube_h + p.led_clamp_t + p.m3_head_h + 1.0
    if led_stack > p.front_gap:
        problems.append("front_gap is too small for the LED stack")
    if led_mixing_gap(p) <= 0:
        problems.append("LEDs touch the diffuser; raise led_tube_h")
    if problems:
        raise ValueError("; ".join(problems))


def led_mixing_gap(p: Params = P) -> float:
    """Worst-case gap between the LED fronts and the diffuser.

    The ring PCB sits in a seat at the top of the light tube; its back face is
    led_pcb_t above the seat floor, and the LEDs reach at most led_ring_t from that face.
    """
    pcb_back = p.led_panel_t + p.led_tube_h - p.led_seat_depth + p.led_pcb_t
    return pcb_back - p.led_ring_t - p.diffuser_t


# --- Board keep-out ------------------------------------------------------------------------


def board_keepout(p: Params = P) -> Shape:
    """Space the inverted dev kit may occupy, minus the post zones around its holes.

    It uses the full verified 103 x 90.5 mm footprint for the whole stack height, which is
    larger than the real parts, so a positive distance to it is a safe clearance.
    """
    lay = layout(p)
    hx = p.kit_x / 2
    stack = box(-hx, hx, lay.env_y0, lay.env_y1, lay.z_fan, lay.z_env_top)
    zones = [cyl(x, y, lay.z_fan - 1, lay.z_env_top + 1, p.post_d + 2 * p.post_zone_clr) for x, y in lay.holes]
    return cut(stack, *zones)


# --- Parts -----------------------------------------------------------------------------------


def _rails(p: Params, lay: Layout, notch_w: float, rear: bool) -> list[Shape]:
    """Two L-shaped rails that hold a slide-in panel against the inside of a wall."""
    sign = 1 if rear else -1
    y_wall = sign * lay.inner_y / 2
    slot_x = notch_w / 2 + p.panel_overlap + p.slot_clr
    depth = p.panel_t + p.slot_clr
    rails = []
    for s in (-1, 1):
        xa, xb = sorted((s * (notch_w / 2 + 1.0), s * (slot_x + p.rail_t)))
        ya, yb = sorted((y_wall, y_wall - sign * (depth + p.rail_t)))
        block = box(xa, xb, ya, yb, p.floor_t - 0.01, lay.z_rim)
        sa, sb = sorted((y_wall + sign * 1.0, y_wall - sign * depth))
        slot = box(-slot_x, slot_x, sa, sb, p.floor_t - 1, lay.z_rim + 1)
        rails.append(cut(block, slot))
    return rails


def base(p: Params = P) -> Shape:
    """Tub with floor, walls, board posts, intake collar, panel rails and strap tabs."""
    lay = layout(p)
    inner_r = max(p.corner_r - p.wall_t, 0.8)
    outer = extrude(RectangleRounded(lay.outer_x, lay.outer_y, p.corner_r), lay.z_rim)
    inner = Pos(0, 0, p.floor_t) * extrude(RectangleRounded(lay.inner_x, lay.inner_y, inner_r), lay.z_rim)
    body = outer.cut(inner)

    adds: list[Shape] = []
    holes: list[Shape] = []

    # Board posts with a conical foot and an insert at the top.
    for x, y in lay.holes:
        foot_h = lay.z_fan - 1.0 - p.floor_t
        adds.append(Pos(x, y, p.floor_t - 0.01) * Cone(p.post_foot_d / 2, p.post_d / 2, foot_h, align=_MIN))
        adds.append(cyl(x, y, p.floor_t - 0.01, lay.z_comp, p.post_d))
        holes.append(cyl(x, y, lay.z_comp - p.insert_depth, lay.z_comp + 1, p.board_insert_hole_d))

    # Intake collar and the hole through the floor.
    fx, fy = lay.fan_xy
    adds.append(ring(fx, fy, p.floor_t - 0.01, p.floor_t + p.collar_h, lay.collar_id + 2 * p.collar_wall, lay.collar_id))
    holes.append(cyl(fx, fy, -1, p.floor_t + p.collar_h + 1, lay.collar_id))

    # Lid screw bosses.
    for x, y in lay.corner_bosses:
        adds.append(cyl(x, y, p.floor_t - 0.01, lay.z_rim, p.corner_boss_d))
        holes.append(cyl(x, y, lay.z_rim - p.insert_depth, lay.z_rim + 1, p.insert_hole_d))

    # Rails for the rear port panel and the front LED panel.
    adds += _rails(p, lay, p.port_notch_w, rear=True)
    adds += _rails(p, lay, lay.led_notch_w, rear=False)

    # Strap and screw tabs at floor level on both side walls.
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx = sx * (lay.outer_x / 2 + p.tab_l / 2 - 1.0)
            cy = sy * (lay.outer_y / 2 - p.tab_end_inset)
            tab = Pos(cx, cy, 0) * extrude(RectangleRounded(p.tab_l + 2.0, p.tab_w, p.tab_r), p.tab_t)
            adds.append(tab)
            slot_x = sx * (lay.outer_x / 2 + 2.0 + p.strap_slot[0] / 2)
            holes.append(box(slot_x - p.strap_slot[0] / 2, slot_x + p.strap_slot[0] / 2,
                             cy - p.strap_slot[1] / 2, cy + p.strap_slot[1] / 2, -1, p.tab_t + 1))
            hole_x = sx * (lay.outer_x / 2 + p.tab_l - 5.5)
            holes.append(cyl(hole_x, cy, -1, p.tab_t + 1, p.insert_hole_d))

    # Notches, open to the top so the panels slide in from above.
    rear_y = lay.inner_y / 2 + p.wall_t / 2
    holes.append(box(-p.port_notch_w / 2, p.port_notch_w / 2, rear_y - p.wall_t, rear_y + p.wall_t,
                     p.floor_t + p.port_notch_bottom, lay.z_rim + 1))
    led_bottom = p.floor_t + lay.led_center_h - lay.led_pocket_d / 2 - p.led_notch_margin
    holes.append(box(-lay.led_notch_w / 2, lay.led_notch_w / 2, -rear_y - p.wall_t, -rear_y + p.wall_t,
                     led_bottom, lay.z_rim + 1))

    return cut(fuse(body, *adds), *holes)


def lid(p: Params = P) -> Shape:
    """Flat lid with the exhaust socket; printed top face up."""
    lay = layout(p)
    plate = extrude(RectangleRounded(lay.outer_x, lay.outer_y, p.corner_r), p.lid_t)
    socket_od = lay.socket_id + 2 * p.socket_wall
    sock = ring(0, lay.exhaust_y, p.lid_t - 0.01, p.lid_t + p.socket_h, socket_od, lay.socket_id)
    holes = [cyl(0, lay.exhaust_y, -1, p.lid_t + 1, p.exhaust_duct_id)]
    for x, y in lay.corner_bosses:
        holes.append(cyl(x, y, -1, p.lid_t + 1, p.m3_clear_d))
        holes.append(cyl(x, y, p.lid_t - p.m3_head_h, p.lid_t + 1, p.m3_head_d))
    return cut(fuse(plate, sock), *holes)


def _panel_plate(width: float, height: float, t: float) -> Shape:
    """Flat plate in panel coordinates: x across, y = height above the floor, z = thickness."""
    return box(-width / 2, width / 2, 0, height, 0, t)


def port_panel(p: Params = P) -> Shape:
    """Rear panel for panel-mount power, Ethernet and USB extension cables."""
    lay = layout(p)
    plate = _panel_plate(lay.port_panel_w - 2 * p.slot_clr, lay.panel_h, p.panel_t)
    t = p.panel_t
    holes = [cyl(p.dc_pos[0], p.dc_pos[1], -1, t + 1, p.dc_hole_d)]
    for (x, h), (w, ht), pitch in ((p.rj45_pos, p.rj45_cut, p.rj45_screw_pitch), (p.usb_pos, p.usb_cut, p.usb_screw_pitch)):
        holes.append(box(x - w / 2, x + w / 2, h - ht / 2, h + ht / 2, -1, t + 1))
        for s in (-1, 1):
            holes.append(cyl(x + s * pitch / 2, h, -1, t + 1, p.m3_clear_d))
    return cut(plate, *holes)


def led_panel(p: Params = P) -> Shape:
    """Front panel with the diffuser pocket, light tube and LED ring seat.

    Printed outer face down; the diffuser pocket is on the bed side.
    """
    lay = layout(p)
    h = lay.led_center_h
    top = p.led_panel_t + p.led_tube_h
    plate = _panel_plate(lay.led_panel_w - 2 * p.slot_clr, lay.panel_h, p.led_panel_t)
    tube = cyl(0, h, p.led_panel_t - 0.01, top, lay.led_tube_od)
    bosses = [cyl(x, y, p.led_panel_t - 0.01, top, p.led_boss_d) for x, y in lay.led_bosses]
    holes = [
        cyl(0, h, -1, top + 1, lay.led_window_d),
        cyl(0, h, -1, p.diffuser_t, lay.led_pocket_d),
        cyl(0, h, top - p.led_seat_depth, top + 1, lay.led_seat_d),
    ]
    holes += [cyl(x, y, top - p.insert_depth, top + 1, p.insert_hole_d) for x, y in lay.led_bosses]
    return cut(fuse(plate, tube, *bosses), *holes)


def led_clamp(p: Params = P) -> Shape:
    """C-shaped clamp that holds the LED ring in its seat (panel coordinates, flat)."""
    lay = layout(p)
    h = lay.led_center_h
    t = p.led_clamp_t
    od = lay.led_tube_od
    body = ring(0, h, 0, t, od, p.led_ring_id + 2.0)
    ears = []
    for x, y in lay.led_bosses:
        ears.append(cyl(x, y, 0, t, p.led_boss_d))
        mx, my = x / 2, h + (y - h) / 2
        length = math.hypot(x, y - h)
        angle = math.degrees(math.atan2(y - h, x))
        ears.append(Pos(mx, my, t / 2) * Rot(0, 0, angle) * Box(length, p.led_boss_d, t))
    holes = [cyl(x, y, -1, t + 1, p.m3_clear_d) for x, y in lay.led_bosses]
    holes.append(cyl(0, h, -1, t + 1, p.led_ring_id + 2.0))
    # Wire notch at the top, between the two ears.
    holes.append(box(-p.led_wire_notch_w / 2, p.led_wire_notch_w / 2, h, h + od, -1, t + 1))
    return cut(fuse(body, *ears), *holes)


def diffuser(p: Params = P) -> Shape:
    """2 mm diffuser disc; print in white or natural PETG at 100 percent infill."""
    lay = layout(p)
    return cyl(0, lay.led_center_h, 0, p.diffuser_t, lay.led_pocket_d - 2 * p.fit_clr)


def mesh_slots(p: Params = P) -> Shape:
    """Open area of a vent ring grille, as a solid one grille thick."""
    r = p.vent_open_d / 2 - p.mesh_margin
    pitch = p.mesh_slot_w + p.mesh_rib_w
    n = int((2 * r) // pitch) + 2
    slots = [box(-p.mesh_slot_w / 2 + (i - n / 2) * pitch, p.mesh_slot_w / 2 + (i - n / 2) * pitch,
                 -r - 1, r + 1, 0, p.grille_t) for i in range(n + 1)]
    region = common(fuse(*slots), cyl(0, 0, 0, p.grille_t, 2 * r))
    return cut(region, box(-r - 1, r + 1, -p.mesh_cross_rib_w / 2, p.mesh_cross_rib_w / 2, -1, p.grille_t + 1))


def duct(p: Params = P, kind: str = "intake") -> Shape:
    """Duct with a round vent ring, mesh grille and sewing flange, printed flange down."""
    lay = layout(p)
    duct_id = p.intake_duct_id if kind == "intake" else p.exhaust_duct_id
    length = lay.z_fan - p.duct_tip_gap + p.intake_reach if kind == "intake" else p.exhaust_reach
    w = p.duct_wall
    ro = p.vent_open_d / 2
    ri = duct_id / 2
    rh = p.vent_ring_h
    dz = ro - ri  # 45 degree cone height
    k = w * (math.sqrt(2) - 1)
    profile = [
        (ro + w, 0), (ro + w, rh + k), (ri + w, rh + dz + k), (ri + w, length),
        (ri, length), (ri, rh + dz), (ro, rh), (ro, 0),
    ]
    wall = revolve(Plane.XZ * Polygon(*profile, align=None), Axis.Z)
    flange_od = 2 * (ro + w + p.vent_flange_w)
    flange = ring(0, 0, 0, p.vent_flange_t, flange_od, 2 * ro + 0.02)
    grille = cut(cyl(0, 0, 0, p.grille_t, 2 * ro + 0.02), mesh_slots(p))
    sew_r = ro + w + p.vent_flange_w / 2
    n = max(8, int(2 * math.pi * sew_r // p.sew_hole_pitch))
    sew = [cyl(sew_r * math.cos(2 * math.pi * i / n), sew_r * math.sin(2 * math.pi * i / n),
               -1, p.vent_flange_t + 1, p.sew_hole_d) for i in range(n)]
    return cut(fuse(wall, flange, grille), *sew)


def build_all(p: Params = P) -> dict[str, Shape]:
    """Every printed part, in print orientation."""
    validate(p)
    return {
        "base": base(p),
        "lid": lid(p),
        "port_panel": port_panel(p),
        "led_panel": led_panel(p),
        "led_clamp": led_clamp(p),
        "diffuser": diffuser(p),
        "intake_duct": duct(p, "intake"),
        "exhaust_duct": duct(p, "exhaust"),
    }


def assembly(parts: dict[str, Shape], p: Params = P) -> dict[str, Shape]:
    """Place print-oriented parts where they sit in the assembled core."""
    lay = layout(p)
    rear = Pos(0, lay.inner_y / 2, p.floor_t) * Rot(90, 0, 0)
    front = Pos(0, -lay.inner_y / 2, p.floor_t) * Rot(0, 0, 180) * Rot(90, 0, 0)
    clamp_z = p.led_panel_t + p.led_tube_h
    return {
        "base": parts["base"],
        "lid": Pos(0, 0, lay.z_rim) * parts["lid"],
        "port_panel": rear * parts["port_panel"],
        "led_panel": front * parts["led_panel"],
        "led_clamp": front * Pos(0, 0, clamp_z) * parts["led_clamp"],
        "diffuser": front * parts["diffuser"],
        "intake_duct": Pos(*lay.fan_xy, -p.intake_reach) * parts["intake_duct"],
        "exhaust_duct": Pos(0, lay.exhaust_y, lay.z_lid_top + p.exhaust_reach) * Rot(180, 0, 0) * parts["exhaust_duct"],
    }


# --- Reports -------------------------------------------------------------------------------


def clearances(p: Params = P) -> dict[str, float]:
    """Designed gaps between the board keep-out and the core, in mm. All must be positive."""
    lay = layout(p)
    led_reach = p.led_panel_t + p.led_tube_h + p.led_clamp_t + p.m3_head_h
    return {
        "side_gap": p.side_gap,
        "front_gap_after_led_stack": p.front_gap - led_reach,
        "cable_bay_after_panel": p.cable_bay - p.panel_t - p.slot_clr - p.rail_t,
        "lid_to_bottom_face_parts": lay.z_rim - lay.z_env_top,
        "intake_tip_to_fan": p.duct_tip_gap,
        "collar_to_fan": lay.z_fan - (p.floor_t + p.collar_h),
        "post_to_board_parts": p.post_zone_clr,
        "led_to_diffuser": led_mixing_gap(p),
    }


def airflow(p: Params = P) -> dict[str, float]:
    """Open areas along the air path compared with the fan (mm^2 and ratios)."""
    lay = layout(p)
    fan_bore = math.pi * p.fan_bore_d**2 / 4
    fan_swept = fan_bore - math.pi * p.fan_hub_d**2 / 4
    mesh_open = mesh_slots(p).volume / p.grille_t
    intake_bore = math.pi * p.intake_duct_id**2 / 4
    exhaust_bore = math.pi * p.exhaust_duct_id**2 / 4
    bay = (p.cable_bay - p.panel_t - p.slot_clr - p.rail_t) * lay.inner_x
    risers = bay + 2 * p.side_gap * p.kit_y + (p.front_gap - p.led_panel_t - p.led_tube_h) * lay.inner_x
    headroom = p.top_headroom * lay.inner_x
    areas = {
        "fan_bore_area": fan_bore,
        "fan_swept_area": fan_swept,
        "vent_mesh_open_area": mesh_open,
        "intake_duct_bore": intake_bore,
        "exhaust_duct_bore": exhaust_bore,
        "riser_area_around_board": risers,
        "headroom_cross_section": headroom,
    }
    for key in ("vent_mesh_open_area", "intake_duct_bore", "exhaust_duct_bore",
                "riser_area_around_board", "headroom_cross_section"):
        areas[f"{key}_vs_fan_bore"] = areas[key] / fan_bore
    return areas


def print_size(shape: Shape) -> tuple[float, float, float]:
    s = shape.bounding_box().size
    return (s.X, s.Y, s.Z)


def report(p: Params = P, parts: dict[str, Shape] | None = None) -> str:
    parts = parts or build_all(p)
    lay = layout(p)
    lines = ["Muse core report (generated by: cd hardware/enclosure && uv run python core.py)", ""]
    lines.append(f"Core outside: {lay.outer_x:.1f} x {lay.outer_y:.1f} x {lay.z_lid_top:.1f} mm (without ducts and tabs)")
    lines.append("")
    lines.append("Part sizes in print orientation (bed limit 220 x 220 mm):")
    for name, shape in parts.items():
        x, y, z = print_size(shape)
        lines.append(f"  {name:13s} {x:6.1f} x {y:6.1f} x {z:5.1f} mm   volume {shape.volume / 1000:6.1f} cm^3")
    lines.append("")
    lines.append("Clearances (mm):")
    for k, v in clearances(p).items():
        lines.append(f"  {k:28s} {v:6.2f}")
    lines.append("")
    lines.append("Air path (mm^2, ratio to the fan bore area):")
    for k, v in airflow(p).items():
        lines.append(f"  {k:40s} {v:8.2f}")
    return "\n".join(lines) + "\n"


def export(out_dir: Path = OUT_DIR, p: Params = P) -> dict[str, Shape]:
    """Write one STL per part (print orientation) and one assembled STEP."""
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = build_all(p)
    for name, shape in parts.items():
        export_stl(shape, str(out_dir / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.1)
    placed = assembly(parts, p)
    children = []
    for name, shape in placed.items():
        shape.label = name
        children.append(shape)
    keepout = board_keepout(p)
    keepout.label = "REFERENCE_board_keepout_do_not_print"
    children.append(keepout)
    export_step(Compound(children=children, label="muse_core"), str(out_dir / "muse_core_assembly.step"))
    (out_dir / "report.txt").write_text(report(p, parts))
    return parts


def with_ring(pixels: int, p: Params = P) -> Params:
    """Params for a 12 or 16 pixel Adafruit-size ring."""
    sizes = {12: (36.8, 23.3), 16: (44.5, 31.7)}
    od, id_ = sizes[pixels]
    return replace(p, led_ring_od=od, led_ring_id=id_)


if __name__ == "__main__":
    built = export()
    print(report(P, built))
