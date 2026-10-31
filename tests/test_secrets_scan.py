"""scripts/secrets_scan.py: the project's secret names, Modal and Cloudflare shapes, .env.example and
the data rules. Every fake key is built at run time, so this file holds no key shape itself."""

from __future__ import annotations

import subprocess

import pytest

from scripts import secrets_scan

GIT = ["-c", "user.email=t@example.org", "-c", "user.name=Test"]


def repo(tmp_path, files: dict[str, str]):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for name, text in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return tmp_path


def commit(root, message: str) -> None:
    subprocess.run(["git", "-C", str(root), *GIT, "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), *GIT, "commit", "-qm", message], check=True)


def kinds(text: str, path: str = "a.txt") -> list[str]:
    return [k for _w, _n, k in secrets_scan.scan_text(text, path, set(), path)]


def luhn_number(prefix: str) -> str:
    """prefix plus the check digit that makes it pass Luhn: an invented card-shaped number."""
    for d in "0123456789":
        if secrets_scan._luhn(prefix + d):
            return prefix + d
    raise AssertionError


FAKE = "k9Xq" * 5  # 20 characters, letters and digits: what a generated key looks like


@pytest.mark.parametrize("name", secrets_scan.SECRET_NAMES)
@pytest.mark.parametrize("shape", ["{n}={v}", "{n}: {v}", '"{n}": "{v}"', "export {n}='{v}'", '{n} = "{v}"'])
def test_a_long_value_assigned_to_a_secret_name_is_flagged(name, shape):
    assert kinds(shape.format(n=name, v=FAKE)) == [f"{name} value"]


@pytest.mark.parametrize(
    "value",
    [
        "",
        "local-test-key",  # the tests' stand-ins are short
        "your-meta-key-goes-here1",
        "REPLACE_WITH_THE_REAL_KEY",
        "$(python -m base.heavy.routes)",
        "settings.meta_api_key_from_env",  # code, not a key: no digit
        "<paste the key here 123>",
        "test-key-1234567890abcdef",
    ],
)
def test_placeholders_and_code_are_not_flagged(value):
    name = "META_API" + "_KEY"
    assert kinds(f"{name}={value}") == []


def test_modal_and_cloudflare_shapes_are_flagged():
    token_id, token_secret = "ak-" + "A1b2" * 6, "as-" + "C3d4" * 6
    assert kinds(f"modal token set --token-id {token_id}") == ["modal token id"]
    assert kinds(f"secret {token_secret}") == ["modal token secret"]
    cf = ("Zz9_-" * 8)[:40]
    assert kinds(f"wrangler secret put with {cf}") == ["cloudflare token"]
    assert kinds(f"an unrelated 40 character string {cf}") == []  # no Cloudflare word, not counted
    commit_id = "0123456789abcdef" * 2 + "01234567"
    assert kinds(f"cloudflare deploy at {commit_id}") == []  # 40 hex is a commit id


def test_a_32_hex_id_counts_only_in_a_wrangler_config():
    line = '"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "' + "ab12" * 8 + '" }]'
    assert kinds(line, "relay/wrangler.jsonc") == ["cloudflare id"]
    assert kinds(line, "notes.md") == []
    assert kinds(line.replace("ab12" * 8, "REPLACE_WITH_OAUTH_KV_ID"), "relay/wrangler.jsonc") == []


def test_env_example_holds_placeholders_only():
    good = "\n".join([
        "META_API_KEY=",
        "OPENROUTER_API_KEY=            # from openrouter.ai",
        "# HEAVY_TOKEN=                # worker token; print it on the Jetson",
        "# LLAMA_API_KEY=   (empty: read from BASE_HOME/llama_api_key)",
        "CHECKER_API_KEY=<your key>",
        "JETSON_LFM_API_KEY=REPLACE_ME",
        "# ROUTER_MAX_TOKENS=1500       # a count, not a token",
        "BASE_HOME=~/.base",
    ])  # fmt: skip
    assert kinds(good, ".env.example") == []
    name = "OPENROUTER_API" + "_KEY"
    assert kinds(f"{name}=abc123", ".env.example") == ["env example value"]  # short, still a real value
    assert kinds(f"# {name}=abc123", ".env.example") == ["env example value"]
    assert kinds(f"{name}=abc123", "README.md") == []


def test_data_rules_flag_real_looking_shapes_in_invented_data():
    card = luhn_number("5" + "3" * 14)
    ok = (
        "Call (312) 555-0147 or 415-555-0199, write a@example.org or b@mail.example.com or c@school.test. "
        "SSN 900-12-3456 and 000-12-3456. Card 4111 1111 1111 1111. Dates 2026-10-31 and 3/14/2017."
    )
    assert secrets_scan.scan_data(ok, "eval/x.jsonl") == []
    bad = {
        "Fax: (555) 010-0199": "phone outside 555-01xx",
        "Call 312-867-5309": "phone outside 555-01xx",
        "Mail c@" + "mailbox" + ".com": "email outside example domains",
        "SSN 123-45-6789": "ssn outside 9xx or 000",
        f"Card {card}": "card number not a test number",
    }
    for text, kind in bad.items():
        assert [k for _w, _n, k in secrets_scan.scan_data(text, "eval/x.jsonl")] == [kind], text


def test_the_data_rules_run_on_data_folders_only_and_never_print_values(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(secrets_scan, "user_names", lambda: set())
    ssn = "-".join(("123", "45", "6789"))
    name = "META_API" + "_KEY"
    root = repo(tmp_path, {
        "eval/set.jsonl": f'{{"text": "SSN {ssn}"}}\n',
        "tests/fixtures/f.md": f"SSN {ssn}\n",
        "tests/test_guard_like.py": f"SSN = '{ssn}'  # a detector self-test holds real-looking shapes\n",
        "scripts/x.py": f"{name} = '{FAKE}'\n",
    })  # fmt: skip
    assert secrets_scan.main([], root=root) == 1
    out = capsys.readouterr().out
    assert (
        "eval/set.jsonl:1: ssn outside 9xx or 000" in out
        and "tests/fixtures/f.md:1: ssn outside 9xx or 000" in out
    )
    assert "test_guard_like" not in out
    assert f"scripts/x.py:1: {name} value" in out
    assert ssn not in out and FAKE not in out


def test_history_knows_which_file_a_line_was_added_to(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(secrets_scan, "user_names", lambda: set())
    config = '{ "kv_namespaces": [{ "id": "' + "cd34" * 8 + '" }] }\n'
    root = repo(tmp_path, {"relay/wrangler.jsonc": config, "notes.md": "fine\n"})
    commit(root, "add")
    (root / "relay" / "wrangler.jsonc").write_text(
        '{ "kv_namespaces": [{ "id": "REPLACE_WITH_OAUTH_KV_ID" }] }\n'
    )
    commit(root, "placeholder")
    assert secrets_scan.main([], root=root) == 0
    assert secrets_scan.main(["--history"], root=root) == 1
    out = capsys.readouterr().out
    assert "cloudflare id" in out and "cd34" not in out


def test_the_data_rules_skip_history(tmp_path, monkeypatch):
    """An invented number fixed later is not a secret: history keeps it, and only the tree is held to the rule."""
    monkeypatch.setattr(secrets_scan, "user_names", lambda: set())
    root = repo(tmp_path, {"eval/set.jsonl": '{"text": "Fax: (555) 010-0199"}\n'})
    commit(root, "add")
    (root / "eval" / "set.jsonl").write_text('{"text": "Fax: (312) 555-0199"}\n')
    commit(root, "fix")
    assert secrets_scan.main(["--history"], root=root) == 0


def test_the_report_names_the_new_checks(tmp_path, monkeypatch):
    monkeypatch.setattr(secrets_scan, "user_names", lambda: set())
    root = repo(tmp_path, {"a.txt": "clean\n"})
    report = tmp_path / "out" / "scan.md"
    assert secrets_scan.main(["--report", str(report)], root=root) == 0
    text = report.read_text()
    assert "Findings: 0" in text and "META_API_KEY" in text and "555-01xx" in text and "—" not in text
