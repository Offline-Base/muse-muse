// Glimmer Compare: one prompt to every selected model, streamed into columns. Vanilla JS, no dependencies.
// Model text is only ever placed with textContent, never as HTML.
"use strict";

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const PALETTE = 9;
  const ET_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const S = {
    config: null,
    byName: {},
    selected: [],
    session: null,
    modes: {},
    turns: [],
    busy: false,
    ctrl: null,
    health: {},
    colHealth: {},
    lab: null,
    tab: "chat",
    sessionsCache: [],
    reportsCache: [],
  };

  // small helpers

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "style") for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem("glimmer-compare:" + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem("glimmer-compare:" + key, JSON.stringify(value));
      } catch (_) { /* private window or blocked storage: settings just aren't remembered */ }
    },
  };

  const fmtInt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");
  const fmtSec = (ms) => (typeof ms === "number" ? (ms < 10000 ? (ms / 1000).toFixed(2) : (ms / 1000).toFixed(1)) + " s" : "?");
  const fmtUsd = (x) => (typeof x === "number" ? "$" + x.toFixed(2) : "?");
  function fmtEt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : ET_FMT.format(d) + " ET";
  }
  function fmtMinutes(min) {
    if (typeof min !== "number") return "?";
    if (min < 60) return min + " min";
    return Math.floor(min / 60) + " h " + (min % 60) + " min";
  }

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || "HTTP " + res.status;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // columns and models

  function columns() {
    if (S.session) return S.session.columns;
    const blind = $("#blind").checked;
    return S.selected.map((name, i) => ({ col: "ABCDEFGHI"[i], model: blind ? null : name, label: blind ? null : (S.byName[name] || {}).label, reasoning: blind ? ["off", "on"] : ((S.byName[name] || {}).reasoning || ["off"]), preview: true }));
  }

  function colIndex(col) {
    return Math.max(0, "ABCDEFGHI".indexOf(col));
  }

  function colColor(col) {
    return "var(--c" + (colIndex(col) % PALETTE) + ")";
  }

  function hidden() {
    return S.session ? S.session.blind && !S.session.revealed : $("#blind").checked;
  }

  function healthOf(c) {
    if (S.session && S.session.blind && !S.session.revealed) return S.colHealth[c.col] || "down";
    if (c.model) return S.colHealth[c.col] || S.health[c.model] || "down";
    return S.colHealth[c.col] || "unknown";
  }

  // lab.py writes "not loaded (memory)" (the ladder), "not loaded" (unload) and "not loaded (replaced)" (add).
  function notLoaded(m) {
    return !!m && typeof m.server_state === "string" && m.server_state.startsWith("not loaded");
  }

  function healthTitle(state, m) {
    if (notLoaded(m)) return m.server_state + ": lab.py load " + m.name + " swaps it in";
    return { ok: "ready", loading: "loading the model", down: "not reachable (lab down, tunnel closed or server stopped)", unknown: "health shows once the chat starts" }[state] || state;
  }

  function modelMeta(m) {
    if (!m) return "";
    const bits = [];
    if (m.quant) bits.push(m.quant);
    if (typeof m.bpw === "number") bits.push(m.bpw.toFixed(2) + " bpw");
    if (m.license) bits.push(m.license);
    if (m.reasoning_level) bits.push("thinking " + m.reasoning_level);
    return bits.join(" · ");
  }

  // setup panel

  function readSampling() {
    const num = (id) => {
      const v = $("#" + id).value.trim();
      return v === "" ? null : Number(v);
    };
    return {
      greedy: $("#greedy").checked,
      temperature: num("temperature"),
      top_p: num("top_p"),
      top_k: num("top_k"),
      seed: num("seed"),
      max_tokens: num("max_tokens"),
      max_tokens_on: num("max_tokens_on"),
    };
  }

  function samplingFor(mode) {
    const s = readSampling();
    const out = { greedy: s.greedy, temperature: s.temperature, top_p: s.top_p, top_k: s.top_k, max_tokens: mode === "on" ? s.max_tokens_on : s.max_tokens };
    if (Number.isInteger(s.seed) && s.seed >= 0) out.seed = s.seed;
    return out;
  }

  function saveSetup() {
    store.set("sampling", readSampling());
    store.set("selected", S.selected);
    store.set("blind", $("#blind").checked);
  }

  function applyDefaults(defaults) {
    const saved = store.get("sampling", null) || {};
    const pick = (k) => (saved[k] === null || saved[k] === undefined ? defaults[k] : saved[k]);
    $("#temperature").value = pick("temperature");
    $("#top_p").value = pick("top_p");
    $("#top_k").value = pick("top_k");
    $("#seed").value = saved.seed === null || saved.seed === undefined ? "" : saved.seed;
    $("#max_tokens").value = Math.min(pick("max_tokens"), 32768);
    $("#max_tokens_on").value = Math.min(pick("max_tokens_on"), defaults.max_tokens_on);
    $("#greedy").checked = !!saved.greedy;
    $("#blind").checked = !!store.get("blind", false);
    $("#system").placeholder = defaults.system;
    syncGreedy();
  }

  function syncGreedy() {
    const g = $("#greedy").checked;
    for (const id of ["temperature", "top_p", "top_k"]) $("#" + id).disabled = g;
  }

  function renderPicker() {
    const box = $("#modelPicker");
    box.replaceChildren();
    const locked = !!S.session;
    const models = (S.config && S.config.models) || [];
    if (!models.length) {
      box.append(el("p", { class: "muted", text: "No enabled models in models.json." }));
      return;
    }
    for (const m of models) {
      const on = S.selected.includes(m.name);
      const state = S.health[m.name] || m.health || "down";
      const mem = notLoaded(m);
      const input = el("input", { type: "checkbox", checked: on, disabled: locked, "aria-label": m.label });
      input.addEventListener("change", () => {
        if (input.checked && !S.selected.includes(m.name)) S.selected.push(m.name);
        if (!input.checked) S.selected = S.selected.filter((n) => n !== m.name);
        S.selected.sort((a, b) => models.findIndex((x) => x.name === a) - models.findIndex((x) => x.name === b));
        saveSetup();
        renderAll();
      });
      const notes = [];
      if (mem) notes.push(m.server_state);
      if (m.replaced_by) notes.push("replaced by " + m.replaced_by + ", not loaded at up");
      box.append(el("label", { class: "pick" + (on ? " on" : "") + (locked ? " locked" : ""), title: m.file ? m.file : "" },
        input,
        el("span", { class: "pick-body" },
          el("span", { class: "pick-name" }, el("span", { class: "dot " + (mem ? "mem" : state), title: healthTitle(state, m) }), m.label,
            m.role ? el("span", { class: "role " + m.role, text: m.role }) : null),
          el("span", { class: "pick-meta", text: modelMeta(m) }),
          notes.length ? el("span", { class: "pick-meta", text: notes.join(" · ") }) : null)));
    }
  }

  function renderSetupState() {
    const locked = !!S.session;
    for (const id of ["blind", "saveReasoning", "system"]) $("#" + id).disabled = locked;
    $("#pickReady").disabled = locked;
    $("#pickNone").disabled = locked;
    $("#lockNote").hidden = !locked;
    const s = readSampling();
    const n = columns().length;
    const parts = [n + (n === 1 ? " model" : " models")];
    if (hidden()) parts.push("blind");
    if ((S.session ? S.session.save_reasoning : $("#saveReasoning").checked)) parts.push("saving reasoning");
    parts.push(s.greedy ? "greedy" : "temperature " + s.temperature + ", top-p " + s.top_p + ", top-k " + s.top_k);
    parts.push("max " + s.max_tokens + " / " + s.max_tokens_on + " tokens (thinking off / on)");
    if (S.session && S.session.system !== (S.config && S.config.defaults.system)) parts.push("custom system prompt");
    $("#setupSummary").textContent = parts.join(" · ");
  }

  function setSetupOpen(open) {
    $("#setupToggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("#setupBody").hidden = !open;
  }

  // the board

  function renderAll() {
    renderPicker();
    renderSetupState();
    renderToolbar();
    renderBoard();
  }

  function renderToolbar() {
    const sess = S.session;
    $("#chatTitle").textContent = sess ? (sess.blind ? (sess.revealed ? "Blind chat, names revealed" : "Blind chat") : "Chat") : "New chat";
    $("#sessionId").textContent = sess ? sess.session : "";
    $("#revealBtn").hidden = !(sess && sess.blind && !sess.revealed);
    $("#blindNote").hidden = !hidden();
    const cols = columns();
    const modes = cols.filter((c) => (c.reasoning || []).includes("on")).map((c) => S.modes[c.col] || "off");
    for (const b of $$("[data-all-mode]")) {
      b.classList.toggle("on", modes.length > 0 && modes.every((m) => m === b.dataset.allMode));
      b.disabled = S.busy || !modes.length;
    }
    renderTally();
    updateBusy();
  }

  function renderTally() {
    const sess = S.session;
    const box = $("#tally");
    const votes = S.turns.filter((t) => t.vote);
    if (!sess || !votes.length || hidden()) {
      box.hidden = true;
      return;
    }
    const counts = {};
    for (const t of votes) counts[t.vote] = (counts[t.vote] || 0) + 1;
    const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([col, k]) => {
      const c = sess.columns.find((x) => x.col === col) || {};
      return (c.label || c.model || "Model " + col) + " [" + col + "]: " + k;
    });
    box.textContent = "Your picks over " + votes.length + (votes.length === 1 ? " turn" : " turns") + ": " + parts.join(", ");
    box.hidden = false;
  }

  function renderBoard() {
    const board = $("#board");
    const cols = columns();
    board.replaceChildren();
    board.style.setProperty("--n", Math.max(cols.length, 1));
    $("#empty").hidden = S.turns.length > 0;
    if (!cols.length) return;
    cols.forEach((c, i) => board.append(colHead(c, i)));
    for (const t of S.turns) {
      board.append(userRow(t));
      cols.forEach((c, i) => board.append(cell(t, c, i)));
    }
  }

  function colHead(c, i) {
    const m = c.model ? S.byName[c.model] : null;
    const isHidden = hidden();
    const state = healthOf(c);
    const mem = notLoaded(m);
    const hasOn = (c.reasoning || []).includes("on");
    const mode = S.modes[c.col] || "off";
    const latest = S.turns[S.turns.length - 1];
    const r = latest && latest.replies[c.col];
    const live = r && (r.status === "waiting" || r.status === "streaming");
    const seg = el("div", { class: "seg", role: "group", "aria-label": "Thinking for column " + c.col },
      el("span", { class: "seg-label", text: "Thinking" }),
      el("button", { type: "button", class: mode === "off" ? "on" : "", disabled: S.busy, onclick: () => setMode(c.col, "off"), text: "Off" }),
      el("button", { type: "button", class: mode === "on" ? "on" : "", disabled: S.busy || !hasOn, title: hasOn ? "" : "this model has no reasoning mode", onclick: () => setMode(c.col, "on"), text: "On" }));
    const name = isHidden ? "Model " + c.col : (c.label || (m && m.label) || c.model || "Model " + c.col);
    return el("div", { class: "col-head", style: { "--col": colColor(c.col) }, dataset: { col: c.col } },
      el("div", { class: "col-title" },
        el("span", { class: "col-letter", text: c.col }),
        el("span", { class: "col-name", title: name, text: name }),
        !isHidden && m && m.role ? el("span", { class: "role " + m.role, text: m.role }) : null,
        el("span", { class: "dot " + (mem ? "mem" : state), title: healthTitle(state, m) })),
      el("div", { class: "col-meta", text: isHidden ? "Name hidden until you reveal" : (m ? modelMeta(m) : ""), title: isHidden ? "" : (m ? (m.file || "") + (m.cutoff ? " · cutoff " + m.cutoff : "") : "") }),
      el("div", { class: "col-controls" }, seg,
        el("button", { type: "button", class: "small danger stop", disabled: !live, onclick: () => stopCol(c.col), text: "Stop" })));
  }

  function userRow(t) {
    return el("div", { class: "user-row" }, el("div", { class: "user-bubble" }, el("span", { class: "turn-no", text: "#" + t.n }), el("span", { class: "user-text", text: t.user })));
  }

  function cell(t, c, i) {
    const r = t.replies[c.col];
    const box = el("div", { class: "cell" + (i === 0 ? " first" : "") + (t.vote === c.col ? " voted" : ""), style: { "--col": colColor(c.col) }, dataset: { col: c.col, turn: t.n } });
    if (!r) {
      box.append(el("div", { class: "answer empty-final", text: "No reply in this turn." }));
      return box;
    }
    r.el = { box };
    fillCell(t, c, r);
    return box;
  }

  function fillCell(t, c, r) {
    const box = r.el.box;
    box.replaceChildren();
    box.classList.toggle("voted", t.vote === c.col);
    const live = r.status === "waiting" || r.status === "streaming";
    if (r.mode === "on" || r.reasoningChars > 0 || r.reasoningText) {
      const pre = el("pre");
      pre.textContent = r.reasoningText || (r.reasoningChars > 0 && !r.reasoningText ? "(reasoning text was not kept)" : "");
      const count = el("span", { class: "count" });
      const det = el("details", { class: "thinking" + (live && !r.shown ? " live" : "") },
        el("summary", null, el("span", { class: "pulse" }), el("span", { text: "Thinking" }), count), pre);
      if (r.thinkOpen) det.open = true;
      det.addEventListener("toggle", () => { r.thinkOpen = det.open; });
      box.append(det);
      r.el.think = det;
      r.el.thinkPre = pre;
      r.el.thinkCount = count;
      updateThinkCount(r);
    }
    if (r.status === "waiting" && !r.shown && !r.reasoningChars) {
      box.append(el("div", { class: "waiting" }, el("span", { class: "pulse" }), el("span", { text: "Waiting for the first token" })));
    }
    const text = r.status === "done" || r.status === "error" ? (r.final || "") : (r.shown || "");
    const ans = el("div", { class: "answer" + (live ? " streaming" : "") });
    ans.textContent = text;
    if (!live && !text && r.status === "done") {
      ans.classList.add("empty-final");
      ans.textContent = r.finish === "length" ? "No final answer: the token limit was reached first." : r.finish === "stopped" ? "Stopped before any answer." : "Empty reply.";
    }
    if (r.status !== "error" || text) box.append(ans);
    r.el.answer = ans;
    if (r.status === "error" && r.error) {
      const retry = el("button", { type: "button", class: "small", text: "Retry", disabled: S.busy || t !== S.turns[S.turns.length - 1] || !!r.readonly, onclick: () => retryCol(t.n, c.col) });
      box.append(el("div", { class: "error-box" }, el("span", { class: "msg", text: (r.error.status ? "HTTP " + r.error.status + ": " : "") + (r.error.message || "error") }), r.readonly ? null : retry));
      if (r.error.status === 500 && r.mode === "on") box.append(el("p", { class: "error-hint", text: "The server could not parse this reply with thinking on. Switch this column's thinking off and retry." }));
    }
    const stats = el("div", { class: "stats" });
    box.append(stats);
    r.el.stats = stats;
    updateStats(r);
    if (r.status === "done" && !r.readonly) {
      const voted = t.vote === c.col;
      box.append(el("div", { class: "cell-actions" },
        el("button", { type: "button", class: "small prefer" + (voted ? " on" : ""), onclick: () => vote(t.n, voted ? null : c.col), text: voted ? "Preferred" : "Prefer" }),
        el("button", { type: "button", class: "small ghost", onclick: (e) => copyText(r.final || "", e.currentTarget), text: "Copy" })));
    } else if (r.readonly && t.vote === c.col) {
      box.append(el("div", { class: "cell-actions" }, el("span", { class: "vote-mark", text: "Preferred" })));
    }
  }

  function updateThinkCount(r) {
    if (!r.el || !r.el.thinkCount) return;
    r.el.thinkCount.textContent = " · " + fmtInt(r.reasoningChars || 0) + " chars";
  }

  function updateStats(r) {
    const box = r.el && r.el.stats;
    if (!box) return;
    box.replaceChildren();
    const mode = r.mode || "off";
    box.append(el("span", { class: "badge" + (mode === "on" ? " on" : ""), text: "thinking " + mode }));
    const s = r.sampling;
    if (s) box.title = s.greedy ? "greedy, seed " + s.seed + ", max " + s.max_tokens : "temperature " + s.temperature + ", top-p " + s.top_p + ", top-k " + s.top_k + ", seed " + s.seed + ", max " + s.max_tokens;
    if (r.status === "waiting" || r.status === "streaming") {
      const since = performance.now() - (r.startedAt || performance.now());
      box.append(el("span", null, r.status === "waiting" ? "waiting " : "", el("b", { text: fmtSec(since) })));
      if (r.tokens) box.append(el("span", null, el("b", { text: fmtInt(r.tokens) }), " tok so far"));
      return;
    }
    const u = r.usage || {};
    const tm = r.timings || {};
    if (typeof u.prompt === "number") box.append(el("span", null, "in ", el("b", { text: fmtInt(u.prompt) })));
    if (typeof u.completion === "number") box.append(el("span", null, "out ", el("b", { text: fmtInt(u.completion) })));
    if (typeof tm.ttft_ms === "number") box.append(el("span", null, "TTFT ", el("b", { text: fmtSec(tm.ttft_ms) })));
    if (typeof tm.total_ms === "number") box.append(el("span", null, "total ", el("b", { text: fmtSec(tm.total_ms) })));
    if (typeof tm.tok_s === "number") box.append(el("span", { class: "toks", title: "shared GPU, not a model property" }, el("b", { text: tm.tok_s.toFixed(1) }), " tok/s"));
    if (r.status === "error") box.append(el("span", { class: "badge err", text: "error" }));
    else if (r.finish) box.append(el("span", { class: "badge " + r.finish, text: r.finish }));
  }

  function setMode(col, mode) {
    S.modes[col] = mode;
    renderToolbar();
    replaceHeads();
  }

  function replaceHeads() {
    const cols = columns();
    for (const head of $$("#board .col-head")) {
      const i = cols.findIndex((c) => c.col === head.dataset.col);
      if (i >= 0) head.replaceWith(colHead(cols[i], i));
    }
  }

  // streaming

  let dirty = new Set();
  let frame = 0;

  function markDirty(r) {
    dirty.add(r);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function nearBottom(wrap) {
    return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
  }

  function flush() {
    frame = 0;
    const wrap = $("#boardWrap");
    const stick = nearBottom(wrap);
    for (const r of dirty) {
      if (!r.el) continue;
      if (r.el.answer) r.el.answer.textContent = r.shown || "";
      if (r.el.thinkPre) r.el.thinkPre.textContent = r.reasoningText || "";
      updateThinkCount(r);
      if (r.el.think) r.el.think.classList.toggle("live", !r.shown);
    }
    dirty = new Set();
    if (stick) wrap.scrollTop = wrap.scrollHeight;
  }

  function turnBy(n) {
    return S.turns.find((t) => t.n === n);
  }

  function rerenderCell(t, col) {
    const r = t.replies[col];
    if (!r || !r.el || !r.el.box.isConnected) return;
    const c = columns().find((x) => x.col === col);
    if (c) fillCell(t, c, r);
  }

  function handleEvent(n, ev) {
    const t = turnBy(n);
    if (!t || !ev) return;
    const col = ev.c;
    const r = t.replies[col];
    if (!r) return;
    switch (ev.t) {
      case "start":
        r.mode = ev.mode || r.mode;
        r.sampling = ev.sampling || null;
        rerenderCell(t, col);
        break;
      case "reasoning":
        if (r.status === "waiting") { r.status = "streaming"; rerenderCell(t, col); }
        r.reasoningText += ev.d;
        r.reasoningChars += ev.d.length;
        r.tokens += 1;
        markDirty(r);
        break;
      case "content":
        if (r.status === "waiting") { r.status = "streaming"; rerenderCell(t, col); }
        r.shown = ev.replace ? ev.d : r.shown + ev.d;
        r.tokens += 1;
        markDirty(r);
        break;
      case "tick":
        if (r.status === "waiting") { r.status = "streaming"; rerenderCell(t, col); }
        r.tokens += 1;
        break;
      case "done":
        r.status = "done";
        r.final = ev.final || "";
        r.finish = ev.finish;
        r.usage = ev.usage;
        r.timings = ev.timings;
        r.reasoningChars = ev.reasoning_chars || r.reasoningChars;
        dirty.delete(r);
        rerenderCell(t, col);
        replaceHeads();
        break;
      case "error":
        r.status = "error";
        r.error = { status: ev.status, message: ev.message };
        r.final = ev.final || "";
        r.finish = "error";
        dirty.delete(r);
        rerenderCell(t, col);
        replaceHeads();
        break;
      default:
        break;
    }
  }

  function newReply(mode) {
    return { mode, status: "waiting", shown: "", final: "", reasoningText: "", reasoningChars: 0, tokens: 0, finish: null, usage: null, timings: null, error: null, sampling: null, startedAt: performance.now(), el: null };
  }

  function historyFor(col, beforeN) {
    const msgs = [];
    for (const t of S.turns) {
      if (t.n >= beforeN) break;
      const r = t.replies[col];
      if (r && r.status === "done" && r.final) {
        msgs.push({ role: "user", content: t.user });
        msgs.push({ role: "assistant", content: r.final });
      }
    }
    return msgs;
  }

  async function ensureSession() {
    if (S.session) return true;
    if (!S.selected.length) {
      toastProblem("Pick at least one model.");
      return false;
    }
    const sess = await api("/api/session", {
      models: S.selected,
      blind: $("#blind").checked,
      save_reasoning: $("#saveReasoning").checked,
      system: $("#system").value,
    });
    S.session = sess;
    for (const c of sess.columns) {
      if (!(c.reasoning || []).includes("on")) S.modes[c.col] = "off";
      else if (!S.modes[c.col]) S.modes[c.col] = "off";
    }
    setSetupOpen(false);
    refreshHealth();
    return true;
  }

  function toastProblem(text) {
    const wrap = $("#boardWrap");
    const note = el("div", { class: "error-box", style: { margin: "12px 16px" } }, el("span", { class: "msg", text }));
    wrap.prepend(note);
    setTimeout(() => note.remove(), 6000);
  }

  async function send() {
    const text = $("#prompt").value;
    if (!text.trim() || S.busy) return;
    try {
      if (!(await ensureSession())) return;
    } catch (e) {
      toastProblem("Could not start the chat: " + e.message);
      return;
    }
    const n = (S.turns.length ? S.turns[S.turns.length - 1].n : 0) + 1;
    const t = { n, user: text, replies: {}, vote: null };
    const jobs = [];
    for (const c of S.session.columns) {
      const mode = S.modes[c.col] || "off";
      t.replies[c.col] = newReply(mode);
      jobs.push({ col: c.col, reasoning: mode, sampling: samplingFor(mode), messages: [...historyFor(c.col, n), { role: "user", content: text }] });
    }
    S.turns.push(t);
    $("#prompt").value = "";
    renderAll();
    $("#boardWrap").scrollTop = $("#boardWrap").scrollHeight;
    await streamTurn(t, jobs);
  }

  async function retryCol(n, col) {
    const t = turnBy(n);
    if (!t || S.busy) return;
    const mode = S.modes[col] || "off";
    t.replies[col] = newReply(mode);
    const job = { col, reasoning: mode, sampling: samplingFor(mode), messages: [...historyFor(col, n), { role: "user", content: t.user }] };
    renderBoard();
    await streamTurn(t, [job]);
  }

  async function streamTurn(t, jobs) {
    S.busy = true;
    renderToolbar();
    replaceHeads();
    const ctrl = new AbortController();
    S.ctrl = ctrl;
    try {
      const res = await fetch("/api/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: S.session.session, turn: t.n, columns: jobs }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { msg = (await res.json()).error.message || msg; } catch (_) { /* keep the status */ }
        for (const j of jobs) handleEvent(t.n, { t: "error", c: j.col, status: res.status, message: msg });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let ev = null;
            try { ev = JSON.parse(line.slice(6)); } catch (_) { ev = null; }
            if (ev) handleEvent(t.n, ev);
          }
        }
      }
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      for (const j of jobs) {
        const r = t.replies[j.col];
        if (r && (r.status === "waiting" || r.status === "streaming")) {
          handleEvent(t.n, aborted ? { t: "done", c: j.col, final: r.shown, finish: "stopped", usage: { completion: r.tokens }, timings: {}, reasoning_chars: r.reasoningChars }
            : { t: "error", c: j.col, status: 0, message: "lost the connection to the chat server" });
        }
      }
    } finally {
      for (const j of jobs) {
        const r = t.replies[j.col];
        if (r && (r.status === "waiting" || r.status === "streaming")) handleEvent(t.n, { t: "error", c: j.col, status: 0, message: "the stream ended without a result" });
      }
      S.busy = false;
      S.ctrl = null;
      renderToolbar();
      replaceHeads();
      for (const j of jobs) rerenderCell(t, j.col);
      $("#prompt").focus();
    }
  }

  async function stopCol(col) {
    if (!S.session) return;
    try { await api("/api/stop", { session: S.session.session, col }); } catch (_) { /* the stream ends either way */ }
  }

  async function stopAll() {
    if (!S.session || !S.busy) return;
    const ctrl = S.ctrl;
    try { await api("/api/stop", { session: S.session.session }); } catch (_) { /* fall back to closing the stream */ }
    setTimeout(() => { if (S.ctrl === ctrl && ctrl) ctrl.abort(); }, 4000);
  }

  async function vote(n, col) {
    const t = turnBy(n);
    if (!t || !S.session) return;
    try {
      await api("/api/vote", { session: S.session.session, turn: n, col });
      t.vote = col;
      for (const c of S.session.columns) rerenderCell(t, c.col);
      renderTally();
    } catch (e) {
      toastProblem("Vote not saved: " + e.message);
    }
  }

  async function reveal() {
    if (!S.session) return;
    try {
      const res = await api("/api/reveal", { session: S.session.session });
      S.session.revealed = true;
      S.session.columns = res.columns;
      renderAll();
    } catch (e) {
      toastProblem("Reveal failed: " + e.message);
    }
  }

  function newChat() {
    if (S.busy) stopAll();
    S.session = null;
    S.turns = [];
    S.colHealth = {};
    S.modes = {};
    setSetupOpen(true);
    renderAll();
    $("#prompt").focus();
  }

  function updateBusy() {
    $("#sendBtn").disabled = S.busy;
    $("#stopAllBtn").hidden = !S.busy;
    $("#newChatBtn").disabled = false;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (_) {
      btn.textContent = "Copy failed";
    }
  }

  // health and lab

  async function refreshHealth() {
    try {
      if (S.session) {
        const h = await api("/api/health?session=" + encodeURIComponent(S.session.session));
        S.colHealth = h.cols || {};
      } else {
        const h = await api("/api/health");
        S.health = h.models || {};
      }
    } catch (_) { return; }
    if (!S.session) renderPicker();
    replaceHeads();
  }

  function labItem(text, value, cls, title) {
    return el("span", { class: "lab-item" + (cls ? " " + cls : ""), title: title || null }, text ? text + " " : "", value !== undefined && value !== null ? el("b", { text: String(value) }) : null);
  }

  function renderLab() {
    const lab = S.lab || {};
    const box = $("#labBanner");
    box.replaceChildren();
    box.className = "lab-banner";
    if (!lab.up) {
      box.classList.add("down");
      box.append(el("span", { class: "dot" }), labItem("", "Lab is off."), el("span", { class: "lab-item text", text: "Start it with lab.py up (see docs/COMPARE.md). Until then every column shows as down." }));
      if (lab.watch_running) box.append(labItem("Watch", "running", "good"));
      return;
    }
    const watchOk = !!lab.watch_running;
    if (!watchOk) box.classList.add("alarm");
    box.append(el("span", { class: "dot " + (lab.ready ? "ok" : "loading") }));
    box.append(labItem(lab.ready ? "Lab up" : "Lab starting", typeof lab.uptime_minutes === "number" ? fmtMinutes(Math.round(lab.uptime_minutes)) : (lab.status || "")));
    if (lab.type) box.append(labItem("", lab.type + (typeof lab.usd_per_hour === "number" ? " at " + fmtUsd(lab.usd_per_hour) + "/h" : "")));
    if (typeof lab.spent_usd === "number" && typeof lab.cap_usd === "number") {
      const frac = Math.min(1, lab.spent_usd / Math.max(lab.cap_usd, 0.01));
      const meter = el("span", { class: "meter" + (frac > 0.9 ? " full" : frac > 0.66 ? " hot" : "") }, el("span", { style: { width: Math.round(frac * 100) + "%" } }));
      box.append(el("span", { class: "lab-item", title: "spend across all lab machines against the cap" }, "Spent ", el("b", { text: fmtUsd(lab.spent_usd) }), " of " + fmtUsd(lab.cap_usd), meter));
    }
    const limit = typeof lab.idle_limit_minutes === "number" ? lab.idle_limit_minutes : null;
    if (typeof lab.idle_minutes === "number") box.append(labItem("Idle", Math.round(lab.idle_minutes) + " min" + (limit !== null ? " of " + limit : ""), "", "the watch ends the machine after the idle limit"));
    const ends = lab.deadline_et || lab.ends_by_et;
    if (ends) box.append(labItem("Ends by", ends, "", "the earliest of the machine's deadline and the cap; the watch ends it then"));
    if (lab.keep_until_et) box.append(labItem("Kept until", lab.keep_until_et));
    if (Array.isArray(lab.ladder) && lab.ladder.length) {
      const last = lab.ladder[lab.ladder.length - 1] || {};
      const free = typeof last.free_mib === "number" ? ", " + fmtInt(last.free_mib) + " MiB free" : "";
      box.append(labItem("Memory", (last.step || "?") + free, lab.ladder.length > 1 ? "" : "good", "the memory ladder's last step (lab.py status lists every step)"));
    }
    box.append(watchOk ? labItem("Watch", "running", "good") : labItem("", "WATCH NOT RUNNING: nothing will stop the bill. Run lab.py watch or lab.py down.", "bad text"));
    box.append(lab.tunnel_running === false ? labItem("Tunnel", "down, run lab.py tunnel", "bad") : labItem("Tunnel", "open", "good"));
    if (lab.kv || lab.ctx_per_slot) box.append(labItem("KV", (lab.kv || "?") + ", ctx " + (lab.ctx_per_slot || "?")));
    box.append(el("span", { class: "spacer" }));
    box.append(el("button", { type: "button", class: "small", title: "Restart the idle timer (the lab ends after the idle limit with no use)", onclick: keepAlive, text: "Keep alive" }));
  }

  async function refreshLab() {
    try {
      S.lab = await api("/api/lab");
    } catch (_) {
      S.lab = { up: false };
    }
    renderLab();
  }

  async function keepAlive(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api("/api/keepalive", {});
      S.lab = res.lab || S.lab;
      renderLab();
    } catch (_) {
      btn.disabled = false;
    }
  }

  // saved chats

  async function loadSessions() {
    const list = $("#sessionList");
    try {
      const res = await api("/api/sessions");
      S.sessionsCache = res.sessions || [];
    } catch (e) {
      list.replaceChildren(el("div", { class: "list-empty", text: "Could not load: " + e.message }));
      return;
    }
    list.replaceChildren();
    if (!S.sessionsCache.length) {
      list.append(el("div", { class: "list-empty", text: "No saved chats yet." }));
      return;
    }
    for (const s of S.sessionsCache) {
      const names = s.blind && !s.revealed ? s.labels.length + " models, names hidden" : s.labels.join(", ");
      list.append(el("button", { type: "button", class: "item", dataset: { id: s.session }, onclick: () => openSession(s.session) },
        el("div", { class: "item-top" }, el("span", { text: fmtEt(s.created) }), el("span", { class: "muted small", text: s.turns + (s.turns === 1 ? " turn" : " turns") + (s.blind ? " · blind" : "") })),
        el("div", { class: "item-sub", text: names, title: names }),
        s.first ? el("div", { class: "item-first", text: s.first }) : null));
    }
  }

  async function openSession(id) {
    for (const b of $$("#sessionList .item")) b.classList.toggle("on", b.dataset.id === id);
    let doc;
    try {
      doc = await api("/api/sessions/" + encodeURIComponent(id));
    } catch (e) {
      $("#sessionHead").textContent = "Could not load: " + e.message;
      return;
    }
    const head = $("#sessionHead");
    head.classList.remove("muted");
    head.replaceChildren(
      el("b", { text: fmtEt(doc.created) }),
      el("span", { class: "mono small muted", text: doc.session }),
      el("span", { class: "small", text: doc.blind ? (doc.revealed ? "blind, revealed" : "blind, names hidden") : "named" }),
      el("span", { class: "small muted", text: doc.save_reasoning ? "reasoning saved" : "final answers only" }),
      el("span", { class: "small muted", title: doc.system, text: "system: " + (doc.system || "").slice(0, 60) + ((doc.system || "").length > 60 ? "..." : "") }));
    const board = $("#sessionBoard");
    board.replaceChildren();
    const cols = (doc.columns || []).map((c) => ({ col: c.col, model: c.model, label: c.label, reasoning: [] }));
    board.style.setProperty("--n", Math.max(cols.length, 1));
    const hid = doc.blind && !doc.revealed;
    cols.forEach((c) => {
      const m = c.model ? S.byName[c.model] : null;
      const name = hid ? "Model " + c.col : (c.label || c.model || "Model " + c.col);
      board.append(el("div", { class: "col-head", style: { "--col": colColor(c.col) } },
        el("div", { class: "col-title" }, el("span", { class: "col-letter", text: c.col }), el("span", { class: "col-name", text: name, title: name })),
        el("div", { class: "col-meta", text: hid ? "Name hidden" : (m ? modelMeta(m) : (c.model || "")) })));
    });
    for (const turn of doc.turns || []) {
      const t = { n: turn.n, user: turn.user, vote: turn.vote, replies: {} };
      board.append(userRow(t));
      cols.forEach((c, i) => {
        const saved = (turn.replies || {})[c.col];
        if (saved) {
          t.replies[c.col] = {
            readonly: true, mode: saved.mode, status: saved.error ? "error" : "done", final: saved.final || "", shown: saved.final || "",
            finish: saved.finish, usage: saved.usage, timings: saved.timings, error: saved.error, sampling: saved.sampling,
            reasoningChars: saved.reasoning_chars || 0, reasoningText: typeof saved.reasoning === "string" ? saved.reasoning : "", tokens: 0,
          };
        }
        board.append(cell(t, c, i));
      });
    }
    if (!(doc.turns || []).length) board.append(el("div", { class: "list-empty", style: { "grid-column": "1 / -1" }, text: "This chat has no turns." }));
  }

  // reports

  async function loadReports() {
    const list = $("#reportList");
    try {
      const res = await api("/api/reports");
      S.reportsCache = res.reports || [];
    } catch (e) {
      list.replaceChildren(el("div", { class: "list-empty", text: "Could not load: " + e.message }));
      return;
    }
    list.replaceChildren();
    if (!S.reportsCache.length) {
      list.append(el("div", { class: "list-empty", text: "No eval runs yet. Run evals.py run, then evals.py report RUN_DIR." }));
      return;
    }
    for (const r of S.reportsCache) {
      const sub = [r.models.length ? r.models.length + " models" : "", r.sets.length ? r.sets.join(", ") : ""].filter(Boolean).join(" · ");
      list.append(el("button", { type: "button", class: "item", dataset: { id: r.run_id }, onclick: () => openReport(r) },
        el("div", { class: "item-top" }, el("span", { class: "mono", text: r.run_id }), el("span", { class: "muted small", text: r.has_html ? "" : "no report yet" })),
        el("div", { class: "item-sub", text: fmtEt(r.start || r.modified) + (r.lab_type ? " · " + r.lab_type : "") }),
        sub ? el("div", { class: "item-first", text: sub }) : null));
    }
  }

  function openReport(r) {
    for (const b of $$("#reportList .item")) b.classList.toggle("on", b.dataset.id === r.run_id);
    const head = $("#reportHead");
    head.classList.remove("muted");
    const base = "/reports/" + encodeURIComponent(r.run_id) + "/";
    head.replaceChildren(el("b", { class: "mono", text: r.run_id }),
      r.models.length ? el("span", { class: "small muted", text: r.models.join(", ") }) : null,
      r.has_html ? el("a", { href: base + "report.html", target: "_blank", rel: "noopener noreferrer", text: "Open in a new tab" }) : null,
      r.has_md ? el("a", { href: base + "report.md", target: "_blank", rel: "noopener noreferrer", text: "report.md" }) : null);
    $("#reportFrame").src = r.has_html ? base + "report.html" : "about:blank";
    if (!r.has_html) head.append(el("span", { class: "small", text: "No report.html yet: run evals.py report on this run." }));
  }

  // tabs, theme, keys

  function showTab(name) {
    S.tab = name;
    for (const b of $$(".tab")) b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    for (const p of $$(".tab-panel")) p.hidden = p.dataset.panel !== name;
    if (name === "sessions") loadSessions();
    if (name === "reports") loadReports();
    store.set("tab", name === "chat" ? "chat" : name);
  }

  const THEMES = ["auto", "light", "dark"];

  function applyTheme(theme) {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    $("#themeBtn").textContent = "Theme: " + theme;
    store.set("theme", theme);
  }

  function wire() {
    for (const b of $$(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));
    $("#themeBtn").addEventListener("click", () => {
      const cur = store.get("theme", "auto");
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    });
    $("#setupToggle").addEventListener("click", () => setSetupOpen($("#setupToggle").getAttribute("aria-expanded") !== "true"));
    $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
    $("#prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.busy) { e.preventDefault(); stopAll(); }
    });
    $("#stopAllBtn").addEventListener("click", stopAll);
    $("#newChatBtn").addEventListener("click", newChat);
    $("#revealBtn").addEventListener("click", reveal);
    $("#blind").addEventListener("change", () => { saveSetup(); renderAll(); });
    $("#saveReasoning").addEventListener("change", renderSetupState);
    $("#greedy").addEventListener("change", () => { syncGreedy(); saveSetup(); renderSetupState(); });
    for (const id of ["temperature", "top_p", "top_k", "seed", "max_tokens", "max_tokens_on"]) $("#" + id).addEventListener("change", () => { saveSetup(); renderSetupState(); });
    $("#pickReady").addEventListener("click", () => {
      S.selected = S.config.models.filter((m) => (S.health[m.name] || m.health) === "ok").map((m) => m.name);
      saveSetup();
      renderAll();
    });
    $("#pickNone").addEventListener("click", () => { S.selected = []; saveSetup(); renderAll(); });
    for (const b of $$("[data-all-mode]")) {
      b.addEventListener("click", () => {
        for (const c of columns()) if ((c.reasoning || []).includes("on") || b.dataset.allMode === "off") S.modes[c.col] = b.dataset.allMode;
        renderToolbar();
        replaceHeads();
      });
    }
    $("#refreshSessions").addEventListener("click", loadSessions);
    $("#refreshReports").addEventListener("click", loadReports);
    setInterval(() => {
      for (const t of S.turns.slice(-1)) for (const r of Object.values(t.replies)) if (r.status === "waiting" || r.status === "streaming") updateStats(r);
    }, 250);
    setInterval(refreshLab, 15000);
    setInterval(refreshHealth, 15000);
  }

  async function boot() {
    applyTheme(store.get("theme", "auto"));
    wire();
    try {
      S.config = await api("/api/config");
    } catch (e) {
      $("#labBanner").replaceChildren(el("span", { class: "lab-item bad", text: "Could not load /api/config: " + e.message }));
      return;
    }
    S.byName = Object.fromEntries(S.config.models.map((m) => [m.name, m]));
    for (const m of S.config.models) S.health[m.name] = m.health;
    S.lab = S.config.lab;
    applyDefaults(S.config.defaults);
    const saved = (store.get("selected", null) || []).filter((n) => S.byName[n]);
    const ready = S.config.models.filter((m) => m.health === "ok").map((m) => m.name);
    S.selected = ready.length ? ready : (saved.length ? saved : S.config.models.filter((m) => !m.replaced_by).map((m) => m.name));
    renderLab();
    renderAll();
    const tab = store.get("tab", "chat");
    if (tab !== "chat") showTab(tab);
    $("#prompt").focus();
  }

  boot();
})();
