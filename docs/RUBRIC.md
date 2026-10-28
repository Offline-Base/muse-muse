# Rubric, rules and how Muse Privacy maps to them

Checked Oct 28, 2026. The build plan (Oct 24) was written before the Official Rules were out and treated the startup track's one-line blurb as the scoring rule. It is not. This page replaces the plan's "What the hackathon asks for" table.

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

| Criterion | Where it stands, Oct 28 | What moves it most before Nov 4 |
|---|---|---|
| Impact (30%) | The problem is real, and the README's "Who it's for" section ties it to the Build for Your World theme and FERPA's direct-control condition, but the only teacher is a policy file, there is no time-saved figure, and the grading spot-check is blank | One quote and a minutes-saved estimate from a teacher Ethan works with (HANDOFF row 18); the grading spot-check filled in |
| Use of Meta AI Tooling (25%) | The design uses Meta's models in unusual ways (Muse plans over tags it cannot resolve; one open-weights Glimmer is grader, name pass, request reader and router; Muse's scheduled jobs drive nightly learning), and the README's "What Meta's models do here" section names them with numbers, but the Muse app has not connected and Glimmer has run only on OpenRouter | The first real Muse app run; Glimmer on the laptop with llama-server, so the device numbers can join that section |
| Demo (25%) | No video yet; the core scenes need the Muse app; the light and plush are not built | The Muse app run, recorded from the first attempt; a video under 3 minutes that names the theme early and says which Glimmer graded; the device kept up Nov 4 to 9 |
| Technical Depth & Execution (20%) | Strong: 1713 tests, one fail-closed exit, every number with its command, 0 leaks in every final run, a holdout and an unseen test. Held back by cloud-only numbers and untested device paths | Device numbers (`bench_speed --label laptop`); settling the share-rule evidence question (HANDOFF row 12); a public repo with CI |

## Related work

Similar work exists; docs/PRIOR_WORK.md lists it with links under "Related work". The closest are Perplexity's hybrid compute on Mac (cloud plans, a local privacy gate that can mask details, keep data local, refuse, ask for consent or rewrite the request), PlanTwin (research on a cloud planner over a de-identified twin of local private state), Minions and PAPILLON (earlier splits between a local and a cloud model), ARIEL (learning a user's sharing judgments), and Canvas MCP and SafeGrader (pseudonymous student IDs over MCP, local grading with roster-based name hiding). Pitch Muse Privacy as a new combination inside Meta's own agent, not as the first local and cloud privacy gate.
