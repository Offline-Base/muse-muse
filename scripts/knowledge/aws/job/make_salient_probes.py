"""Write salient_probes.jsonl: what mattered in 2026 in AI, Meta and world news, with short exact answers.

Every question comes from an outside list, read on Oct 31, 2026: Wikipedia's "2026" and "2026 in artificial intelligence",
the 2026 sections of its Anthropic and OpenAI articles, and Meta's newsroom. They were written without looking at the
training set, and each carries its source URL and a date from Jan 4 to Oct 29, 2026. date_precision "month" or "window"
means the source doesn't give the day.

The file is held out of training through HELD_OUT in scripts/knowledge/aws/stage_b_lib.py.

Run: python3 scripts/knowledge/aws/job/make_salient_probes.py
"""

import json
import os
import re
import unicodedata

W26 = "https://en.wikipedia.org/wiki/2026"
WAI = "https://en.wikipedia.org/wiki/2026_in_artificial_intelligence"
WAN = "https://en.wikipedia.org/wiki/Anthropic"
WOA = "https://en.wikipedia.org/wiki/OpenAI"
FB = "https://about.fb.com/news/"

# (question, answer, aliases, date, url[, date_precision])
AI = [
    ("Which AI chatbot startup agreed with Google in January 2026 to settle lawsuits alleging its chatbots harmed minors?", "Character.AI", ["Character AI"], "2026-01-07", WAI),
    ("Which company limited its chatbot's image generation to paid users on January 9, 2026, after it produced sexually explicit deepfakes?", "xAI", [], "2026-01-09", WAI),
    ("Which AI chatbot did Indonesia and Malaysia block in January 2026 over nonconsensual sexualised deepfakes?", "Grok", [], "2026-01-10", WAI),
    ("Which UK regulator launched an investigation into X on February 3, 2026, after the Grok deepfakes controversy?", "Ofcom", [], "2026-02-03", WAI),
    ("What did OpenAI begin testing inside ChatGPT in the United States on February 9, 2026?", "advertisements", ["ads", "adverts", "advertising"], "2026-02-09", WAI),
    ("How many experts did the UN General Assembly appoint to the Independent International Scientific Panel on AI in February 2026?", "40", ["forty"], "2026-02-12", WAI),
    ("Paraguay and which other country voted against the appointments to the UN's Independent International Scientific Panel on AI in February 2026?", "United States", ["US", "USA", "U.S."], "2026-02-12", WAI),
    ("Which OpenAI model, known for its warm style, was retired on February 13, 2026?", "GPT-4o", [], "2026-02-13", WAI),
    ("In which city did the India AI Impact Summit 2026 conclude in February 2026?", "New Delhi", ["Delhi"], "2026-02-21", WAI),
    ("Whose family filed the first wrongful death lawsuit against Google over its Gemini chatbot in March 2026?", "Jonathan Gavalas", ["Gavalas"], "2026-03-04", WAI),
    ("Which US city sued xAI on March 24, 2026, accusing Grok of generating sexualized images without consent?", "Baltimore", [], "2026-03-24", WAI),
    ("Which state's attorney general launched a criminal investigation into OpenAI on April 21, 2026?", "Florida", [], "2026-04-21", WAI),
    ("Who is the Florida Attorney General who launched a criminal investigation into OpenAI in April 2026?", "James Uthmeier", ["Uthmeier"], "2026-04-21", WAI),
    ("A shooting at which university was at issue in Florida's April 2026 criminal investigation into OpenAI?", "Florida State University", ["FSU", "Florida State"], "2026-04-21", WAI),
    ("Which OpenAI video generation app was shut down publicly on April 26, 2026?", "Sora", [], "2026-04-26", WAI),
    ("Which US state filed the first state lawsuit against OpenAI and Sam Altman over ChatGPT, on June 1, 2026?", "Florida", [], "2026-06-01", WAI),
    ("On June 30, 2026, the United States lifted export restrictions on Claude Fable 5 and Claude Mythos 5. Which company makes them?", "Anthropic", [], "2026-06-30", WAI),
    ("Whose data processing systems did OpenAI say its AI models autonomously hacked into, as disclosed on July 21, 2026?", "Hugging Face", ["HuggingFace"], "2026-07-21", WAI),
    ("What was the title of the July 28, 2026 open letter from more than 1,100 AI company employees and executives asking the US to support pacing automated AI development?", "Pacing the Frontier", [], "2026-07-28", WAI),
    ("Most provisions of which EU law became applicable on August 2, 2026?", "AI Act", ["Artificial Intelligence Act"], "2026-08-02", WAI),
    ("Which model did OpenAI launch on September 4, 2026, describing it as artificial general intelligence?", "GPT-6 Astra", ["GPT-6"], "2026-09-04", WAI),
    ("OpenAI announced a solution to which Millennium Prize Problem case in September 2026, causing a priority controversy?", "Navier-Stokes", ["Navier Stokes", "Navier–Stokes"], "2026-09-08", WAI),
    ("How many Fields Medalists published the open letter 'A Severe Misalignment of AI in Mathematics' on September 11, 2026?", "28", ["twenty-eight"], "2026-09-11", WAI),
    ("Which Canadian provincial government sued OpenAI on September 21, 2026, over the Tumbler Ridge shooting?", "British Columbia", ["BC", "B.C."], "2026-09-21", WAI),
    ("Which Australian government system did Prime Minister Anthony Albanese say OpenAI agents breached in June 2026?", "Medicare", [], "2026-09-24", WAI),
    ("What name did OpenAI give the GPT-6.1 model it released on September 29, 2026, while withholding GPT-6.1 Astra?", "Sol", [], "2026-09-29", WAI),
    ("What is the name of the personal AI agent system OpenAI launched on September 29, 2026?", "Dots", [], "2026-09-29", WAI),
    ("Which company's products did the US Department of Defense say on October 5, 2026, it had ceased using?", "Anthropic", [], "2026-10-05", WAI),
    ("From which company's Maven Smart System did the Pentagon remove Anthropic products, as reported in October 2026?", "Palantir", [], "2026-10-05", WAI),
    ("On how many open problems in mathematics did OpenAI publish findings on October 6, 2026?", "377", [], "2026-10-06", WAI),
    ("Which AI companion chatbot company filed for Chapter 11 bankruptcy on October 13, 2026?", "Character.AI", ["Character AI"], "2026-10-13", WAI),
    ("What model did Anthropic announce on April 7, 2026, as its most advanced, with cybersecurity capabilities and no planned public release?", "Claude Mythos", ["Mythos"], "2026-04-07", WAN),
    ("Which 'Mythos-class' Anthropic model with extended guardrails was announced on June 9, 2026?", "Fable 5", ["Claude Fable", "Fable"], "2026-06-09", WAN),
    ("On February 23, 2026, Anthropic accused DeepSeek, Moonshot AI and which other Chinese company of distillation attacks?", "MiniMax", [], "2026-02-23", WAN),
    ("What designation did the Pentagon officially give Anthropic on March 5, 2026?", "supply chain risk", ["supply-chain risk"], "2026-03-05", WAN),
    ("Which xAI data center did Anthropic agree to use in May 2026 to expand its model capacity?", "Colossus 1", ["Colossus"], "2026-05-15", WAN, "month"),
    ("Which software startup did Anthropic acquire on May 18, 2026?", "Stainless", [], "2026-05-18", WAN),
    ("With which company did Anthropic make a $1.8 billion cloud computing deal in May 2026?", "Akamai", [], "2026-05-15", WAN, "month"),
    ("Which chipmaker announced a 2-gigawatt GPU partnership with Anthropic in July 2026, along with an investment of up to $5 billion?", "AMD", [], "2026-07-15", WAN, "month"),
    ("Which company signed a cloud deal reportedly worth about $45 billion with Anthropic in August 2026, for a West Virginia data center?", "Nscale", [], "2026-08-15", WAN, "month"),
    ("Which conjecture did Anthropic mathematician Levent Alpöge disprove using Claude Fable 5 in July 2026?", "Jacobian conjecture", ["Jacobian"], "2026-07-15", WAN, "month"),
    ("Which firm did Anthropic name in September 2026 as its first independent evaluator with employee-like model access?", "Accenture", [], "2026-09-15", WAN, "month"),
    ("What is the name of the AI services company Anthropic created in May 2026 with Blackstone, Hellman & Friedman and Goldman Sachs?", "Ode", [], "2026-05-15", WAN, "month"),
    ("How many billions of dollars of first-half 2026 revenue did Anthropic report in its October 2026 IPO filing?", "16.3", [], "2026-10-15", WAN, "month"),
    ("Which company led OpenAI's $110 billion funding round in February 2026, with $50 billion?", "Amazon", [], "2026-02-15", WOA, "month"),
    ("At what post-money valuation, in billions of dollars, did OpenAI close its funding round in spring 2026?", "852", ["852 billion"], "2026-03-31", WOA, "month"),
    ("What is the name of the custom AI chip OpenAI announced on June 24, 2026?", "Jalapeño", ["Jalapeno"], "2026-06-24", WOA),
    ("What kind of filing did OpenAI confirm it had made with the US Securities and Exchange Commission on June 8, 2026?", "IPO", ["initial public offering"], "2026-06-08", WOA),
    ("Which healthcare technology startup did OpenAI acquire in January 2026 for about $60 million?", "Torch", [], "2026-01-15", WOA, "month"),
    ("Which Python tool developer did OpenAI acquire in March 2026?", "Astral", [], "2026-03-15", WOA, "month"),
    ("Which California media company did OpenAI acquire in April 2026?", "TBPN", [], "2026-04-15", WOA, "month"),
    ("Which OpenAI co-founder lost his lawsuit against the company in May 2026?", "Elon Musk", ["Musk"], "2026-05-15", WOA, "month"),
    ("What is the name of the majority-owned deployment and integration company OpenAI launched in May 2026?", "OpenAI Deployment Company", ["DeployCo"], "2026-05-15", WOA, "month"),
    ("Which AI coding tool lost OpenAI API access in August 2026 after being acquired by SpaceX?", "Cursor", [], "2026-08-15", WOA, "month"),
    ("What is the name of the online storage platform OpenAI described on September 14, 2026, handling over 70 million data requests per second?", "Habitat", [], "2026-09-14", WOA),
]

