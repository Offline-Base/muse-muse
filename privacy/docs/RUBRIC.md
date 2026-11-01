# Rubric, rules and how Muse Privacy maps to them

Rules checked Oct 28, 2026; the status table below updated Oct 31. The build plan (Oct 24) was written before the Official Rules were out and treated the startup track's one-line blurb as the scoring rule. It is not. This page replaces the plan's "What the hackathon asks for" table.

## Sources

| Source | What it settles |
|---|---|
| [Official Rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) ("Hackathon Terms & Conditions ("Official Rules") and Event Waiver", Cerebral Valley) | The rubric and weights, tracks, prizes, eligibility, ownership and IP, open source, the submission portal |
| [Event page](https://dev.meta.ai/events/global-hackathon) (Meta) and the [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) | Themes, tracks, key dates, the Meta products on offer |
| [Meta Model API Terms](https://dev.meta.ai/legal/terms-of-service) and [model designations](https://dev.meta.ai/legal/geographic-use-policy) | What Meta may do with what we send to Spark |
| [Muse Glimmer docs](https://dev.meta.ai/docs/muse-glimmer/) | Glimmer's license (Apache 2.0) |

The signed-in participant guide (`/details`) and the submission form are behind a login and have not been read. Rows marked "reported" below come from other participants' public notes, not from Meta or Cerebral Valley.

## The rubric

The Official Rules score every project submission, on both tracks, on four criteria:

| Criterion | Weight | What the Rules say it covers |
|---|---|---|
| Impact | 30% | "the real-world potential of the Project, who benefits, how much it matters, whether it could become something people use, and whether it fits one of the problem statements" |
| Use of Meta AI Tooling | 25% | "how creatively the team used Meta's AI tooling, whether they went beyond a basic integration, and whether they surfaced unexpected capabilities" |
| Demo | 25% | "whether the Project has a working, impressive demo, whether the product holds up live, and the quality of the demo video" |
| Technical Depth & Execution | 20% | "whether the engineering is sound and thoughtfully refined and the Project demonstrates real craft" |

The startup track's description on the event pages ("technical execution and whether it holds up in production") carries no weight of its own. Engineering is the smallest share of the score; who it helps, what Meta's models do, and the demo (live and on video) are 80%.

## Track and eligibility

- Two tracks. **Startup track:** "Open to technical founders building a product. The startup Representative must be an active employee of the startup and duly authorized designated individual to receive notices and prize payment on behalf of the startup." **Indie track:** individual builders and students, teams of up to four.
- The application form said "you can change your track anytime"; whether that still holds after acceptance is not stated.
- Submitting warrants that the work "(a) is their (or their applicable team's or organization's) original work product; (b) is solely owned by the Participant, their applicable team, or organization, with no other person or entity having any right or interest in it; and (c) does not violate the intellectual property or other proprietary rights" of others.
- "Participants may contract with a third party for technical assistance, provided the Submission components remain the Participant's own work and the Participant owns all rights to them. Participants may also include open source software or hardware, provided applicable open source licenses are followed and the Submission enhances or builds upon the underlying open source product."
- There is no clause on pre-existing code, prior-work disclosure or AI coding tools. docs/PRIOR_WORK.md is kept anyway.
- Not eligible: "Employees, contractors, and interns of Meta and Cerebral Valley, government-affiliated individuals, and members of their immediate families", and people in the same household. "Government-affiliated" is not defined; Ethan works with public school districts, so he confirms it does not cover him.
- The entrant keeps the IP and gives the Organizers a perpetual, royalty-free, non-exclusive license to the submission, including for marketing. Nothing shared during the event is confidential.
- The Rules require building with Meta AI products: "Muse Spark, Glimmer, SAM 3, and any other Meta AI products identified on the Event page." They do not name the Muse app, its Secure VM or connectors. Muse Code is promoted on the event page, not required. Nothing allows or forbids other services next to Meta's (OpenRouter, Cloudflare, Claude Code).

## Dates

| What | When |
|---|---|
| Submissions due | Nov 4, 2026, 9:00 PM ET (EST that day, 02:00 UTC Nov 5), in the [portal](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit). We submit by noon ET |
| Judging | Nov 4 to Nov 8 |
| Live finals and winners | Nov 9 |
| Bonus prizes (for example a community vote and a most viral project award) | On or about Nov 10 |

The portal's page data has a 6-hour "grace period" field that nothing explains. Do not plan around it.

## Submission requirements

| Requirement | Status | Source |
|---|---|---|
| Submit in the Cerebral Valley portal before the deadline | Confirmed | Official Rules |
| A demo video | Confirmed in substance: its quality is scored under Demo | Official Rules |
| A demo that holds up live | Confirmed: scored under Demo, and Nov 9 is live finals | Official Rules, event page |
| Built with Meta AI products | Confirmed | Official Rules |
| One track per participant and per project | Confirmed | Official Rules |
| Video at most 3 minutes | Reported by several participants | Participant notes |
| A public repo, a working demo video link, every team member added | Reported, quoted from the event Discord | Participant notes |
| Only work done during the event counts | Reported | Participant notes |
| A list of disqualified "anti-projects", including "simple 'AI for Education' Chatbots" and projects that give medical advice | Reported by one participant wiki, which says it is verbatim; not on any public official page | Participant notes |
| Form fields (description, screenshots, links) | Unknown until Ethan signs in | |

Muse Privacy is a privacy connector, not a chatbot, and gives no medical advice. If the anti-project list is real, the submission's first line should say so, and one non-education scene would help.

## How Muse Privacy maps to each criterion

| Criterion | Where it stands, Oct 31 | What moves it most before Nov 4 |
|---|---|---|
| Impact (30%) | The problem is real, and the README's "Who it's for" section ties it to the Build for Your World theme and FERPA's direct-control condition, but there are no real users: the only teacher is a policy file, the persona study has not run, there is no time-saved figure, and the grading spot-check is blank | One quote and a minutes-saved estimate from a teacher the author works with (HANDOFF row 18); the grading spot-check filled in; the persona study, labeled simulated |
| Use of Meta AI Tooling (25%) | Device-only today: Liquid's LFM on the laptop does the model steps, so the Meta tooling in use is the Muse app (no session has a report in `eval/reports/muse_app` yet), Spark's invented data and the earlier Glimmer measurements on OpenRouter. Glimmer has not been measured on the device. SAM 3.1 is built and off by default | A session in the real app with a report. Whether a tuned Glimmer at about 1.6-bit (IQ1_S) lands and passes its pre-registered test (`eval/reports/glimmer_prereg.md`), so its device numbers can join the README's "What Meta's models do here" section |
| Demo (25%) | No video yet. A script playing Muse takes all six scenes to their expected statuses, with 0 of 18 tool outputs holding a private value ([rehearsal](../eval/reports/muse_app/rehearsal_2026-10-31.md)), but that is not the app. The light and plush are not built | The scenes in the Muse app, recorded from the first attempt; a video under 3 minutes that names the theme early and says which model did the work; the device kept up Nov 4 to 9 |
| Technical Depth & Execution (20%) | Strong: one fail-closed exit, every number with its command, and on the device-only default 0 leaks and 82.5% (165 of 200) on `fresh_200_b`, a development set ([report](../eval/reports/floors_fresh_200_b.md)). The test count is in `docs/BUILD_LOG.md`, and so is CI passing on `main`. Held back by: the sealed set not scored yet, no gain from nightly learning on this model so far ([nights](../eval/reports/nights_device_rules/nights.md), before today's router default), and LFM3-VL-2B over-refusing as a router ([matrix](../eval/reports/matrix_lfm_loosen_default.md)) | The sealed set scored once; device numbers if the planned Glimmer lands; settling the share-rule evidence question (HANDOFF row 12); checking that the repo is public |

## Related work

Similar work exists; docs/PRIOR_WORK.md lists it with links under "Related work". The closest are Perplexity's hybrid compute on Mac (cloud plans, a local privacy gate that can mask details, keep data local, refuse, ask for consent or rewrite the request), PlanTwin (research on a cloud planner over a de-identified twin of local private state), Minions and PAPILLON (earlier splits between a local and a cloud model), ARIEL (learning a user's sharing judgments), and Canvas MCP and SafeGrader (pseudonymous student IDs over MCP, local grading with roster-based name hiding). Pitch Muse Privacy as a new combination inside Meta's own agent, not as the first local and cloud privacy gate.
