"""The user's privacy policy: never_share topics, ask_first topics and ordered rules.

See docs/CONTRACTS.md (Policy). Rules are checked in file order and the first match wins;
when none matches, the default applies. A rule matches when every match field it sets holds:

- kinds: the result kind is in the list
- topics_any: at least one listed topic is present
- topics_all: every listed topic is present
- request_any: at least one listed string is a case-insensitive substring of the request

`item` in every method is any mapping (or object) with `request`, `result_kind` and `topics`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from base.types import DECISIONS, RESULT_KINDS, Decision

MATCH_KEYS = ("kinds", "topics_any", "topics_all", "request_any")
RULE_KEYS = frozenset({"id", *MATCH_KEYS, "wants", "pre_approved", "on_ask", "note"})
TOP_KEYS = frozenset({"name", "description", "never_share", "ask_first", "rules", "default"})
DEFAULT_KEYS = frozenset({"wants", "on_ask"})
ON_ASK_KEYS = frozenset({"approve", "remember"})
SHARE_FORMS = frozenset({"share_tagged", "share_summary"})


class PolicyError(ValueError):
    """The policy file is malformed. The message names the file and the field."""


@dataclass(frozen=True)
class Rule:
    id: str
    wants: Decision
    kinds: tuple[str, ...] = ()
    topics_any: tuple[str, ...] = ()
    topics_all: tuple[str, ...] = ()
    request_any: tuple[str, ...] = ()
    pre_approved: bool = False
    approve: bool = False
    remember: bool = False

    def matches(self, request: str, result_kind: str, topics: Iterable[str]) -> bool:
        present = set(topics)
        if self.kinds and result_kind not in self.kinds:
            return False
        if self.topics_any and not present.intersection(self.topics_any):
            return False
        if self.topics_all and not present.issuperset(self.topics_all):
            return False
        if self.request_any:
            text = request.casefold()
            if not any(part.casefold() in text for part in self.request_any):
                return False
        return True


def _field(item: Any, key: str, default: Any) -> Any:
    value = item.get(key, default) if isinstance(item, Mapping) else getattr(item, key, default)
    return default if value is None else value


def _default_on_ask(wants: str) -> tuple[bool, bool]:
    """When a rule has no on_ask, answer the way its `wants` implies."""
    if wants in SHARE_FORMS:
        return True, True
    if wants == "refuse":
        return False, True
    return False, False


class UserPolicy:
    """A loaded, validated policy. Build one with `UserPolicy.load(path)`."""

    def __init__(
        self,
        name: str,
        never_share: dict[str, list[str]],
        ask_first: set[str],
        rules: list[Rule],
        default: Rule,
    ):
        self.name = name
        self._never_share = never_share
        self._ask_first = set(ask_first)
        self.rules = list(rules)
        self.default = default

    @property
    def never_share(self) -> dict[str, list[str]]:
        return {topic: list(words) for topic, words in self._never_share.items()}

    @property
    def ask_first(self) -> set[str]:
        return set(self._ask_first)

    # Loading and validation

    @classmethod
    def load(cls, path: str | Path) -> UserPolicy:
        path = Path(path)
        try:
            data = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            raise PolicyError(f"{path}: not valid YAML ({exc})") from exc
        return cls.from_dict(data, source=str(path))

    @classmethod
    def from_dict(cls, data: Any, source: str = "policy") -> UserPolicy:
        if not isinstance(data, Mapping):
            raise PolicyError(f"{source}: the policy must be a mapping at the top level")
        unknown = set(data) - TOP_KEYS
        if unknown:
            raise PolicyError(f"{source}: unknown top-level keys {sorted(unknown)}; allowed: {sorted(TOP_KEYS)}")

        never_share = _parse_never_share(data.get("never_share") or {}, source)
        ask_first = set(_str_list(data.get("ask_first") or [], f"{source}: ask_first"))
        stray = ask_first - set(never_share)
        if stray:
            raise PolicyError(f"{source}: ask_first topics {sorted(stray)} are not in never_share")

        raw_rules = data.get("rules") or []
        if not isinstance(raw_rules, list):
            raise PolicyError(f"{source}: rules must be a list")
        rules: list[Rule] = []
        seen: set[str] = set()
        for i, raw in enumerate(raw_rules):
            rule = _parse_rule(raw, i, source)
            if rule.id in seen:
                raise PolicyError(f"{source}: rule id {rule.id!r} appears twice")
            seen.add(rule.id)
            rules.append(rule)

        default = _parse_default(data.get("default"), source)
        name = str(data.get("name") or Path(source).stem)
        return cls(name, never_share, ask_first, rules, default)

    # Matching

    def match(self, item: Any) -> Rule:
        """The first rule that matches `item`, or the default rule (id "default")."""
        request = str(_field(item, "request", ""))
        kind = str(_field(item, "result_kind", ""))
        topics = list(_field(item, "topics", []))
        for rule in self.rules:
            if rule.matches(request, kind, topics):
                return rule
        return self.default

    def wants(self, item: Any) -> Decision:
        return self.match(item).wants

    def answer(self, item: Any) -> tuple[bool, bool]:
        """How the simulated user answers when asked: (approve, remember)."""
        rule = self.match(item)
        return rule.approve, rule.remember

    def pre_approved(self, kind: str, topics: Iterable[str], request: str = "") -> bool:
        """True when the rule that wins for this kind and topics is marked pre_approved.

        Pass `request` when it is known so request_any rules ahead of it are respected.
        """
        item = {"request": request, "result_kind": kind, "topics": list(topics)}
        return self.match(item).pre_approved


def _str_list(value: Any, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise PolicyError(f"{where} must be a list of non-empty strings")
    return tuple(v.strip() for v in value)


def _parse_never_share(value: Any, source: str) -> dict[str, list[str]]:
    if not isinstance(value, Mapping):
        raise PolicyError(f"{source}: never_share must map a topic to a list of keywords")
    out: dict[str, list[str]] = {}
    for topic, words in value.items():
        if not isinstance(topic, str) or not topic.strip():
            raise PolicyError(f"{source}: never_share topic names must be non-empty strings")
        out[topic] = list(_str_list(words, f"{source}: never_share.{topic}"))
    return out


def _parse_decision(value: Any, where: str) -> Decision:
    if value not in DECISIONS:
        raise PolicyError(f"{where}: wants must be one of {list(DECISIONS)}, not {value!r}")
    return value


def _parse_on_ask(value: Any, wants: str, where: str) -> tuple[bool, bool]:
    if value is None:
        return _default_on_ask(wants)
    if not isinstance(value, Mapping):
        raise PolicyError(f"{where}: on_ask must be a mapping like {{approve: true, remember: true}}")
    unknown = set(value) - ON_ASK_KEYS
    if unknown:
        raise PolicyError(f"{where}: unknown on_ask keys {sorted(unknown)}; allowed: {sorted(ON_ASK_KEYS)}")
    approve, remember = value.get("approve", False), value.get("remember", False)
    if not isinstance(approve, bool) or not isinstance(remember, bool):
        raise PolicyError(f"{where}: on_ask approve and remember must be true or false")
    return approve, remember


def _parse_rule(raw: Any, index: int, source: str) -> Rule:
    where = f"{source}: rules[{index}]"
    if not isinstance(raw, Mapping):
        raise PolicyError(f"{where} must be a mapping")
    rule_id = raw.get("id", f"rule_{index + 1}")
    if not isinstance(rule_id, str) or not rule_id.strip():
        raise PolicyError(f"{where}: id must be a non-empty string")
    where = f"{source}: rules[{index}] (rule {rule_id!r})"
    unknown = set(raw) - RULE_KEYS
    if unknown:
        raise PolicyError(f"{where}: unknown rule keys {sorted(unknown)}; allowed: {sorted(RULE_KEYS)}")
    if "wants" not in raw:
        raise PolicyError(f"{where}: wants is required")
    wants = _parse_decision(raw["wants"], where)

    fields: dict[str, tuple[str, ...]] = {}
    for key in MATCH_KEYS:
        if key in raw and raw[key] is not None:
            fields[key] = _str_list(raw[key], f"{where}: {key}")
    bad_kinds = set(fields.get("kinds", ())) - set(RESULT_KINDS)
    if bad_kinds:
        raise PolicyError(f"{where}: unknown kinds {sorted(bad_kinds)}; allowed: {list(RESULT_KINDS)}")

    pre = raw.get("pre_approved", False)
    if not isinstance(pre, bool):
        raise PolicyError(f"{where}: pre_approved must be true or false")
    if pre and wants not in SHARE_FORMS:
        raise PolicyError(f"{where}: pre_approved only makes sense when wants is share_tagged or share_summary")

    approve, remember = _parse_on_ask(raw.get("on_ask"), wants, where)
    return Rule(id=rule_id, wants=wants, pre_approved=pre, approve=approve, remember=remember, **fields)


def _parse_default(raw: Any, source: str) -> Rule:
    where = f"{source}: default"
    if raw is None:
        raw = {"wants": "ask_user"}
    if not isinstance(raw, Mapping):
        raise PolicyError(f"{where} must be a mapping like {{wants: ask_user}}")
    unknown = set(raw) - DEFAULT_KEYS
    if unknown:
        raise PolicyError(f"{where}: unknown keys {sorted(unknown)}; allowed: {sorted(DEFAULT_KEYS)}")
    wants = _parse_decision(raw.get("wants", "ask_user"), where)
    approve, remember = _parse_on_ask(raw.get("on_ask"), wants, where)
    return Rule(id="default", wants=wants, approve=approve, remember=remember)