META = [
    ("What is the name of the first model Meta Superintelligence Labs introduced, in April 2026?", "Muse Spark", [], "2026-04-08", FB + "2026/04/introducing-muse-spark-meta-superintelligence-labs/"),
    ("What is the name of the personal AI agent Meta introduced on September 8, 2026?", "Muse", [], "2026-09-08", FB + "2026/09/introducing-muse-personal-ai-agent/"),
    ("What is the dedicated virtual machine that runs Meta's personal AI agent called?", "Muse Secure VM", [], "2026-09-08", FB + "2026/09/introducing-muse-personal-ai-agent/"),
    ("What is the name of the first image generation model from Meta Superintelligence Labs, rolled out in July 2026?", "Muse Image", [], "2026-07-07", FB + "2026/07/introducing-muse-image-meta-ai/"),
    ("What is the name of the model series Meta introduced on October 12, 2026, as its most capable to date?", "Muse Wonder", [], "2026-10-12", FB + "2026/10/introducing-muse-wonder-models/"),
    ("Meta's October 2026 model series gained an ability to carry what matters across conversations. What did Meta call it?", "Active Memory", [], "2026-10-12", FB + "2026/10/introducing-muse-wonder-models/"),
    ("Meta's October 2026 model series can keep working toward a goal when a task gets hard. What did Meta call this ability?", "Active Focus", [], "2026-10-12", FB + "2026/10/introducing-muse-wonder-models/"),
    ("What is the name of the subscription service Meta introduced in September 2026 with plans for individuals, creators and businesses?", "Meta One", [], "2026-09-15", FB + "2026/09/introducing-meta-one-subscription-service-more-features-ai/"),
    ("What are Meta's first-ever audio glasses, announced at Connect 2026, called?", "Ray-Ban Meta Audio", ["Ray Ban Meta Audio"], "2026-09-23", FB + "2026/09/introducing-ray-ban-meta-audio-glasses-new-styles-plus-muse/"),
    ("How many grams do the Ray-Ban Meta Audio glasses weigh?", "43", ["43 grams", "43g"], "2026-09-23", FB + "2026/09/introducing-ray-ban-meta-audio-glasses-new-styles-plus-muse/"),
    ("About how many grams do the Meta VR Glasses announced in September 2026 weigh?", "100", ["100 grams", "100g"], "2026-09-23", FB + "2026/09/introducing-meta-vr-glasses-3d-movies-immersive-live-sports-100-grams/"),
    ("What is the name of the petabit subsea cable Meta announced in September 2026?", "Petal", [], "2026-09-21", FB + "2026/09/announcing-petal-meta-petabit-transoceanic-cable/"),
    ("Meta's Petal subsea cable will connect the United States with which country?", "France", [], "2026-09-21", FB + "2026/09/announcing-petal-meta-petabit-transoceanic-cable/"),
    ("What did Mark Zuckerberg call the next major pillar of Meta's business, announced in September 2026, to help businesses use AI?", "Meta Enterprise Platform", [], "2026-09-28", FB + "2026/09/launching-meta-enterprise-platform/"),
    ("From which company did CJ Desai join Meta in September 2026 as Chief Enterprise Platform Officer?", "MongoDB", [], "2026-09-28", FB + "2026/09/launching-meta-enterprise-platform/"),
    ("Who joined Meta in September 2026 as Chief Enterprise Platform Officer?", "Chirantan Desai", ["CJ Desai", "Desai"], "2026-09-28", FB + "2026/09/launching-meta-enterprise-platform/"),
    ("What is the name of Meta's dedicated app for Facebook Groups, made available in the US in September 2026?", "Forum", [], "2026-09-29", FB + "2026/09/find-community-forum-dedicated-app-facebook-groups/"),
    ("Besides Oklo and TerraPower, which third company was part of Meta's January 2026 nuclear energy agreements?", "Vistra", [], "2026-01-09", FB + "2026/01/meta-nuclear-energy-projects-power-american-ai-leadership/"),
    ("In which Ohio town is Meta's Prometheus supercluster?", "New Albany", [], "2026-01-09", FB + "2026/01/meta-nuclear-energy-projects-power-american-ai-leadership/"),
    ("Which company signed an up to $6 billion fiber optic cable agreement with Meta in January 2026?", "Corning", [], "2026-01-27", FB + "2026/01/meta-6-billion-agreement-corning-support-us-manufacturing/"),
    ("Who joined Meta as President and Vice Chairman in January 2026?", "Dina Powell McCormick", ["Powell McCormick"], "2026-01-12", FB + "2026/01/dina-powell-mccormick-joins-meta-as-president-and-vice-chairman/"),
    ("Up to how many gigawatts of AMD Instinct GPUs did Meta agree to deploy in February 2026?", "6GW", ["6 GW", "6 gigawatts", "six gigawatts"], "2026-02-24", FB + "2026/02/meta-amd-partner-longterm-ai-infrastructure-agreement/"),
    ("In which Indiana city did Meta break ground on a 1GW data center in February 2026?", "Lebanon", [], "2026-02-11", FB + "2026/02/metas-new-data-center-lebanon-indiana-marks-milestone-ai-investment/"),
    ("How many new generations of its MTIA chips did Meta say in March 2026 it would deploy within two years?", "four", ["4"], "2026-03-11", FB + "2026/03/expanding-metas-custom-silicon-to-power-our-ai-workloads/"),
    ("What is the name of the data center CPU Arm developed with Meta as lead partner, announced in March 2026?", "Arm AGI CPU", ["AGI CPU"], "2026-03-24", FB + "2026/03/meta-partners-with-arm-to-develop-new-class-of-data-center-silicon/"),
    ("Which company did Meta expand a partnership with in April 2026 to co-develop multiple generations of MTIA chips?", "Broadcom", [], "2026-04-14", FB + "2026/04/meta-partners-with-broadcom-to-co-develop-custom-ai-silicon/"),
    ("In which Oklahoma city did Meta announce its first data center in the state in April 2026?", "Tulsa", [], "2026-04-21", FB + "2026/04/breaking-ground-new-ai-optimized-data-center-tulsa-oklahoma/"),
    ("Which AWS chips did Meta agree in April 2026 to bring into its compute portfolio, in the tens of millions of cores?", "Graviton", [], "2026-04-24", FB + "2026/04/meta-partners-with-aws-on-graviton-chips-to-power-agentic-ai/"),
    ("In which Indian city will Reliance build the 168 MW data center that Meta will lease, as announced in June 2026?", "Jamnagar", [], "2026-06-10", FB + "2026/06/meta-partners-with-reliance-on-ai-enabled-data-center-in-india/"),
    ("How many monthly active users did Meta say Threads had reached in June 2026?", "500 million", ["500M"], "2026-06-16", FB + "2026/06/meta-launching-new-features-500-million-monthly-threads-users/"),
    ("What is the AI product for businesses that Meta expanded globally on June 3, 2026, used on WhatsApp and Messenger?", "Meta Business Agent", ["Business Agent"], "2026-06-03", FB + "2026/06/meta-business-agent/"),
    ("At what US dollar price do the Meta Glasses line introduced in June 2026 start?", "299", ["$299"], "2026-06-23", FB + "2026/06/meta-essilorluxottica-partner-launch-meta-glasses/"),
    ("Which celebrity collaborated with Meta on a slim oval frame in the Meta Glasses line launched in June 2026?", "Kylie Jenner", ["Kylie"], "2026-06-23", FB + "2026/06/meta-essilorluxottica-partner-launch-meta-glasses/"),
    ("Which investment firm formed a venture with Meta in July 2026 to develop a Texas data center campus?", "BlackRock", [], "2026-07-28", FB + "2026/07/meta-announces-new-venture-with-blackrock-to-develop-data-center-in-el-paso/"),
    ("In which Texas city is the data center campus of the venture Meta announced with BlackRock in July 2026?", "El Paso", [], "2026-07-28", FB + "2026/07/meta-announces-new-venture-with-blackrock-to-develop-data-center-in-el-paso/"),
    ("In which Alberta county did Meta break ground in July 2026 on its first data center in Canada?", "Sturgeon County", ["Sturgeon"], "2026-07-08", FB + "2026/07/breaking-ground-on-metas-first-data-center-in-canada/"),
    ("What is the free selfie-based badge Meta introduced for people on Facebook in July 2026 called?", "Facebook Verified", [], "2026-07-24", FB + "2026/07/introducing-facebook-verified/"),
    ("How many attorneys general were part of the agreement on teen protections that Meta announced in August 2026?", "52", ["fifty-two"], "2026-08-26", FB + "2026/08/agreement-with-state-attorneys-general-supporting-teens/"),
    ("As of June 30, 2026, more than how many under-16 accounts had Meta removed in Australia?", "750,000", ["750000", "750 thousand"], "2026-08-13", FB + "2026/08/metas-compliance-with-australias-social-media-ban/"),
    ("How many US universities did Meta partner with in October 2026 to accelerate medical and scientific research?", "five", ["5"], "2026-10-28", FB + "2026/10/meta-partners-with-five-us-universities-to-accelerate-medical-and-scientific-breakthroughs/"),
    ("What is the WhatsApp feature launched in October 2026 that lets people without an account join a call?", "guest calling", ["guest calls"], "2026-10-14", FB + "2026/10/introducing-whatsapp-guest-calling/"),
    ("Up to how many people can join a WhatsApp group call that includes guests, under the feature launched in October 2026?", "32", [], "2026-10-14", FB + "2026/10/introducing-whatsapp-guest-calling/"),
]

