"""GAP-19: a .synthetic folder is cloud-readable only while its manifest lists every file in it."""

import json
import os
import subprocess

import pytest

from base import config, manifest
from base.config import CloudBackendRefused, assert_synthetic, load_settings, synthetic_marked
from base.workspace.agent import is_marked
from base.workspace.index import DocumentIndex
from scripts import make_manifest
from tests.synthetic_helpers import mark_synthetic


def class_folder(tmp_path):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    (root / "essays" / "a.md").write_text("# A\nTide pools hold crabs.\n")
    (root / "rubric.md").write_text("# Rubric\n- Ideas\n")
    mark_synthetic(root)
    return root


def cloud(tmp_path, root):
    return load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "OPENROUTER_API_KEY": "k"})


def device_only(tmp_path, root):
    return load_settings(
        {"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "GLIMMER_BACKEND": "llama_server"}
    )


def test_marker_names_agree():
    assert manifest.MARKER_NAME == config.SYNTHETIC_MARKER


def test_a_listed_file_passes(tmp_path):
    root = class_folder(tmp_path)
    s = cloud(tmp_path, root)
    assert_synthetic(s, root)
    assert_synthetic(s, root / "essays")
    assert synthetic_marked(root / "essays", root) and is_marked(root / "essays", root)
    assert [d.id for d in DocumentIndex(s).list("essays")] == ["essays/a.md"]


def test_a_stray_file_is_refused_with_a_count_and_no_name(tmp_path):
    root = class_folder(tmp_path)
    (root / "Real Person resume.pdf").write_bytes(b"%PDF")
    (root / "essays" / "Another Person.md").write_text("# Real\n")
    s = cloud(tmp_path, root)
    with pytest.raises(CloudBackendRefused) as caught:
        assert_synthetic(s, root / "essays")  # a stray file anywhere under the marker revokes it
    message = str(caught.value)
    assert "2 files in this folder are not in its .synthetic-manifest.json" in message
    assert "Real Person" not in message and "Another Person" not in message and "resume" not in message
    assert not synthetic_marked(root / "essays", root) and not is_marked(root / "essays", root)
    with pytest.raises(CloudBackendRefused):
        DocumentIndex(s).list("essays")


def test_a_changed_file_is_refused(tmp_path):
    root = class_folder(tmp_path)
    (root / "essays" / "a.md").write_text("# A\nA real student's essay, pasted over the invented one.\n")
    with pytest.raises(CloudBackendRefused, match="1 file in this folder is not"):
        assert_synthetic(cloud(tmp_path, root), root)


def test_a_missing_or_broken_manifest_is_refused(tmp_path):
    root = class_folder(tmp_path)
    path = root / manifest.MANIFEST_NAME
    s = cloud(tmp_path, root)
    for text in ("not json", json.dumps({"version": 2, "files": {}}), json.dumps({"version": 1, "files": {"a": "x"}})):
        path.write_text(text)
        with pytest.raises(CloudBackendRefused, match="no readable .synthetic-manifest.json"):
            assert_synthetic(s, root)
    path.unlink()
    with pytest.raises(CloudBackendRefused, match="no readable"):
        assert_synthetic(s, root)


def test_a_listed_file_that_is_gone_still_passes(tmp_path):
    root = class_folder(tmp_path)
    (root / "rubric.md").unlink()
    assert_synthetic(cloud(tmp_path, root), root)


def test_finder_metadata_is_ignored_but_other_hidden_files_count(tmp_path):
    root = class_folder(tmp_path)
    (root / ".DS_Store").write_bytes(b"\0Bud1")
    s = cloud(tmp_path, root)
    assert_synthetic(s, root)
    (root / "essays" / ".notes.md").write_text("hidden, but a reader could still open it\n")
    with pytest.raises(CloudBackendRefused, match="1 file"):
        assert_synthetic(s, root)


def test_links_count_as_the_file_they_lead_to(tmp_path):
    root = class_folder(tmp_path)
    s = cloud(tmp_path, root)
    os.symlink(root / "rubric.md", root / "essays" / "rubric-link.md")
    assert_synthetic(s, root)  # its target is listed inside the folder
    outside = tmp_path / "outside.md"
    outside.write_text("real\n")
    os.symlink(outside, root / "essays" / "out.md")
    with pytest.raises(CloudBackendRefused, match="1 file"):
        assert_synthetic(s, root)


def test_device_only_ignores_the_manifest(tmp_path):
    root = class_folder(tmp_path)
    (root / "essays" / "stray.md").write_text("# Stray\nNot listed.\n")
    (root / manifest.MANIFEST_NAME).unlink()
    s = device_only(tmp_path, root)
    assert not s.is_cloud_backend
    assert_synthetic(s, root / "essays")
    assert sorted(d.id for d in DocumentIndex(s).list("essays")) == ["essays/a.md", "essays/stray.md"]
    local = load_settings({"BASE_HOME": str(tmp_path / "h2"), "WORKSPACE_ROOT": str(root), "GLIMMER_BACKEND": "llama_server"})
    assert_synthetic(local, root)


def test_hashes_are_rechecked_after_a_change(tmp_path):
    root = class_folder(tmp_path)
    s = cloud(tmp_path, root)
    assert_synthetic(s, root)  # fills the hash cache
    before = (root / "rubric.md").read_text()
    (root / "rubric.md").write_text(before + "- Evidence\n")
    with pytest.raises(CloudBackendRefused):
        assert_synthetic(s, root)
    (root / "rubric.md").write_text(before)
    assert_synthetic(s, root)


def test_entries_refuse_paths_out_of_the_folder_and_links(tmp_path):
    root = class_folder(tmp_path)
    with pytest.raises(ValueError):
        manifest.entries(root, ["../outside.md"])
    os.symlink(root / "rubric.md", root / "link.md")
    with pytest.raises(ValueError):
        manifest.entries(root, ["link.md"])
    assert manifest.entries(root, [".synthetic", "rubric.md"]).keys() == {"rubric.md"}


# scripts/make_manifest.py


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, timeout=30)


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    folder = repo / "demo"
    (folder / "essays").mkdir(parents=True)
    (folder / ".synthetic").write_text("")
    (folder / "essays" / "a.md").write_text("# A\nInvented.\n")
    (folder / "rubric.md").write_text("# Rubric\n")
    git(repo, "init", "-q")
    git(repo, "add", "demo")
    (folder / "essays" / "untracked.md").write_text("# Not tracked\n")
    (folder / "excluded.pdf").write_bytes(b"%PDF")
    (repo / ".git" / "info" / "exclude").write_text("demo/excluded.pdf\n")
    return repo


