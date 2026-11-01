import dataclasses
import os
import shutil
import stat
from pathlib import Path

import pytest

from base.config import CloudBackendRefused, load_settings
from base.workspace.embed import EmbedError, chunks
from base.workspace.index import SNIPPET_CHARS, DocumentIndex, WorkspacePathError, snippet
from tests.synthetic_helpers import mark_synthetic

FIXTURE = Path(__file__).parent / "fixtures" / "workspace"


def make_settings(tmp_path, root, backend="openrouter", pdftotext=None):
    s = load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "GLIMMER_BACKEND": backend,
            "OPENROUTER_API_KEY": "test-key",
            "WORKSPACE_ROOT": str(root),
        }
    )
    return dataclasses.replace(s, pdftotext_bin=pdftotext)  # the same on machines with or without poppler


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
    mark_synthetic(copy_root)  # the cloud backend reads it only while every new file is listed
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
    for backend in ("openrouter", "llama_server"):
        idx = DocumentIndex(make_settings(tmp_path, copy_root, backend))
        with pytest.raises(WorkspacePathError):
            idx.list("linked")
        with pytest.raises(WorkspacePathError):
            idx.read("essays/secret.md")
    local = DocumentIndex(make_settings(tmp_path, copy_root, "llama_server"))
    assert "essays/secret.md" not in {d.id for d in local.list("essays")}
    assert all("keep out" not in s.text for s in local.search("secret keep out"))
    # On a cloud backend a link out is a file the manifest can never list, so the folder is refused.
    cloud = DocumentIndex(make_settings(tmp_path, copy_root))
    with pytest.raises(CloudBackendRefused):
        cloud.list("essays")
    with pytest.raises(CloudBackendRefused):
        cloud.search("secret keep out")


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


# PDFs (through pdftotext) and search by meaning (through an embedder)


@pytest.fixture
def fake_pdftotext(tmp_path):
    """A stand-in for poppler's pdftotext that prints a fixed text layer, and fails on 'bad.pdf'."""
    tool = tmp_path / "pdftotext"
    tool.write_text(
        "#!/bin/sh\n"
        'for a; do f="$a"; [ "$a" = "-" ] && break; prev="$a"; done\n'
        'case "$prev" in *bad.pdf) exit 1;; esac\n'
        "echo 'Resume of Corwin Ashgrove. Volunteer at the city aquarium, fed the sharks.'\n"
    )
    tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    return str(tool)


def test_pdfs_are_documents_when_pdftotext_is_installed(tmp_path, copy_root, fake_pdftotext):
    (copy_root / "essays" / "resume.pdf").write_bytes(b"%PDF")
    mark_synthetic(copy_root)
    index = DocumentIndex(make_settings(tmp_path, copy_root, pdftotext=fake_pdftotext))
    docs = {d.id: d for d in index.list("essays")}
    assert docs["essays/resume.pdf"].title == "resume"  # listing never runs the tool
    assert "fed the sharks" in index.read("essays/resume.pdf")
    hits = index.search("aquarium sharks", folder="essays")
    assert hits and hits[0].doc_id == "essays/resume.pdf"


def test_an_unreadable_pdf_is_skipped_in_search(tmp_path, copy_root, fake_pdftotext):
    (copy_root / "essays" / "bad.pdf").write_bytes(b"%PDF")
    mark_synthetic(copy_root)
    index = DocumentIndex(make_settings(tmp_path, copy_root, pdftotext=fake_pdftotext))
    assert all(h.doc_id != "essays/bad.pdf" for h in index.search("robot", folder="essays"))
    with pytest.raises(ValueError):
        index.read("essays/bad.pdf")


class FakeEmbedder:
    """Vectors by topic word, so 'ocean' is close to an essay about the sea with no shared word."""

    TOPICS = ("sea|ocean|lighthouse|tide|wave", "robot|machine", "garden|tomato")

    def __init__(self, fail=False):
        self.fail = fail

    def _vec(self, text):
        import re

        low = text.lower()
        v = [float(len(re.findall(t, low))) for t in self.TOPICS] + [0.01]
        n = sum(x * x for x in v) ** 0.5
        return [x / n for x in v]

    def query(self, text):
        if self.fail:
            raise EmbedError("down")
        return self._vec(text)

    def documents(self, title, pieces):
        return [self._vec(p) for p in pieces]


def test_search_by_meaning_finds_a_document_with_no_shared_word(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    (root / "sea.md").write_text("# Tides\nThe lighthouse keeper watched each wave and tide roll in.")
    (root / "bot.md").write_text("# Bots\nOur robot machine sorts the recycling.")
    mark_synthetic(root)
    s = make_settings(tmp_path, root)
    assert DocumentIndex(s).search("ocean") == []  # no keyword matches
    hits = DocumentIndex(s, embedder=FakeEmbedder()).search("ocean")
    assert hits[0].doc_id == "sea.md" and "lighthouse" in hits[0].text


def test_passages_need_a_keyword_or_a_close_meaning(tmp_path):
    # Every piece has some similarity to any query, so counting the whole meaning ranking let
    # unrelated files fill every slot. Now past the MEANING_TOP closest a piece needs a keyword.
    from base.workspace.index import MEANING_TOP

    root = tmp_path / "w"
    root.mkdir()
    (root / "report.md").write_text("# Quarterly report\nThe credit union added members this quarter.")
    for i in range(MEANING_TOP + 4):
        (root / f"garden{i}.md").write_text(f"# Garden {i}\nWe planted tomato seeds by the fence.")
    mark_synthetic(root)
    got = DocumentIndex(make_settings(tmp_path, root), embedder=FakeEmbedder()).passages("credit union", k=20)
    assert got[0].doc_id == "report.md"
    assert len(got) <= MEANING_TOP + 1  # the keyword match plus at most MEANING_TOP by meaning alone


def test_search_falls_back_to_keywords_when_the_embedder_fails(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    (root / "bot.md").write_text("# Bots\nOur robot sorts the recycling.")
    mark_synthetic(root)
    hits = DocumentIndex(make_settings(tmp_path, root), embedder=FakeEmbedder(fail=True)).search("robot")
    assert [h.doc_id for h in hits] == ["bot.md"]


def test_chunks_overlap_and_cover_the_text():
    text = " ".join(f"w{i}" for i in range(1000))
    pieces = chunks(text, size=300, overlap=50)
    assert len(pieces) > 1 and all(len(p) <= 300 for p in pieces)
    assert pieces[0].split()[0] == "w0" and pieces[-1].split()[-1] == "w999"
