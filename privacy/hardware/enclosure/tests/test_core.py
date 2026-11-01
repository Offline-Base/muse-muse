"""Rebuild every part and check bed fit, board clearance, collisions and airflow."""

from __future__ import annotations

import itertools
from dataclasses import replace

import pytest
import trimesh

import core

PART_NAMES = {
    "base",
    "lid",
    "port_panel",
    "led_panel",
    "led_clamp",
    "diffuser",
    "intake_duct",
    "exhaust_duct",
}


def overlap(a, b) -> float:
    shared = core.common(a, b)
    return 0.0 if shared is None else shared.volume


@pytest.fixture(scope="module")
def parts():
    return core.build_all()


@pytest.fixture(scope="module")
def placed(parts):
    return core.assembly(parts)


@pytest.fixture(scope="module")
def keepout():
    return core.board_keepout()


def test_every_part_is_a_single_valid_solid(parts):
    assert set(parts) == PART_NAMES
    for name, shape in parts.items():
        assert shape.is_valid, name
        assert len(shape.solids()) == 1, name
        assert shape.volume > 100, name


def test_every_part_fits_a_220_mm_bed(parts):
    for name, shape in parts.items():
        x, y, z = core.print_size(shape)
        assert x <= core.P.bed_x and y <= core.P.bed_y, f"{name} is {x:.1f} x {y:.1f} mm"
        assert z <= core.P.max_print_z, name
        assert abs(shape.bounding_box().min.Z) < 1e-6, f"{name} does not sit on the bed"


def test_board_clearance_is_positive(placed, keepout):
    for name, shape in placed.items():
        assert overlap(shape, keepout) < 1e-6, f"{name} enters the board keep-out"
        assert shape.distance_to(keepout) > 0, f"{name} touches the board keep-out"


def test_designed_clearances_are_positive():
    for name, gap in core.clearances().items():
        assert gap > 0, name


def test_overlap_check_detects_a_real_collision(keepout):
    lay = core.layout()
    probe = core.box(-5, 5, lay.env_cy - 5, lay.env_cy + 5, lay.z_comp - 5, lay.z_comp + 5)
    assert overlap(probe, keepout) > 100


def test_assembled_parts_do_not_collide(placed):
    for (a, sa), (b, sb) in itertools.combinations(placed.items(), 2):
        assert overlap(sa, sb) < 1e-3, f"{a} collides with {b}"


def test_fan_is_never_starved():
    air = core.airflow()
    assert air["vent_mesh_open_area_vs_fan_bore"] >= 1.5
    assert air["intake_duct_bore_vs_fan_bore"] >= 1.0
    assert air["exhaust_duct_bore_vs_fan_bore"] >= 1.0
    assert air["riser_area_around_board_vs_fan_bore"] >= 1.5
    assert air["headroom_cross_section_vs_fan_bore"] >= 1.0


def test_twelve_pixel_ring_variant_builds_and_clears():
    p = core.with_ring(12)
    parts = core.build_all(p)
    placed = core.assembly(parts, p)
    keepout = core.board_keepout(p)
    for name in ("led_panel", "led_clamp", "diffuser"):
        assert overlap(placed[name], keepout) < 1e-6
        assert placed[name].distance_to(keepout) > 0
    assert core.layout(p).led_window_d < core.layout().led_window_d


@pytest.mark.parametrize(
    "change",
    [
        {"intake_reach": 5.0},
        {"exhaust_reach": 10.0},
        {"front_gap": 8.0},
        {"collar_h": 9.0},
        {"led_tube_h": 2.0},
        {"dc_pos": (-40.0, 26.0)},
    ],
)
def test_impossible_parameters_are_rejected(change):
    with pytest.raises(ValueError):
        core.validate(replace(core.P, **change))


def test_export_writes_watertight_stls_and_one_step(tmp_path):
    core.export(tmp_path)
    for name in PART_NAMES:
        mesh = trimesh.load(tmp_path / f"{name}.stl")
        assert mesh.is_watertight, name
    step = tmp_path / "muse_core_assembly.step"
    assert step.stat().st_size > 10_000
    assert "Air path" in (tmp_path / "report.txt").read_text()