def test_generator_lists_tracked_files_only(repo, capsys):
    assert make_manifest.main([], repo=repo) == 0
    listed = manifest.read_manifest(repo / "demo")
    assert set(listed) == {"essays/a.md", "rubric.md"}
    out = capsys.readouterr().out
    assert "demo: wrote .synthetic-manifest.json (2 files)" in out and "untracked" not in out
    # so the untracked and excluded files keep the folder off a cloud model
    s = load_settings({"BASE_HOME": str(repo.parent / "h"), "WORKSPACE_ROOT": str(repo / "demo"), "OPENROUTER_API_KEY": "k"})
    with pytest.raises(CloudBackendRefused, match="2 files"):
        assert_synthetic(s, repo / "demo")
    (repo / "demo" / "essays" / "untracked.md").unlink()
    (repo / "demo" / "excluded.pdf").unlink()
    assert_synthetic(s, repo / "demo")


def test_generator_skips_tracked_links_and_checks(repo, capsys):
    os.symlink("rubric.md", repo / "demo" / "link.md")
    git(repo, "add", "demo/link.md")
    assert make_manifest.main(["demo"], repo=repo) == 0
    assert "link.md" not in manifest.read_manifest(repo / "demo")
    assert make_manifest.main(["--check"], repo=repo) == 0
    (repo / "demo" / "rubric.md").write_text("# Rubric, edited\n")
    assert make_manifest.main(["--check"], repo=repo) == 1
    assert "demo: out of date" in capsys.readouterr().out
    assert make_manifest.main(["elsewhere"], repo=repo) == 2


def test_committed_manifests_are_current():
    try:
        folders = make_manifest.marked_folders()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
    names = {f.relative_to(config.REPO_ROOT).as_posix() for f in folders}
    assert {"demo", "tests/fixtures/workspace"} <= names
    for folder in folders:
        assert manifest.read_manifest(folder) == make_manifest.fresh(folder), folder.name
