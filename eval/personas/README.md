# Simulated personas (invented)

Seven simulated personas for scripts/simulate_nights.py. None is a person, and every item they see is invented. Each folder has:

- policy.yaml: the persona's privacy policy, in the same schema as eval/user_policy.yaml (docs/CONTRACTS.md, Policy). It labels the items, routes them and answers the cards.
- persona.yaml: its seeded habits (eval/persona.py): per-rule odds, slips, a forgotten remember box, late answers, unanswered cards, deleted answers, and an assumed 15 seconds per card. The same seed gives the same answers.
- README.md: what it is and what it tests.
- days.jsonl, holdout.jsonl, unseen.jsonl: its relabeled item sets (scripts/relabel_for_persona.py), with sets.md giving the command and counts.

| Persona | Policy | Toggles | Habits | Tests |
|---|---|---|---|---|
| strict_teacher | eval/user_policy.yaml | none | none | the reference run |
| relaxed_teacher | shares almost everything | none | 3% slips | different labels, share rules |
| sped_coordinator | IEP asked first | none | none | ask_first and request topics |
| tired_teacher | eval/user_policy.yaml | none | slips, forgets, late, deletes | learning under noise |
| privacy_officer | eval/user_policy.yaml | FERPA, COPPA | never answers | the receipt audit checklist |
| clinic_coordinator | an invented clinic | HIPAA | 10% late | a non-school policy, small groups |
| caseworker_cui | refuses everything | CUI | none | local-only holds |

The study's design, metrics, seeds and stop rule are fixed in eval/reports/sim/PLAN.md before any run. A test (tests/test_sim_honesty.py) fails if a file here or under eval/reports/sim does not say "simulated".