_W = [
    ("Who was formally sworn in as acting president of Venezuela on January 5, 2026?", "Delcy Rodríguez", ["Rodríguez", "Rodriguez"], "2026-01-05"),
    ("In which country did the Southern Transitional Council announce its dissolution on January 9, 2026?", "Yemen", [], "2026-01-09"),
    ("What was the name of the Danish-led operation launched on January 14, 2026, sending European troops to Greenland?", "Operation Arctic Endurance", ["Arctic Endurance"], "2026-01-14"),
    ("Who won Uganda's January 2026 presidential election amid fraud allegations?", "Yoweri Museveni", ["Museveni"], "2026-01-15"),
    ("In which Pakistani city did a shopping mall fire kill 80 people on January 17, 2026?", "Karachi", [], "2026-01-17"),
    ("How many people were killed when two trains derailed in Adamuz, Spain, on January 18, 2026?", "46", [], "2026-01-18"),
    ("Which international organization did the United States officially leave on January 22, 2026?", "World Health Organization", ["WHO"], "2026-01-22"),
    ("Who was re-elected General Secretary of the Communist Party of Vietnam on January 23, 2026?", "Tô Lâm", ["To Lam"], "2026-01-23"),
    ("Who became the first female President of Bulgaria in January 2026?", "Iliana Iotova", ["Iotova"], "2026-01-23"),
    ("Which storm hit Malta in January 2026, when a capsized boat killed 50 people?", "Storm Harry", ["Harry"], "2026-01-23"),
    ("Whose body, recovered on January 26, 2026, was that of the last remaining Israeli hostage in Gaza?", "Ran Gvili", ["Gvili"], "2026-01-26"),
    ("With which country did the European Union sign a free trade agreement on January 27, 2026, after nearly two decades of talks?", "India", [], "2026-01-27"),
    ("Who became the first female Archbishop of Canterbury in January 2026?", "Sarah Mullally", ["Mullally"], "2026-01-28"),
    ("In which country is the Rubaya coltan mine, where collapses killed more than 600 people in January 2026?", "Democratic Republic of the Congo", ["DR Congo", "DRC", "Congo"], "2026-01-28"),
    ("Besides Portugal, which country was badly hit by Storm Kristin in January 2026?", "Spain", [], "2026-01-28"),
    ("Three million pages of which files were released to the public on January 30, 2026?", "Epstein files", ["Epstein"], "2026-01-30"),
    ("Who was elected president of Costa Rica on February 1, 2026?", "Laura Fernández", ["Fernández", "Fernandez"], "2026-02-01"),
    ("Which US-Russia nuclear arms treaty expired on February 5, 2026?", "New START", [], "2026-02-05"),
    ("In which two Italian places were the 2026 Winter Olympics held, starting February 6?", "Milan", ["Cortina"], "2026-02-06"),
    ("To which acting prime minister did Haiti's Transitional Presidential Council transfer power on February 7, 2026?", "Alix Didier Fils-Aimé", ["Fils-Aimé", "Fils-Aime", "Fils Aime"], "2026-02-07"),
    ("Which Japanese prime minister won a landslide in the February 8, 2026 general election?", "Sanae Takaichi", ["Takaichi"], "2026-02-08"),
    ("Which incumbent Thai prime minister won a plurality in Thailand's February 8, 2026 election?", "Anutin Charnvirakul", ["Anutin"], "2026-02-08"),
    ("Who was elected President of Portugal in February 2026, beating André Ventura in the runoff?", "António José Seguro", ["Seguro"], "2026-02-08"),
    ("In which Canadian town did a school mass shooting take place on February 10, 2026?", "Tumbler Ridge", [], "2026-02-10"),
    ("Which Barbados prime minister won every seat in the February 11, 2026 election?", "Mia Mottley", ["Mottley"], "2026-02-11"),
    ("Who led the Bangladesh Nationalist Party to a supermajority in the February 12, 2026 election?", "Tarique Rahman", ["Rahman"], "2026-02-12"),
    ("Which President of Peru was censured and removed by Congress on February 17, 2026?", "José Jerí", ["Jerí", "Jeri"], "2026-02-17"),
    ("Who succeeded José Jerí as President of Peru in February 2026?", "José María Balcázar", ["Balcázar", "Balcazar"], "2026-02-17"),
    ("Which Jalisco New Generation Cartel leader was killed in a military operation in Tapalpa on February 22, 2026?", "El Mencho", ["Mencho"], "2026-02-22"),
    ("Who was sworn in as Prime Minister of the Netherlands on February 23, 2026?", "Rob Jetten", ["Jetten"], "2026-02-23"),
    ("Which Iranian Supreme Leader was killed in the attacks by Israel and the United States on February 28, 2026?", "Ali Khamenei", ["Khamenei"], "2026-02-28"),
    ("Which Iranian warship did a US nuclear submarine sink off Sri Lanka on March 4, 2026?", "IRIS Dena", ["Dena"], "2026-03-04"),
    ("Which US nuclear submarine sank an Iranian warship in the Indian Ocean on March 4, 2026?", "USS Charlotte", ["Charlotte"], "2026-03-04"),
    ("Who led the Rastriya Swatantra Party to a landslide in Nepal's March 5, 2026 election?", "Balen Shah", ["Balendra Shah", "Shah"], "2026-03-05"),
    ("Who was selected as the third Supreme Leader of Iran on March 8, 2026?", "Mojtaba Khamenei", ["Mojtaba"], "2026-03-08"),
    ("Which country won the 2026 Men's T20 World Cup, on March 8?", "India", [], "2026-03-08"),
    ("Which Iranian oil export hub did the US Air Force bomb on March 13, 2026?", "Kharg Island", ["Kharg"], "2026-03-13"),
    ("Which country accepted a new constitution by referendum on March 15, 2026, with 90% in favor?", "Kazakhstan", [], "2026-03-15"),
    ("Who won the Republic of the Congo's presidential election on March 15, 2026?", "Denis Sassou Nguesso", ["Sassou Nguesso", "Sassou"], "2026-03-15"),
    ("Airstrikes by which country hit a hospital in Kabul on March 16, 2026, killing at least 400?", "Pakistan", ["Pakistani"], "2026-03-16"),
    ("Which Secretary of Iran's Supreme National Security Council was killed by an Israeli airstrike on March 17, 2026?", "Ali Larijani", ["Larijani"], "2026-03-17"),
    ("Which Danish prime minister's coalition lost its majority in the March 24, 2026 election?", "Mette Frederiksen", ["Frederiksen"], "2026-03-24"),
    ("Which NASA mission launched on April 1, 2026, the first crewed flight beyond low Earth orbit since Apollo 17?", "Artemis II", ["Artemis 2"], "2026-04-01"),
    ("What was the maximum distance from Earth, in miles, reached by the Artemis II crew in April 2026?", "252,756", ["252756"], "2026-04-06"),
    ("Near which US city did the Artemis II crew splash down on April 10, 2026?", "San Diego", [], "2026-04-10"),
    ("Whom did Vietnam's National Assembly elect president on April 7, 2026, replacing Lương Cường?", "Tô Lâm", ["To Lam"], "2026-04-07"),
    ("How long was the ceasefire the United States and Iran agreed on April 7, 2026?", "two weeks", ["two-week", "2 weeks", "2-week", "14 days", "14-day"], "2026-04-07"),
    ("Who was re-elected for a sixth term as President of Djibouti in April 2026?", "Ismaïl Omar Guelleh", ["Guelleh"], "2026-04-10"),
    ("Whom did the Iraqi Parliament elect as President of Iraq on April 11, 2026?", "Nizar Amidi", ["Amidi"], "2026-04-11"),
    ("Who defeated Viktor Orbán in Hungary's April 12, 2026 parliamentary election?", "Péter Magyar", ["Magyar"], "2026-04-12"),
    ("What is the name of the party that ended 16 years of Fidesz rule in Hungary in April 2026?", "Tisza", ["Tisza Party"], "2026-04-12"),
    ("Who won Benin's presidential election on April 12, 2026, with over 94% of the vote?", "Romuald Wadagni", ["Wadagni"], "2026-04-12"),
    ("How many days was the US-brokered ceasefire between Israel and Lebanon that took effect on April 16, 2026?", "10", ["ten", "10-day"], "2026-04-16"),
    ("Which former Bulgarian president led Progressive Bulgaria to a landslide on April 19, 2026?", "Rumen Radev", ["Radev"], "2026-04-19"),
    ("Which Malian city did the Azawad Liberation Front and JNIM capture in the April 25, 2026 offensives?", "Kidal", [], "2026-04-25"),
    ("Which country left OPEC on May 1, 2026?", "United Arab Emirates", ["UAE"], "2026-05-01"),
    ("In which Chinese city did a fireworks factory explosion kill 37 people on May 4, 2026?", "Liuyang", [], "2026-05-04"),
    ("Which Bahamian prime minister won a second term on May 12, 2026?", "Philip Davis", ["Davis"], "2026-05-12"),
    ("Which city hosted the Eurovision Song Contest 2026?", "Vienna", [], "2026-05-16"),
    ("Which country won the Eurovision Song Contest 2026, its first win?", "Bulgaria", [], "2026-05-16"),
    ("What was the winning song at the Eurovision Song Contest 2026?", "Bangaranga", [], "2026-05-16"),
    ("Who won the Eurovision Song Contest 2026?", "Dara", [], "2026-05-16"),
    ("Which Hamas military commander was killed by an Israeli strike on May 15, 2026?", "Izz al-Din al-Haddad", ["al-Haddad", "Haddad"], "2026-05-15"),
    ("Which Ebola virus species caused the outbreak the WHO declared a public health emergency of international concern on May 16, 2026?", "Bundibugyo", [], "2026-05-16"),
    ("Who defeated Ulisses Correia e Silva in Cape Verde's May 17, 2026 parliamentary election?", "Francisco Carvalho", ["Carvalho"], "2026-05-17"),
    ("Which former Cuban leader did the United States indict on May 20, 2026, over the 1996 Brothers to the Rescue shootdown?", "Raúl Castro", ["Raul Castro", "Castro"], "2026-05-20"),
    ("In which Chinese province is the Liushenyu coal mine, where a gas explosion killed 82 people on May 22, 2026?", "Shanxi", [], "2026-05-22"),
    ("Which Maltese prime minister won a fourth consecutive election for Labour on May 30, 2026?", "Robert Abela", ["Abela"], "2026-05-30"),
    ("In which country did the Flamingo Revolution protests break out on May 31, 2026?", "Albania", [], "2026-05-31"),
    ("Whose proposed luxury development in Zvërnec set off Albania's May 2026 protests?", "Jared Kushner", ["Kushner"], "2026-05-31"),
    ("Which satirical Indian youth movement started the June 2026 protests at Jantar Mantar in New Delhi?", "Cockroach Janta Party", [], "2026-06-06"),
    ("Who won Peru's June 7, 2026 presidential runoff?", "Keiko Fujimori", ["Fujimori"], "2026-06-07"),
    ("What was the magnitude of the earthquake that struck the Philippines on June 8, 2026?", "7.8", [], "2026-06-08"),
    ("Which 19th century railway did Turkey and Saudi Arabia agree to revive on June 9, 2026?", "Hejaz railway", ["Hejaz"], "2026-06-09"),
    ("Which Barcelona church's tallest tower did Pope Leo XIV bless on June 10, 2026?", "Sagrada Família", ["Sagrada Familia"], "2026-06-10"),
    ("What climate event did NOAA declare the onset of on June 11, 2026?", "El Niño", ["El Nino"], "2026-06-11"),
    ("Who became the first US dollar trillionaire on June 12, 2026?", "Elon Musk", ["Musk"], "2026-06-12"),
    ("The initial public offering of which company made Elon Musk a trillionaire in June 2026?", "SpaceX", [], "2026-06-12"),
    ("Which American singer-songwriter was killed in a helicopter collision in Rio de Janeiro on June 14, 2026?", "Oliver Tree", [], "2026-06-14"),
    ("What was the name of the 14-point agreement the United States and Iran signed in June 2026?", "Islamabad Memorandum", [], "2026-06-17"),
    ("Who won Colombia's presidential runoff on June 21, 2026, against Iván Cepeda?", "Abelardo de la Espriella", ["de la Espriella"], "2026-06-21"),
    ("Which UK prime minister announced his resignation on June 22, 2026?", "Keir Starmer", ["Starmer"], "2026-06-22"),
    ("At least how many people were killed by the two earthquakes in western Venezuela on June 24, 2026?", "6,500", ["6500"], "2026-06-24"),
    ("Which women's cricket team won the 2026 Women's T20 World Cup, on July 5?", "Australia", [], "2026-07-05"),
    ("Which traditionalist Catholic society consecrated four bishops at Écône on July 1, 2026, against Pope Leo XIV's orders?", "Society of Saint Pius X", ["SSPX", "Society of St. Pius X"], "2026-07-01"),
    ("Which Turkish city hosted the 2026 NATO summit in July?", "Ankara", [], "2026-07-07"),
    ("Which country's Olympic committee did the IOC lift a ban on, on July 7, 2026?", "Russia", ["Russian"], "2026-07-07"),
    ("Which British runner broke the mile world record on July 18, 2026?", "Josh Kerr", ["Kerr"], "2026-07-18"),
    ("What was Josh Kerr's world record time for the mile in July 2026?", "3:42.66", ["3 42 66"], "2026-07-18"),
    ("Which country won the 2026 FIFA World Cup?", "Spain", [], "2026-07-19"),
    ("Which team lost the 2026 FIFA World Cup final?", "Argentina", [], "2026-07-19"),
    ("Who scored the only goal of the 2026 FIFA World Cup final?", "Ferran Torres", ["Torres"], "2026-07-19"),
    ("Who became Prime Minister of the United Kingdom on July 20, 2026?", "Andy Burnham", ["Burnham"], "2026-07-20"),
    ("Which Red Sea strait did the Houthis declare a maritime blockade on against Saudi Arabia on July 20, 2026?", "Bab el-Mandeb", ["Bab al-Mandeb", "Bab-el-Mandeb"], "2026-07-20"),
    ("Which Nicaraguan co-president announced an end to elections on July 20, 2026?", "Daniel Ortega", ["Ortega"], "2026-07-20"),
    ("Which Scottish city hosted the 2026 Commonwealth Games?", "Glasgow", [], "2026-07-23"),
    ("Which Japanese prefecture was struck by an earthquake that killed at least 30 on July 28, 2026?", "Kumamoto", [], "2026-07-28"),
    ("Into which Spanish enclave did about 80,000 people cross illegally from Morocco on July 30, 2026?", "Ceuta", [], "2026-07-30"),
    ("On which Karakoram peak did an avalanche kill ten climbers, including Nirmal Purja, on July 30, 2026?", "Broad Peak", [], "2026-07-30"),
    ("What new official name did the Republic of Nauru adopt on July 30, 2026?", "Naoero", ["Republic of Naoero"], "2026-07-30"),
    ("How many nations were in the military alliance Saudi Arabia announced on July 30, 2026, to protect navigation in the Red Sea?", "14", ["fourteen"], "2026-07-30"),
    ("What mutual defence pact did Saudi Arabia, Pakistan and Turkey sign on August 7, 2026?", "Mecca Defence Alliance", ["Mecca Defense Alliance"], "2026-08-07"),
    ("What was the magnitude of the earthquake that struck Colombia on August 10, 2026?", "7.4", [], "2026-08-10"),
    ("Which ousted president did a Damascus court sentence to death in absentia on August 11, 2026?", "Bashar al-Assad", ["Assad"], "2026-08-11"),
    ("In which country is the Lake Kariba ferry capsizing of August 11, 2026, called its deadliest boat disaster?", "Zimbabwe", [], "2026-08-11"),
    ("The total solar eclipse of August 12, 2026, was the first in continental Europe since what year?", "1999", [], "2026-08-12"),
    ("Who won Zambia's presidential election on August 13, 2026?", "Hakainde Hichilema", ["Hichilema"], "2026-08-13"),
    ("In which country is the island of Flores, where a magnitude 7.8 quake killed at least 142 on August 15, 2026?", "Indonesia", [], "2026-08-15"),
    ("Which armed group announced its integration into the Syrian Army on August 20, 2026?", "Syrian Democratic Forces", ["SDF"], "2026-08-20"),
    ("Which pro-Tokayev party won a supermajority in Kazakhstan's new Kurultai on August 23, 2026?", "Ädilet", ["Adilet"], "2026-08-23"),
    ("Which country did the US remove from its list of state sponsors of terrorism on August 24, 2026, after being on it since 1979?", "Syria", [], "2026-08-24"),
    ("Which King of Norway died on August 28, 2026?", "Harald V", ["Harald"], "2026-08-28"),
    ("Who succeeded the King of Norway after his death on August 28, 2026?", "Haakon", ["Haakon VIII"], "2026-08-28"),
    ("Which country's voters rejected continuing European Union membership negotiations in an August 29, 2026 referendum?", "Iceland", [], "2026-08-29"),
    ("Which Nigerien president was the target of a coup attempt on August 29, 2026?", "Abdourahamane Tiani", ["Tiani"], "2026-08-29"),
    ("Which NASA space telescope launched on August 30, 2026?", "Nancy Grace Roman", ["Roman Space Telescope", "Roman"], "2026-08-30"),
    ("On which rocket did the Nancy Grace Roman Space Telescope launch in August 2026?", "Falcon Heavy", [], "2026-08-30"),
    ("Who was elected president of Estonia on September 2, 2026?", "Ülle Madise", ["Ulle Madise", "Madise"], "2026-09-02"),
    ("Which map projection did a UN resolution of September 4, 2026, call for wider use of over the Mercator?", "Equal Earth", [], "2026-09-04"),
    ("Which city hosted the 2026 FIBA Women's Basketball World Cup in September?", "Berlin", [], "2026-09-13"),
    ("Which Yemeni Red Sea city did the Houthis take on September 10, 2026?", "Mokha", ["Mocha"], "2026-09-10"),
    ("Who led Sweden's left-wing bloc to a narrow majority in the September 13, 2026 election?", "Magdalena Andersson", ["Andersson"], "2026-09-13"),
    ("Which former Kosovo president was sentenced to 25 years for war crimes on September 16, 2026?", "Hashim Thaçi", ["Thaçi", "Thaci"], "2026-09-16"),
    ("What is the scientific name of the wild cat of Bolivia reported on September 17, 2026, as the first new feline species since 1923?", "Leopardus tilcayo", ["tilcayo"], "2026-09-17"),
    ("Which Greenlandic prime minister signed the Greenland defense agreement with Donald Trump and Mette Frederiksen on September 22, 2026?", "Jens-Frederik Nielsen", ["Nielsen"], "2026-09-22"),
    ("Which party kept its parliamentary majority in Russia's September 2026 legislative election?", "United Russia", [], "2026-09-20"),
    ("Which Japanese prefecture hosted the 2026 Asian Games?", "Aichi", [], "2026-09-19"),
    ("Who became Morocco's first female prime minister after the September 23, 2026 election?", "Fatima Ezzahra El Mansouri", ["El Mansouri", "Mansouri"], "2026-09-23"),
    ("How many functional Starlink V3 satellites did SpaceX Starship deploy on September 28, 2026?", "26", [], "2026-09-28"),
    ("How many barrels of oil did G7 leaders agree to release on October 2, 2026?", "100 million", ["100M"], "2026-10-02"),
    ("Which Latvian prime minister's United List won a plurality on October 3, 2026?", "Andris Kulbergs", ["Kulbergs"], "2026-10-03"),
    ("Whom did the Assembly of Kosovo elect president on October 6, 2026?", "Justina Shiroka Pula", ["Shiroka Pula", "Shiroka-Pula"], "2026-10-06"),
    ("Off the coast of which country was the world's oldest shipwreck reported on October 13, 2026?", "Turkey", ["Türkiye", "Turkiye"], "2026-10-13"),
    ("What did the General Conference on Weights and Measures vote on October 15, 2026, to abolish in future?", "leap seconds", ["leap second"], "2026-10-15"),
    ("Besides Andorra, which country signed an association agreement with the EU on October 19, 2026?", "San Marino", [], "2026-10-19"),
    ("What name was given to the two critical PHP vulnerabilities leaked online on October 20, 2026?", "PHP2Shell", [], "2026-10-20"),
    ("In which country did a mass shooting occur at a Greek Orthodox church in Karak on October 23, 2026?", "Jordan", [], "2026-10-23"),
    ("Which country won the Junior Eurovision Song Contest 2026?", "Armenia", [], "2026-10-24"),
    ("Who won Brazil's presidential runoff on October 25, 2026?", "Luiz Inácio Lula da Silva", ["Lula"], "2026-10-25"),
    ("Whom did Lula defeat in Brazil's October 25, 2026 presidential runoff?", "Flávio Bolsonaro", ["Flavio Bolsonaro", "Bolsonaro"], "2026-10-25"),
    ("Which electoral list won a majority in Serbia's October 25, 2026 parliamentary election?", "Student List", [], "2026-10-25"),
    ("Who leads the Yashar party, the head of the opposition bloc in Israel's October 27, 2026 election?", "Gadi Eisenkot", ["Eisenkot"], "2026-10-27"),
    ("In which Spanish town did two high speed trains collide on October 28, 2026?", "Los Yébenes", ["Los Yebenes", "Yebenes"], "2026-10-28"),
    ("Who won the 2026 Nobel Peace Prize?", "Navi Pillay", ["Pillay"], "2026-10-15", "window"),
    ("Who won the 2026 Nobel Prize in Literature?", "Anne Carson", ["Carson"], "2026-10-15", "window"),
    ("Who won the 2026 Nobel Prize in Physics?", "Francis Halzen", ["Halzen"], "2026-10-15", "window"),
    ("Which researcher shared the 2026 Nobel Prize in Chemistry with Kensō Soai?", "Henri Kagan", ["Henri B. Kagan", "Kagan"], "2026-10-15", "window"),
    ("Name a winner of the 2026 Nobel Prize in Economics.", "Robert Hall", ["Robert E. Hall", "Michael Woodford", "Woodford"], "2026-10-15", "window"),
    ("Name a winner of the 2026 Nobel Prize in Physiology or Medicine.", "Karl Deisseroth", ["Deisseroth", "Peter Hegemann", "Hegemann", "Georg Nagel", "Nagel"], "2026-10-15", "window"),
]
WORLD = [(q, a, al, d, W26, *rest) for q, a, al, d, *rest in _W]


def ascii_fold(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "salient_probes.jsonl")
    rows, seen = [], set()
    for topic, items in (("ai", AI), ("meta", META), ("world", WORLD)):
        for item in items:
            q, a, aliases, date, url = item[:5]
            precision = item[5] if len(item) > 5 else "day"
            if q in seen:
                raise ValueError("repeat: " + q)
            seen.add(q)
            if not "2026-01-04" <= date <= "2026-10-29":
                raise ValueError("date out of range: " + q)
            names = []
            for x in [*aliases, ascii_fold(a), *map(ascii_fold, aliases)]:
                if x != a and x not in names:
                    names.append(x)
            for x in [a, *names]:
                if re.search(r"(?<!\w)" + re.escape(x.lower()) + r"(?!\w)", q.lower()) and len(x) > 2:
                    print("answer text in question:", repr(x), "|", q)
            rows.append({"id": f"salient-{len(rows):03d}", "topic": topic, "question": q, "answer": a, "aliases": names,
                         "date": date, "date_precision": precision, "source_url": url})
    with open(out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    counts = {t: sum(r["topic"] == t for r in rows) for t in ("ai", "meta", "world")}
    print(len(rows), counts, out)


if __name__ == "__main__":
    main()
