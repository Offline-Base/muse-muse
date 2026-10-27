import os
import shutil
from pathlib import Path

import pytest

from base.config import CloudBackendRefused, load_settings
from base.workspace.index import SNIPPET_CHARS, DocumentIndex, WorkspacePathError, snippet

FIXTURE = Path(__file__).parent / "fixtures" / "workspace"


def make_settings(tmp_path, root, backend="openrouter"):
    return load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "GLIMMER_BACKEND": backend,
            "OPENROUTER_API_KEY": "test-key",
            "WORKSPACE_ROOT": str(root),
        }
    )


@pytest.fixture
def index(tmp_path):
    return DocumentIndex(make_settings(tmp_path, FIXTURE))


@pytest.fixture
def copy_root(tmp_path):
    root = tmp_path / "root"
    shutil.copytree(FIXTURE, root)
    return root


def test_list_shows_only_md_and_txt(tmp_path, copy_root):
    (copy_root / "essays" / "scan.pdf").write_bytes(b"%PDF")
    (copy_root / "essays" / ".hidden.md").write_text("hidden")
    (copy_root / "essays" / "notes.docx").write_text("x")
    docs = DocumentIndex(make_settings(tmp_path, copy_root)).list("essays")
    assert sorted(d.id for d in docs) == [
        "essays/Corwin Ashgrove.md",
        "essays/Tavi Brennick essay.md",
        "essays/essay-02.txt",
        "essays/rubric.md",
    ]


def test_doc_fields_are_relative(index):
    docs = {d.id: d for d in index.list("essays")}
    corwin = docs["essays/Corwin Ashgrove.md"]
    assert corwin.title == "The Lighthouse Robot"
    assert docs["essays/essay-02.txt"].title == "essay-02"
    assert corwin.path == corwin.id and not Path(corwin.path).is_absolute()
    assert corwin.size > 100 and corwin.modified > 0


def test_root_listing_and_read(index):
    assert len(index.list(None)) == len(index.list(".")) == 4
    assert "salamanders" in index.read("essays/essay-02.txt")


@pytest.mark.parametrize(
    "bad", ["..", "../", "essays/../..", "../etc", "/etc", "/", "~", "~/notes", "C:\\Users", "essays\\..\\.."]
)
def test_path_traversal_rejected(index, bad):
    with pytest.raises(WorkspacePathError):
        index.list(bad)
    with pytest.raises(WorkspacePathError):
        index.read(bad)
    with pytest.raises(WorkspacePathError):
        index.search("garden", folder=bad)


def test_read_rejects_hidden_and_other_types(index):
    with pytest.raises(FileNotFoundError):
        index.read(".synthetic")
    with pytest.raises(FileNotFoundError):
        index.read("essays/missing.md")


def test_symlinks_out_of_root_rejected(tmp_path, copy_root):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / ".synthetic").write_text("")
    (outside / "secret.md").write_text("# Secret\nkeep out")
    os.symlink(outside, copy_root / "linked")
    os.symlink(outside / "secret.md", copy_root / "essays" / "secret.md")
    idx = DocumentIndex(make_settings(tmp_path, copy_root))
    with pytest.raises(WorkspacePathError):
        idx.list("linked")
    with pytest.raises(WorkspacePathError):
        idx.read("essays/secret.md")
    assert "essays/secret.md" not in {d.id for d in idx.list("essays")}
    assert all("keep out" not in s.text for s in idx.search("secret keep out"))


def test_symlink_inside_root_is_fine(tmp_path, copy_root):
    os.symlink(copy_root / "essays" / "rubric.md", copy_root / "rubric-link.md")
    idx = DocumentIndex(make_settings(tmp_path, copy_root))
    assert "Organization" in idx.read("rubric-link.md")


def test_cloud_backend_refuses_unmarked_folder(tmp_path):
    root = tmp_path / "private"
    (root / "class").mkdir(parents=True)
    (root / "class" / "essay.md").write_text("# Essay\ntext")
    idx = DocumentIndex(make_settings(tmp_path, root))
    with pytest.raises(CloudBackendRefused):
        idx.list("class")
    with pytest.raises(CloudBackendRefused):
        idx.read("class/essay.md")
    with pytest.raises(CloudBackendRefused):
        idx.search("essay")


def test_local_backend_reads_unmarked_folder(tmp_path):
    root = tmp_path / "private"
    (root / "class").mkdir(parents=True)
    (root / "class" / "essay.md").write_text("# Essay\ntext")
    idx = DocumentIndex(make_settings(tmp_path, root, backend="llama_server"))
    assert [d.id for d in idx.list("class")] == ["class/essay.md"]


@pytest.mark.parametrize(
    "query, expected",
    [
        ("salamanders in the creek", "essays/essay-02.txt"),
        ("garden compost tomatoes", "essays/Tavi Brennick essay.md"),
        ("robot lighthouse lamp", "essays/Corwin Ashgrove.md"),
        ("conventions spelling capitals", "essays/rubric.md"),
    ],
)
def test_bm25_ranks_right_doc_first(index, query, expected):
    results = index.search(query, k=5)
    assert results[0].doc_id == expected
    assert results == sorted(results, key=lambda s: -s.score)


def test_search_limits_and_snippets(index):
    results = index.search("creek", k=1)
    assert len(results) == 1
    hit = results[0]
    assert hit.title == "essay-02"
    assert "creek" in hit.text.lower()
    assert len(hit.text) <= SNIPPET_CHARS + 10
    assert "\n" not in hit.text


def test_search_with_no_terms_or_matches(index):
    assert index.search("") == []
    assert index.search("the and of") == []
    assert index.search("zeppelin") == []


def test_snippet_centers_on_densest_match():
    filler = "word " * 200
    text = filler + "the salamander hid under a rock near another salamander " + filler
    out = snippet(text, ["salamander"])
    assert "salamander hid" in out
    assert out.startswith("...") and out.endswith("...")
    assert len(out) <= SNIPPET_CHARS + 6
    assert snippet("short text", ["text"]) == "short text"


def test_title_is_linear_on_long_runs_of_spaces(tmp_path):
    # Review SEC-2: "# title" + thousands of spaces + "x" took seconds with the old pattern.
    import time

    from base.workspace.index import _title

    started = time.perf_counter()
    for line in ("# My summer" + " " * 100_000 + "trip", "#" + "\t" * 100_000 + "x", "# " + " " * 100_000):
        _title(tmp_path / "essay.md", line)
    assert time.perf_counter() - started < 0.5
    assert _title(tmp_path / "e.md", "# Title ##  ") == "Title"
    assert _title(tmp_path / "e.md", "intro\n## C#\n") == "C"
    assert _title(tmp_path / "e.md", "#### Deep\n") == "e"
    assert _title(tmp_path / "e.md", "#   \n# Real") == "Real"
