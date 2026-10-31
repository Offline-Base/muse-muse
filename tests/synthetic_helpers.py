"""Mark a temp folder as invented data the way a cloud backend needs it: marker plus manifest."""

from pathlib import Path

from base import manifest


def mark_synthetic(folder: Path) -> Path:
    """Write the .synthetic marker and a manifest of every regular file now under folder.

    Tests only: real manifests list git-tracked files (scripts/make_manifest.py). Call it after the
    test has written its files; a file written later is unlisted and the folder is refused.
    """
    folder = Path(folder)
    (folder / manifest.MARKER_NAME).write_text("invented\n")
    files = [f for f in manifest.folder_files(folder) if not (folder / f).is_symlink()]
    return manifest.write(folder, files)
