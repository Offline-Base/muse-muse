// Muse Privacy landing page: nav menus, the install card, the model row and the demo.
// Demo tags are the guard's real output on one laptop. No inline styles, so the page's CSP can stay strict.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  // ----- nav menus: one open at a time, closed by an outside click, Escape or a link -----
  const menus = [...document.querySelectorAll(".menu")];
  menus.forEach((m) => m.addEventListener("toggle", () => {
    if (m.open) menus.forEach((o) => { if (o !== m) o.open = false; });
  }));
  document.addEventListener("click", (e) => {
    menus.forEach((m) => { if (m.open && (!m.contains(e.target) || e.target.closest(".menu-panel a"))) m.open = false; });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menus.forEach((m) => { m.open = false; }); });

  // ----- install card: Laptop and Jetson tabs, and the copy button -----
  const install = $("install");
  if (install) {
    const tabs = [...install.querySelectorAll("[role=tab]")];
    tabs.forEach((t) => t.addEventListener("click", () => {
      tabs.forEach((o) => { const on = o === t; o.setAttribute("aria-selected", String(on)); $(o.dataset.target).hidden = !on; });
    }));
    const copy = install.querySelector(".copy");
    copy.addEventListener("click", async () => {
      const shown = tabs.map((t) => $(t.dataset.target)).find((p) => !p.hidden);
      try {
        await navigator.clipboard.writeText(shown.textContent);
        copy.classList.add("done");
        copy.setAttribute("aria-label", "Copied");
        setTimeout(() => { copy.classList.remove("done"); copy.setAttribute("aria-label", "Copy the commands"); }, 1600);
      } catch (e) { /* the browser did not allow the clipboard here */ }
    });
  }

  // ----- model row: arrows scroll it when it does not fit -----
  const row = $("model-cards");
  if (row) {
    const arrows = [...document.querySelectorAll("#models .arrow")];
    const sync = () => {
      arrows[0].disabled = row.scrollLeft <= 2;
      arrows[1].disabled = row.scrollLeft >= row.scrollWidth - row.clientWidth - 2;
    };
    arrows.forEach((a) => a.addEventListener("click", () => {
      const card = row.querySelector(".model");
      row.scrollBy({ left: Number(a.dataset.dir) * (card.offsetWidth + 18), behavior: reduce ? "auto" : "smooth" });
    }));
    row.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    sync();
  }

  // ----- demo -----
  const stage = $("demo-stage");
  if (!stage) return;

  const tg = (t) => `<span class="tg">${t}</span>`;
  const nm = (t) => `<span class="nm">${t}</span>`;
  const ht = (t) => `<span class="ht">${t}</span>`;
  const map = (raw, tag) => `${nm(raw)} <span class="ar">→</span> ${tg(tag)}`;
  // Events: a chat line in Muse, a terminal line on the device, the light, the approval popup.
  const C = (k, html) => ({ c: { k, html } });
  const T = (k, html) => ({ t: { k, html } });
  const L = (light) => ({ l: light });
  const P = (html) => ({ p: html });
  const PRESS = { press: true };

  const WAITING = "Waiting for your OK on the device.";
  const KEPT_TOPIC = "Kept on your device. It mentions a topic you never share.";
  const KEPT_RULES = "Kept on your device. Your rules say results like this stay on the device.";
  const card = (asked, leaving, why) => `<p class="pt">Approval page · on this laptop</p><p class="pm">${asked}</p>`
    + `<div class="pp">${leaving}</div>${why ? `<p class="pw">${why}</p>` : ""}`
    + `<div class="pb"><span class="go">Share it</span><span>Keep it here</span></div>`;

  const grading = {
    name: "Grading essays",
    note: "Scores are examples. Sequences are shortened.",
    steps: [
      { label: "The ask", text: "A teacher asks Muse to grade the 24 essays in her class folder against her rubric. Muse plans the job in its cloud VM. It has not seen a single essay.",
        seq: [C("you", "Grade each essay in my essays folder against rubric.md and draft feedback for each student."), T("dim", "Relay client connected. It dialed out; nothing here listens on the internet.")] },
      { label: "Tags, not names", text: "Muse calls list_documents. The call reaches the laptop through the relay, which the laptop dials out to. Every name in the titles comes back as a tag, and the letters are shuffled on each device.",
        seq: [C("tool", "→ list_documents(\"essays\")"), T("cmd", "list_documents(\"essays\")"), T("line", "Read 24 essays in essays/"),
          T("map", map("Abigail Thornbury", "[Student L]")), T("map", map("Benjamin Adeyemi", "[Student R]")), T("dim", "… and 22 more names"),
          T("route-tagged", "share tagged, titles only"), L("send"),
          C("result", `24 documents in folder essays:<br>- ${tg("[Student L]")}: Should our school have a garden? …<br>- ${tg("[Student R]")}: Should our school have a garden? …<br>…`)] },
      { label: "Glimmer grades", text: "Muse starts run_private_task and gets a job id. Every name and identifier becomes a tag before Glimmer reads an essay. Glimmer grades each one against the rubric, and the feedback files with real names are written only on the laptop.",
        seq: [C("tool", "→ run_private_task(\"Grade each essay against rubric.md …\")"), T("cmd", "run_private_task · job b0404e58"), C("result", "Job b0404e58 started on the device."), L("ok"),
          T("line", `Opened essays/${nm("Abigail Thornbury")}.md`), T("line", `Glimmer reads: # ${tg("[Student L]")}: Should our school have a garden?`),
          T("check", "Muse Glimmer graded 24 of 24 tagged essays"), T("line", `Wrote ${nm("Abigail Thornbury")} feedback.md and 23 more, on this laptop only`)] },
      { label: "One exit", text: "Before the grades can go back, egress tags names and identifiers again, asks Glimmer for any name the roster missed, and reads who Muse's request is for.",
        seq: [T("check", "Tag names and IDs"), T("check", "Name pass: no new names"), T("check", "Who is it for: nothing flagged")] },
      { label: "Asks first", text: "This teacher wants to see per-student grades before they go, so the privacy router picks Ask you first. A card appears on the approval page the device serves, and Muse hears: Waiting for your OK on the device.",
        seq: [T("route-ask", "ask you first"), L("wait"), P(card("Muse asked to grade the essays.", `${tg("[Student L]")} 14/16<br>${tg("[Student R]")} 12/16 …`)),
          C("tool", "→ get_result(\"b0404e58\")"), C("wait", WAITING)] },
      { label: "Share it", text: "She presses Share it on her laptop. The exact tagged table passes the final leak check, and Muse gets the grades by tag. The real names never leave.",
        seq: [PRESS, P(null), T("line", "She pressed Share it"), T("check", "Final leak check: 0 hits"), L("send"), T("send", "Sent to Muse: 24 rows, tags only"),
          C("result", `${tg("[Student L]")} 14/16 · next: add a third reason<br>${tg("[Student R]")} 12/16 · next: explain your example<br>${tg("[Student S]")} 10/16 · next: check your spelling<br>… 21 more rows`)] },
      { label: "Dreaming", text: "At 2 AM a scheduled Muse job starts dreaming. The device rebuilds the router's rules from her approve and deny answers and keeps them only if they score no worse on a holdout set, with zero leaks. Muse gets numbers, not her decisions.",
        seq: [C("tool", "2:00 AM, scheduled → run_dreaming()"), T("cmd", "run_dreaming"), L("ok"), T("line", "Rebuilt the router's rules from her answers"),
          T("check", "Holdout no worse, 0 leaks: rules kept"), L("send"), C("result", "Last night: rules rebuilt from your answers. Leaks: 0.")] },
      { label: "Results", text: "Every final run checked what Muse received for names and identifiers: 0 leaks. On 100 unseen items, accuracy rose from 72% to 81% after five nights, and approval requests fell from 10 to 6 a day. Measured with Glimmer on OpenRouter and invented students.",
        seq: [L("idle")] },
    ],
  };

  const search = {
    name: "Searching essays",
    note: "A real Muse app session, Oct 28, 11:34 PM ET, replayed from the laptop's decision log.",
    steps: [
      { label: "In the Muse app", text: "On Oct 28 the Muse app was paired with a laptop through the relay, and the teacher asked Muse to find essays that mention tomatoes.",
        seq: [C("you", "Search my private documents for essays that mention tomatoes."), T("dim", "Relay client connected, paired with the Muse app.")] },
      { label: "Keyword search", text: "Muse called search_documents and wrote its own purpose. A keyword search on the laptop (BM25, no model) picked the five best snippets, and the guard swapped every name for a tag.",
        seq: [C("tool", "→ search_documents(\"tomatoes\", purpose: \"for the user, to find essays mentioning tomatoes\")"), T("cmd", "search_documents(\"tomatoes\")"), L("ok"),
          T("dim", "purpose: \"for the user, to find essays mentioning tomatoes\""), T("line", "BM25 picked 5 snippets from 24 essays"),
          T("map", map("Esperanza Moreno-Baptiste", "[Student C]")), T("dim", "… and 4 more names")] },
      { label: "A street", text: "Before anything leaves, the device scans the result for topics this teacher never shares. Snippet 5 says a grandmother grows vegetables in her backyard on Fennel Street, and a home address is one of those topics.",
        seq: [T("line", `5. ${tg("[Student C]")}: … in her backyard on ${ht("Fennel Street")} …`), T("flag", "Never-share topic: home address")] },
      { label: "Kept", text: "A never-share topic is a floor: the router keeps the result without asking, and no model answer or learned rule can loosen it. Muse got one fixed sentence that repeats nothing from the essays.",
        seq: [T("route-keep", "keep it"), L("idle"), T("dim", "Muse gets a fixed sentence, nothing from the essays"), C("keep", KEPT_TOPIC)] },
      { label: "The cost", text: "Muse got none of the five snippets, not even the four with no street in them. If she would rather decide herself, one line in her policy marks home addresses as ask first, and the device shows her a card instead.",
        seq: [] },
    ],
  };

  const health = {
    name: "Health notes",
    note: "Sequences are shortened.",
    steps: [
      { label: "The ask", text: "The teacher asks Muse which students have allergies or asthma to plan for on garden day. The answers are in the school nurse's notes on her laptop.",
        seq: [C("you", "Which students have allergies or asthma we need to plan for on garden day?")] },
      { label: "Search", text: "Muse calls search_documents with a purpose. The nurse's notes match, and every name and date of birth in the snippets becomes a tag.",
        seq: [C("tool", "→ search_documents(\"allergies asthma\", purpose: \"for garden day planning\")"), T("cmd", "search_documents(\"allergies asthma\")"), L("ok"),
          T("line", "Matched records/health_office.md"), T("map", map("Farhan Siddiqui", "[Student U]")), T("map", map("3/14/2017", "[DOB 1]")),
          T("map", map("Maya Lindqvist", "[Student Q]")), T("map", map("5/9/2017", "[DOB 2]"))] },
      { label: "Never-share words", text: "A health detail can point to one child even without a name. The device scans the result for words her policy never shares and finds allergy, EpiPen, asthma and inhaler, which are medical.",
        seq: [T("line", `${tg("[Student U]")}: severe ${ht("allergy")} to bee and wasp stings. ${ht("EpiPen")} in the nurse's office.`),
          T("line", `${tg("[Student Q]")}: ${ht("asthma")}. ${ht("Inhaler")} in her backpack.`), T("flag", "Never-share topic: medical")] },
      { label: "Kept", text: "A never-share topic in a result is a floor: the router keeps it without asking. Muse gets one fixed sentence that repeats nothing from the notes.",
        seq: [T("route-keep", "keep it"), L("idle"), C("keep", KEPT_TOPIC)] },
      { label: "Results", text: "On a first day, 23 of 25 results the simulated teacher would refuse were kept and the other 2 were asked about; none was shared. Muse can help plan garden day in general terms without learning who carries an EpiPen.",
        seq: [] },
    ],
  };

  const IDS_ANSWER = `${tg("[Student X]")}: form not signed. Fee paid with ${tg("[Card 1]")}. The form also lists an SSN (${tg("[SSN 1]")}), which a field trip form does not need.`;
  const ids = {
    name: "SSN and card numbers",
    note: "The form is an example made for this page.",
    steps: [
      { label: "The ask", text: "The teacher asks Muse which field trip forms are complete. One guardian wrote far more than the form needs: a Social Security number, a card number for the fee, a date of birth and a phone number.",
        seq: [C("you", "Check the field trip forms in my forms folder. Which are complete, and what is missing?")] },
      { label: "Private task", text: "Muse calls run_private_task and gets a job id. The device opens the forms. Everything in red exists only on the laptop.",
        seq: [C("tool", "→ run_private_task(\"Check the field trip forms …\", folder: \"forms\")"), T("cmd", "run_private_task · job 7c1e09a2"), C("result", "Job 7c1e09a2 started on the device."), L("ok"),
          T("line", `Opened forms/${nm("Dashiell Kowalczyk")} field trip form.md and 23 more`)] },
      { label: "Exact checks", text: "Before Glimmer reads a form, exact checks swap names and eight kinds of identifier for tags: SSNs, Luhn-checked cards, dates of birth, phones, emails, student IDs, addresses and one-time codes. The same value always gets the same tag.",
        seq: [T("map", map("Dashiell Kowalczyk", "[Student X]")), T("map", map("555-0109", "[Phone 1]")), T("map", map("1/22/2017", "[DOB 3]")),
          T("map", map("900-12-3456", "[SSN 1]")), T("map", map("4111 1111 1111 1111", "[Card 1]"))] },
      { label: "Asks first", text: "Glimmer answers from the tagged form. Egress tags the answer again and finds a card number and an SSN in it. Any identifier in a result sets a floor: she is asked first, whatever rules she has taught.",
        seq: [T("line", "Muse Glimmer answered from the tagged form"), T("flag", "In the answer: a card number, a Social Security number"), T("route-ask", "ask you first"), L("wait"),
          P(card("Muse asked to check the forms.", `${tg("[Student X]")}: form not signed. Fee paid with ${tg("[Card 1]")} …`, "Contains a card number, a Social Security number.")),
          C("tool", "→ get_result(\"7c1e09a2\")"), C("wait", WAITING)] },
      { label: "Share it", text: "She presses Share it. The final leak check scans the exact text for identifiers and every real value in the tag map; any hit and Muse would get Held on your device instead. This one is clean, so Muse gets it tagged.",
        seq: [PRESS, P(null), T("check", "Final leak check: 0 hits"), L("send"), T("send", "Sent to Muse, tags only"), C("result", IDS_ANSWER)] },
      { label: "Results", text: "Muse can follow up on the missing signature by tag. The SSN and the card number exist only on the laptop, and Glimmer never read them either.",
        seq: [L("idle")] },
    ],
  };

  const average = {
    name: "Class average",
    note: "The summary is an example made for this page.",
    steps: [
      { label: "The ask", text: "After grading, the teacher wants to know how the class did as a whole. A class-level answer doesn't need anyone's name.",
        seq: [C("you", "How did the class do on the garden essays overall? Just the big picture.")] },
      { label: "Glimmer reads", text: "Muse calls run_private_task. Glimmer reads each tagged essay on the device and writes one answer from all 24. That answer still talks about students by tag.",
        seq: [C("tool", "→ run_private_task(\"How did the class do overall …\")"), T("cmd", "run_private_task · job 3fa21d77"), C("result", "Job 3fa21d77 started on the device."), L("ok"),
          T("check", "Muse Glimmer read 24 tagged essays"), T("line", `Answer: ${tg("[Student L]")} and ${tg("[Student R]")} gave three reasons; ${tg("[Student S]")} gave one …`)] },
      { label: "Class-level", text: "Glimmer labels Muse's request as a class-level question: an average, a count or a pattern, not per-student detail. The router picks Share a summary.",
        seq: [T("check", "Who is it for: a class-level question"), T("route-summary", "share a summary")] },
      { label: "Summary", text: "Glimmer rewrites the answer as counts and patterns, and the guard tags it again. If a summary can't avoid per-student detail, the result stays on the device.",
        seq: [T("line", "Muse Glimmer wrote a class-level summary"), T("check", "Final leak check: 0 hits"), L("send"), T("send", "Sent to Muse: the summary"),
          C("result", "17 of 24 essays gave at least two reasons. The most common gap was a closing sentence. Spelling slips were the most common Conventions issue.")] },
      { label: "Results", text: "On a first day, all 25 class-level results were shared as summaries. Glimmer spots class-level requests with precision and recall of 0.94, against a keyword list's 0.92 and 0.67.",
        seq: [L("idle")] },
    ],
  };

  const realname = {
    name: "A real name",
    note: "A test the device has to pass every time.",
    steps: [
      { label: "The ask", text: "Someone asks Muse who a tag really is. No tool returns a real name, so Muse has to ask the device.",
        seq: [C("you", `What is ${tg("[Student S]")}'s real name?`)] },
      { label: "Her rules", text: "On the device the tag is swapped back so the search can run, and the request is checked against her rules. One refuses any request for a real or full name, in code, whatever a model answers. Glimmer also labels it: it asks who a tag is.",
        seq: [C("tool", `→ search_documents("${tg("[Student S]")} real name")`), T("cmd", "search_documents(\"[Student S] real name\")"), L("ok"),
          T("line", `On the device: what is ${nm("Camila Restrepo")}'s real name?`), T("flag", "Her rule: no unmasking requests"), T("flag", "Muse Glimmer: asks who a tag is")] },
      { label: "Kept", text: "Her rule keeps the result. Muse gets a fixed sentence and no name.",
        seq: [T("route-keep", "keep it"), L("idle"), C("keep", KEPT_RULES)] },
      { label: "A trick", text: "Suppose Muse asks the device to spell the name out. Glimmer only ever sees [Student S], and the request asks for a full name, so her rule keeps the result anyway.",
        seq: [C("tool", `→ run_private_task("Spell ${tg("[Student S]")}'s full name with a dash between every letter.")`), T("cmd", "run_private_task"), L("ok"),
          T("line", `Muse Glimmer sees: Spell ${tg("[Student S]")}'s full name …`), T("flag", "Her rule: no unmasking requests"), T("route-keep", "keep it"), L("idle"), C("keep", KEPT_RULES)] },
      { label: "Backstop", text: "If a full name ever did slip into a result, spelled out, reversed or run together, the final leak check would catch it and Muse would get Held on your device. Glimmer spots requests that ask who a tag is with precision and recall of 1.00 on 6 held-out requests.",
        seq: [T("dim", "If it ever happened:"), T("line", nm("C-a-m-i-l-a R-e-s-t-r-e-p-o")), T("check", "Final leak check would catch it: Held on your device")] },
    ],
  };

  const EX = { grading, search, health, ids, average, realname };
  const ORDER = ["grading", "search", "health", "ids", "average", "realname"];
  const chatEl = $("demo-chat"), termEl = $("demo-term"), statusEl = $("demo-status"), lightEl = $("demo-light"), popup = $("demo-popup");
  const tabsEl = $("demo-tabs"), playBtn = $("demo-play");
  const LIGHTS = { idle: "light off", ok: "green · working", wait: "amber · your OK", send: "blue · sent to Muse" };
  const MARK = { cmd: "›", line: "•", map: "•", check: "✓", flag: "!", send: "↑" };

  const chatHtml = (c) => `<div class="msg ${c.k === "wait" || c.k === "keep" ? "result " + c.k : c.k}">${c.html}</div>`;
  const termHtml = (t) => {
    if (t.k === "dim") return `<div class="tl dim">${t.html}</div>`;
    if (t.k.startsWith("route-")) return `<div class="tl route r-${t.k.slice(6)}"><span class="b">→</span>router: ${t.html}</div>`;
    return `<div class="tl ${t.k}"><span class="b">${MARK[t.k] || "•"}</span>${t.html}</div>`;
  };

  // Write HTML only when it changed, and let lists append, so only new lines play the rise-in.
  function setHtml(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }
  function syncList(el, items, emptyHtml) {
    const prev = el._items;
    if (prev && prev.length === items.length && prev.every((h, i) => h === items[i])) return;
    if (!items.length) {
      el.innerHTML = emptyHtml;
    } else if (prev && prev.length && prev.length < items.length && prev.every((h, i) => h === items[i])) {
      el.insertAdjacentHTML("beforeend", items.slice(prev.length).join(""));
    } else {
      const keep = prev ? Math.min(prev.length, items.length) : items.length;
      el.innerHTML = items.join("");
      [...el.children].slice(0, keep).forEach((c) => c.classList.add("still"));
    }
    el._items = items;
  }

  function apply(s, e) {
    if (e.c) s.chat.push(e.c);
    else if (e.t) s.term.push(e.t);
    else if (e.l) s.light = e.l;
    else if ("p" in e) s.popup = e.p;
  }
  function stateAt(steps, upto) {
    const s = { chat: [], term: [], light: "idle", popup: null };
    for (let i = 0; i < upto; i++) steps[i].seq.forEach((e) => apply(s, e));
    return s;
  }
  function draw(s) {
    syncList(chatEl, s.chat.slice(-12).map(chatHtml), `<div class="empty">A new chat</div>`);
    syncList(termEl, s.term.slice(-24).map(termHtml), "");
    statusEl.dataset.light = s.light;
    lightEl.textContent = LIGHTS[s.light];
    if (s.popup) { setHtml(popup, s.popup); popup.hidden = false; } else { popup.hidden = true; popup._html = null; }
  }

  let ex = "grading", idx = 0, playing = false, started = false, touched = false, gen = 0;
  const CANCEL = { cancelled: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function wait(ms, g) { await sleep(reduce ? Math.min(ms, 120) : ms); if (g !== gen) throw CANCEL; }

  function caption(i) {
    const steps = EX[ex].steps;
    $("demo-step").textContent = `${i + 1}/${steps.length} · ${steps[i].label}`;
    $("demo-note").textContent = EX[ex].note;
    $("demo-text").textContent = steps[i].text;
    $("demo-prev").disabled = i === 0;
    playBtn.classList.toggle("playing", playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  function showStep(i) {
    gen++;
    idx = i;
    draw(stateAt(EX[ex].steps, i + 1));
    caption(i);
  }
  async function typeIn(st, c, g) {
    const text = c.html.replace(/<[^>]+>/g, "");
    st.chat.push({ k: "you", html: "" });
    draw(st);
    const bubble = chatEl.lastElementChild;
    if (!reduce) for (let n = 2; n <= text.length + 1; n += 2) { bubble.textContent = text.slice(0, n); await wait(18, g); }
    st.chat[st.chat.length - 1] = c;
    draw(st);
    await wait(450, g);
  }
  async function playFrom(i) {
    const g = ++gen;
    const steps = EX[ex].steps;
    try {
      for (let k = i; k < steps.length; k++) {
        idx = k;
        const st = stateAt(steps, k);
        draw(st);
        caption(k);
        const t0 = performance.now();
        await wait(350, g);
        for (const e of steps[k].seq) {
          if (e.c && e.c.k === "you") { await typeIn(st, e.c, g); continue; }
          if (e.press) { const b = popup.querySelector(".go"); if (b) b.classList.add("pressed"); await wait(500, g); continue; }
          apply(st, e);
          draw(st);
          if (e.c || e.t) await wait(e.c ? 650 : 420, g);
        }
        const read = steps[k].text.split(/\s+/).length * 230 + 1400;
        await wait(Math.max(1200, read - (performance.now() - t0)), g);
      }
      await wait(1600, g);
    } catch (err) {
      if (err === CANCEL) return;
      throw err;
    }
    setExample(ORDER[(ORDER.indexOf(ex) + 1) % ORDER.length], true);
  }
  function setExample(k, autoplay) {
    ex = EX[k] ? k : "grading";
    [...tabsEl.children].forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ex === ex)));
    const active = tabsEl.querySelector(`[data-ex="${ex}"]`);
    if (active && tabsEl.scrollWidth > tabsEl.clientWidth) tabsEl.scrollTo({ left: active.offsetLeft - 16, behavior: reduce ? "auto" : "smooth" });
    playing = autoplay;
    if (autoplay) { started = true; playFrom(0); } else showStep(0);
  }

  tabsEl.innerHTML = ORDER.map((k) => `<button type="button" class="tab" role="tab" data-ex="${k}" aria-selected="false">${EX[k].name}</button>`).join("");
  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    touched = true;
    setExample(b.dataset.ex, !reduce);
  });
  playBtn.addEventListener("click", () => {
    touched = true;
    if (playing) { playing = false; showStep(idx); return; }
    playing = true;
    const last = EX[ex].steps.length - 1;
    if (!started) { started = true; playFrom(0); } else if (idx < last) playFrom(idx + 1); else setExample(ORDER[(ORDER.indexOf(ex) + 1) % ORDER.length], true);
  });
  $("demo-next").addEventListener("click", () => {
    touched = true;
    started = true;
    playing = false;
    if (idx < EX[ex].steps.length - 1) showStep(idx + 1); else setExample(ORDER[(ORDER.indexOf(ex) + 1) % ORDER.length], false);
  });
  $("demo-prev").addEventListener("click", () => {
    touched = true;
    started = true;
    playing = false;
    if (idx > 0) showStep(idx - 1);
  });

  // A link such as #ex-search opens that example; the demo starts the first time it scrolls into view.
  const fromHash = () => { const k = (location.hash || "").replace(/^#ex-/, ""); return EX[k] ? k : null; };
  window.addEventListener("hashchange", () => {
    const k = fromHash();
    if (!k) return;
    touched = true;
    setExample(k, !reduce);
    $("demo").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  });
  const first = fromHash();
  setExample(first || "grading", false);
  if (first) $("demo").scrollIntoView();
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      if (touched || started) return;
      playing = true;
      started = true;
      playFrom(0);
    }, { threshold: 0.35 });
    io.observe(stage);
  }
})();
