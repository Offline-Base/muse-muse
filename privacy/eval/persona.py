"""Simulated personas for scripts/simulate_nights.py: a policy file plus seeded answering habits.

A persona is not a person. Its judgment is its policy file (base/policy.py, the same schema as
eval/user_policy.yaml) and its habits are a few numbers in persona.yaml:

- answers: per policy rule id, the chance it approves a card and the chance it ticks "don't ask
  again". Rules not listed answer the way the policy's on_ask says (always or never).
- flip_p: the chance its answer is the opposite of what it would say (a slip, or a changed mind).
- forget_remember_p: the chance it leaves "don't ask again" unticked when it meant to tick it.
- late_p: the chance it answers after that night's dreaming, so the answer trains the next night.
- ignore_p: the chance it never answers; the card stays waiting.
- undo_p: the chance it deletes a remembered answer the next morning (History page), so the next
  night's rebuild drops it.
- seconds_per_card: time spent on one card, an assumption kept for the time model.

The same seed always gives the same answers: every draw comes from its own Random seeded with
the persona's seed, the day and the item id, so the order cards arrive in changes nothing.
Every persona file says simulated and invented; load() refuses a name that does not.

    persona = Persona.load("eval/personas/strict_teacher/persona.yaml")
    persona.answer(item, day=3)  # Answer(approve, remember, when)
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from base import compliance
from base.policy import UserPolicy

NOW, LATE, NEVER = "now", "late", "never"
MIXES = ("even", "natural")
TOP_KEYS = frozenset({"id", "name", "description", "policy", "roster", "toggles", "seed", "mix", "behavior", "answers"})
BEHAVIOR_KEYS = frozenset({"flip_p", "forget_remember_p", "late_p", "ignore_p", "undo_p", "seconds_per_card"})
ANSWER_KEYS = frozenset({"approve", "remember"})
SECONDS_PER_CARD = 15.0  # an assumption, not a measurement (SIM-9 varies it)


class PersonaError(ValueError):
    """The persona file is malformed. The message names the file and the field."""


@dataclass(frozen=True)
class Answer:
    approve: bool
    remember: bool
    when: str = NOW  # now, late (after that night's dreaming) or never


@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    policy: UserPolicy = field(repr=False)
    policy_path: Path | None = None
    roster_path: Path | None = None
    toggles: tuple[str, ...] = ()
    seed: int = 0
    mix: str = "even"
    flip_p: float = 0.0
    forget_remember_p: float = 0.0
    late_p: float = 0.0
    ignore_p: float = 0.0
    undo_p: float = 0.0
    seconds_per_card: float = SECONDS_PER_CARD
    answers: Mapping[str, tuple[float, float]] = field(default_factory=dict)  # rule id -> (approve, remember)
    path: Path | None = None

    @classmethod
    def from_policy(cls, policy: UserPolicy, *, seed: int = 0) -> Persona:
        """The policy's own answers with no noise: the simulated teacher of eval/user_policy.yaml
        when no persona is given."""
        name = getattr(policy, "name", "policy")
        return cls(id="policy", name=f"{name} (simulated, from the policy file)", policy=policy, seed=seed)

    @classmethod
    def load(cls, path: str | Path) -> Persona:
        path = Path(path)
        try:
            data = yaml.safe_load(path.read_text())
        except (OSError, yaml.YAMLError) as exc:
            raise PersonaError(f"{path}: cannot read ({type(exc).__name__})") from exc
        if not isinstance(data, Mapping):
            raise PersonaError(f"{path}: a persona must be a mapping")
        unknown = set(data) - TOP_KEYS
        if unknown:
            raise PersonaError(f"{path}: unknown keys {sorted(unknown)}; allowed: {sorted(TOP_KEYS)}")
        pid, name = str(data.get("id") or path.parent.name), str(data.get("name") or "")
        if "simulated" not in name.lower() or "invented" not in name.lower():
            raise PersonaError(f"{path}: name must say the persona is simulated and invented")
        if "policy" not in data:
            raise PersonaError(f"{path}: policy (a policy file next to this one) is required")
        policy_path = (path.parent / str(data["policy"])).resolve()
        policy = UserPolicy.load(policy_path)  # PolicyError names the file
        roster_path = (path.parent / str(data["roster"])).resolve() if data.get("roster") else None
        if roster_path is not None and not roster_path.is_file():
            raise PersonaError(f"{path}: no roster at {data['roster']}")

        toggles = data.get("toggles") or []
        if not isinstance(toggles, list) or set(map(str, toggles)) - set(compliance.PROFILES):
            raise PersonaError(f"{path}: toggles must be a list of {sorted(compliance.PROFILES)}")
        mix = str(data.get("mix") or "even")
        if mix not in MIXES:
            raise PersonaError(f"{path}: mix must be one of {list(MIXES)}")
        seed = data.get("seed", 0)
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise PersonaError(f"{path}: seed must be a whole number")

        behavior = data.get("behavior") or {}
        if not isinstance(behavior, Mapping) or set(behavior) - BEHAVIOR_KEYS:
            raise PersonaError(f"{path}: behavior keys must be among {sorted(BEHAVIOR_KEYS)}")
        odds = {k: _chance(behavior.get(k, 0.0), f"{path}: behavior.{k}") for k in BEHAVIOR_KEYS - {"seconds_per_card"}}
        if odds["late_p"] + odds["ignore_p"] > 1:
            raise PersonaError(f"{path}: late_p plus ignore_p cannot be more than 1")
        seconds = behavior.get("seconds_per_card", SECONDS_PER_CARD)
        if not isinstance(seconds, int | float) or isinstance(seconds, bool) or seconds <= 0:
            raise PersonaError(f"{path}: behavior.seconds_per_card must be a positive number")

        answers = _answers(data.get("answers") or {}, policy, path)
        return cls(
            id=pid, name=name, policy=policy, policy_path=policy_path, roster_path=roster_path,
            toggles=tuple(compliance.clean(toggles)), seed=seed, mix=mix, seconds_per_card=float(seconds),
            answers=answers, path=path, **odds,
        )  # fmt: skip

    def with_seed(self, seed: int) -> Persona:
        return replace(self, seed=seed)

    def odds(self, item: Any) -> tuple[float, float]:
        """(chance of approving, chance of remembering) for the policy rule this item falls under:
        the persona's own odds for that rule, else the policy's answer (its on_ask)."""
        if self.answers:
            rule = self.policy.match(item)
            if rule.id in self.answers:
                return self.answers[rule.id]
        approve, remember = self.policy.answer(item)
        return float(approve), float(remember)

    def answer(self, item: Mapping, day: int) -> Answer:
        """How this persona answers the card for `item` on `day`. Five draws, always in the same
        order, from a Random seeded by (seed, day, item id)."""
        approve_p, remember_p = self.odds(item)
        rng = random.Random(f"{self.seed}:answer:{day}:{item.get('id')}")
        a, flip, r, forget, w = (rng.random() for _ in range(5))
        approve = a < approve_p
        if flip < self.flip_p:
            approve = not approve
        remember = r < remember_p and not forget < self.forget_remember_p
        when = NEVER if w < self.ignore_p else LATE if w < self.ignore_p + self.late_p else NOW
        return Answer(approve, remember, when)

    def undoes(self, row_id: int) -> bool:
        """Whether this persona deletes its remembered answer on decision row `row_id` the next morning."""
        return self.undo_p > 0 and random.Random(f"{self.seed}:undo:{row_id}").random() < self.undo_p

    def describe(self) -> str:
        """One line of habits for reports."""
        parts = [f"flip {self.flip_p:g}", f"forget remember {self.forget_remember_p:g}", f"late {self.late_p:g}",
                 f"never answers {self.ignore_p:g}", f"undo {self.undo_p:g}", f"{self.seconds_per_card:g} s per card"]  # fmt: skip
        if self.answers:
            parts.append("own odds for " + ", ".join(sorted(self.answers)))
        return "; ".join(parts)


def _chance(value: Any, where: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool) or not 0 <= value <= 1:
        raise PersonaError(f"{where} must be a number from 0 to 1")
    return float(value)


def _answers(raw: Any, policy: UserPolicy, path: Path) -> dict[str, tuple[float, float]]:
    """Per-rule odds: {rule id: {approve: p, remember: p}}. Ids must be the policy's (or default)."""
    if not isinstance(raw, Mapping):
        raise PersonaError(f"{path}: answers must map a policy rule id to {{approve, remember}}")
    ids = {r.id for r in policy.rules} | {"default"}
    out: dict[str, tuple[float, float]] = {}
    for rule_id, odds in raw.items():
        if rule_id not in ids:
            raise PersonaError(f"{path}: answers.{rule_id} is not a rule id in the policy")
        if not isinstance(odds, Mapping) or set(odds) - ANSWER_KEYS:
            raise PersonaError(f"{path}: answers.{rule_id} takes approve and remember")
        rule = next((r for r in policy.rules if r.id == rule_id), policy.default)
        out[str(rule_id)] = (
            _chance(odds.get("approve", float(rule.approve)), f"{path}: answers.{rule_id}.approve"),
            _chance(odds.get("remember", float(rule.remember)), f"{path}: answers.{rule_id}.remember"),
        )
    return out
