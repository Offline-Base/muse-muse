/* The animated "How it works" diagram (markup from base/flow.py). Plain JavaScript, no external
   scripts, nothing fetched. Used by the approval page's How it works page and the landing page:
   site/flow.js is a copy of ui/static/flow.js. Every example in the stories is invented. */
(function () {
  "use strict";

  // [from, to, shape]. A move along an edge can run either way.
  var EDGES = [
    ["files", "model"], ["model", "tagging"], ["tagging", "rules"], ["rules", "check"],
    ["check", "muse"], ["muse", "model", "loop"], ["model", "you"], ["rules", "kept"],
    ["rules", "approvals"], ["approvals", "check"]
  ];
  var LOOP_LABEL = "Muse asks with tags, like [Student A]";
  var STEP_MS = 3400;
  var MOVE_MS = 1100;

  // Each step: moves ([from, to, token text]), the boxes it lights up, a tone and the words.
  var STORIES = {
    shared: [
      { moves: [["muse", "model", "[Student A]"]], at: ["muse"], tone: "send",
        text: "Muse asks with a tag: how did [Student A] do on the garden essay? It never sees the real name." },
      { moves: [["files", "model", "24 essays"]], at: ["files", "model"], tone: "ok",
        text: "On this device only, the tag becomes the name again, and Muse Glimmer reads the essays." },
      { moves: [["model", "tagging", "answer"]], at: ["tagging"], tone: "ok",
        text: "Every name and identifier in the answer becomes a tag again." },
      { moves: [["tagging", "rules", "[Student A]: 3 of 4"]], at: ["rules"], tone: "ok",
        text: "Your rules decide. Grades for your own records can go as tags." },
      { moves: [["rules", "check", "[Student A]: 3 of 4"]], at: ["check"], tone: "ok",
        text: "The final check looks for anything private one more time." },
      { moves: [["check", "muse", "[Student A]: 3 of 4"]], at: ["muse"], tone: "send",
        text: "Muse gets only the tagged answer, through the relay. You get a receipt in History." }
    ],
    ask: [
      { moves: [["muse", "model", "[Student A]"]], at: ["muse"], tone: "send",
        text: "Muse asks: draft a note to [Student A]'s family about the essay." },
      { moves: [["files", "model", "essay"]], at: ["files", "model"], tone: "ok",
        text: "Muse Glimmer reads the essay and drafts the note." },
      { moves: [["model", "tagging", "note"]], at: ["tagging"], tone: "ok",
        text: "Names in the note become tags." },
      { moves: [["tagging", "rules", "note"]], at: ["rules"], tone: "wait",
        text: "The note is going to a family, so your rules ask you first." },
      { moves: [["rules", "approvals", "note"]], at: ["approvals"], tone: "wait",
        text: "It waits for you with the exact text that would leave. You choose Share it." },
      { moves: [["approvals", "check", "note"]], at: ["check"], tone: "ok",
        text: "The final check runs again on what you approved." },
      { moves: [["check", "muse", "tagged note"]], at: ["muse"], tone: "send",
        text: "Muse gets the tagged note. Nothing went until you said so." }
    ],
    kept: [
      { moves: [["muse", "model", "[Student A]"]], at: ["muse"], tone: "send",
        text: "Muse asks: what are [Student A]'s IEP accommodations?" },
      { moves: [["files", "model", "record"]], at: ["files", "model"], tone: "ok",
        text: "Muse Glimmer finds the record." },
      { moves: [["model", "tagging", "answer"], ["tagging", "rules", "answer"]], at: ["rules"], tone: "danger",
        text: "Names become tags, but the answer is about a topic you never share." },
      { moves: [["rules", "kept", "answer"]], at: ["kept"], tone: "danger",
        text: "So it stays on this device. None of it is sent." },
      { moves: [["rules", "check", "Kept here"], ["check", "muse", "Kept here"]], at: ["muse"], tone: "danger",
        text: "Muse only gets a fixed sentence saying it was kept, and why." }
    ],
    toggle: [
      { moves: [["muse", "model", "question"]], at: ["muse"], tone: "send",
        text: "With FERPA on, Muse asks: how many students missed the field trip?" },
      { moves: [["files", "model", "forms"]], at: ["files", "model"], tone: "ok",
        text: "Muse Glimmer counts the forms." },
      { moves: [["model", "tagging", "answer"]], at: ["tagging"], tone: "ok",
        text: "The toggle tags more: places, dates, schools and record numbers too." },
      { moves: [["tagging", "rules", "3 students"]], at: ["rules"], tone: "danger",
        text: "The answer is about 3 students. Fewer than 10 could point to them, so the toggle keeps it." },
      { moves: [["rules", "kept", "3 students"]], at: ["kept"], tone: "danger",
        text: "It stays on this device. Always approve can't send it while a toggle is on." },
      { moves: [["rules", "check", "Kept here"], ["check", "muse", "Kept here"]], at: ["muse"], tone: "danger",
        text: "Muse gets a fixed sentence with the reason." }
    ],
    local: [
      { moves: [["you", "model", "question"]], at: ["you"], tone: "ok",
        text: "You ask on this device: which essays mention bees?" },
      { moves: [["files", "model", "essays"]], at: ["files", "model"], tone: "ok",
        text: "A model on the device would search and read your documents. This is off for now." },
      { moves: [["model", "you", "answer"]], at: ["you"], tone: "ok",
        text: "The answer, with real names, shows only on that page." },
      { moves: [], at: ["muse"], tone: "off",
        text: "Nothing goes to Muse: no tags, no summary." }
    ]
  };

  var LIVE = {
    idle: "Live: the device is idle.",
    working: "Live: the model is working now.",
    waiting: "Live: a result is waiting for your OK.",
    sending: "Live: a tagged result is going to Muse."
  };
  var LIVE_AT = { working: ["model"], waiting: ["approvals"], sending: ["check", "muse"] };
  var LIVE_TONE = { working: "ok", waiting: "wait", sending: "send" };
  var TONES = ["t-ok", "t-wait", "t-danger", "t-send", "t-off"];
  var still = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function rect(el, origin) {
    var r = el.getBoundingClientRect();
    var l = r.left - origin.left, t = r.top - origin.top;
    return { l: l, t: t, r: l + r.width, b: t + r.height, w: r.width, h: r.height, cx: l + r.width / 2, cy: t + r.height / 2 };
  }

  function border(a, b) {
    var dx = b.cx - a.cx, dy = b.cy - a.cy;
    var sx = dx ? a.w / 2 / Math.abs(dx) : Infinity, sy = dy ? a.h / 2 / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return [a.cx + dx * s, a.cy + dy * s];
  }

  // A straight wire: level when the boxes share a row or a column, else between their borders.
  function straight(a, b) {
    var top = Math.max(a.t, b.t), bottom = Math.min(a.b, b.b);
    if (bottom - top > 12) {
      var y = (top + bottom) / 2;
      return a.cx < b.cx ? [a.r, y, b.l, y] : [a.l, y, b.r, y];
    }
    var left = Math.max(a.l, b.l), right = Math.min(a.r, b.r);
    if (right - left > 12) {
      var x = (left + right) / 2;
      return a.cy < b.cy ? [x, a.b, x, b.t] : [x, a.t, x, b.b];
    }
    return border(a, b).concat(border(b, a));
  }

  // A path through points with rounded corners.
  function elbow(points) {
    var d = "M" + points[0][0] + " " + points[0][1];
    for (var i = 1; i < points.length - 1; i++) {
      var p = points[i - 1], c = points[i], n = points[i + 1];
      var r = Math.min(12, Math.hypot(c[0] - p[0], c[1] - p[1]) / 2, Math.hypot(n[0] - c[0], n[1] - c[1]) / 2);
      var a = towards(c, p, r), b = towards(c, n, r);
      d += " L" + a[0] + " " + a[1] + " Q" + c[0] + " " + c[1] + " " + b[0] + " " + b[1];
    }
    var last = points[points.length - 1];
    return d + " L" + last[0] + " " + last[1];
  }

  function towards(from, to, r) {
    var dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
    return [from[0] + dx / len * r, from[1] + dy / len * r];
  }

  function Flow(fig) {
    this.fig = fig;
    this.stage = fig.querySelector(".flow-stage");
    this.svg = fig.querySelector(".flow-wires");
    this.token = fig.querySelector(".flow-token:not(.flow-live-token)");
    this.liveToken = fig.querySelector(".flow-live-token");
    this.list = fig.querySelector(".flow-steps");
    this.playButton = fig.querySelector("[data-flow-play]");
    this.story = "shared";
    this.step = 0;
    this.playing = !still;
    this.visible = true;
    this.timer = null;
    this.run = 0;
    this.nodes = {};
    var self = this;
    fig.querySelectorAll("[data-node]").forEach(function (n) { self.nodes[n.dataset.node] = n; });
    fig.querySelectorAll("[data-story]").forEach(function (b) {
      b.addEventListener("click", function () { self.choose(b.dataset.story); });
    });
    this.playButton.addEventListener("click", function () { self.setPlaying(!self.playing); });
    fig.querySelector("[data-flow-next]").addEventListener("click", function () {
      self.step = (self.step + 1) % STORIES[self.story].length;
      self.show();
    });
    this.setPlaying(this.playing, true);
    this.draw();
    this.choose("shared");
    if (window.ResizeObserver) new ResizeObserver(function () { self.draw(); self.settle(); }).observe(this.stage);
    else window.addEventListener("resize", function () { self.draw(); self.settle(); });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        self.visible = entries[0].isIntersecting;
        if (self.visible && self.playing && !self.timer) self.show();
      }).observe(fig);
    }
    if (fig.dataset.live === "1") {
      this.liveLine = fig.querySelector(".flow-live");
      this.setLive(fig.dataset.light || "idle");
      document.addEventListener("muse:light", function (ev) { self.setLive(ev.detail); });
    }
  }

  Flow.prototype.draw = function () {
    var origin = this.stage.getBoundingClientRect();
    var boxes = {}, self = this;
    Object.keys(this.nodes).forEach(function (k) { boxes[k] = rect(self.nodes[k], origin); });
    var device = rect(this.fig.querySelector(".flow-device"), origin);
    var level = boxes.muse && boxes.model && boxes.muse.l > boxes.model.r;  // Muse to the right: one row
    var html = "";
    EDGES.forEach(function (e) {
      var a = boxes[e[0]], b = boxes[e[1]], d;
      if (!a || !b) return;
      if (e[2] === "loop") {
        d = level
          ? elbow([[a.cx, a.t], [a.cx, device.t + 44], [b.cx, device.t + 44], [b.cx, b.t]])
          : elbow([[a.l, a.cy], [device.l + 16, a.cy], [device.l + 16, b.cy], [b.l, b.cy]]);
      } else {
        var p = straight(a, b);
        d = "M" + p[0] + " " + p[1] + " L" + p[2] + " " + p[3];
      }
      html += '<path class="flow-wire" data-edge="' + e[0] + ">" + e[1] + '" d="' + d + '"/>';
    });
    if (level) {
      var x = (boxes.model.cx + device.r) / 2;
      html += '<text class="flow-wire-label" x="' + x + '" y="' + (device.t + 36) + '" text-anchor="middle">' + LOOP_LABEL + "</text>";
    }
    this.svg.setAttribute("viewBox", "0 0 " + origin.width + " " + origin.height);
    this.svg.innerHTML = html;
    this.markWires();
  };

  Flow.prototype.path = function (from, to) {
    var p = this.svg.querySelector('[data-edge="' + from + ">" + to + '"]');
    if (p) return { el: p, back: false };
    p = this.svg.querySelector('[data-edge="' + to + ">" + from + '"]');
    return p ? { el: p, back: true } : null;
  };

  Flow.prototype.choose = function (key) {
    if (!STORIES[key]) return;
    this.story = key;
    this.step = 0;
    this.fig.querySelectorAll("[data-story]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.story === key ? "true" : "false");
    });
    this.list.innerHTML = "";
    var self = this;
    STORIES[key].forEach(function (s) {
      var li = document.createElement("li");
      li.textContent = s.text;
      self.list.appendChild(li);
    });
    this.show();
  };

  Flow.prototype.setPlaying = function (on, quiet) {
    this.playing = on;
    this.playButton.textContent = on ? "Pause" : "Play";
    this.playButton.setAttribute("aria-pressed", on ? "false" : "true");
    if (quiet) return;
    if (on) this.show();
    else this.stop();
  };

  Flow.prototype.stop = function () {
    clearTimeout(this.timer);
    this.timer = null;
  };

  Flow.prototype.show = function () {
    this.stop();
    var run = ++this.run, self = this;
    var step = STORIES[this.story][this.step];
    this.list.querySelectorAll("li").forEach(function (li, i) {
      if (i === self.step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    this.list.className = "flow-steps t-" + step.tone;
    Object.keys(this.nodes).forEach(function (k) {
      var n = self.nodes[k];
      n.classList.remove("on");
      TONES.forEach(function (t) { n.classList.remove(t); });
      if (step.at.indexOf(k) >= 0) n.classList.add("on", "t-" + step.tone);
    });
    this.active = step.moves.map(function (m) { return m.slice(0, 2); });
    this.tone = step.tone;
    this.markWires();
    this.token.hidden = true;
    var i = 0;
    (function next() {
      if (run !== self.run) return;
      if (i >= step.moves.length) {
        // Once it lands, the token fades so the box it reached can be read.
        setTimeout(function () { if (run === self.run) self.token.classList.add("landed"); }, 700);
        return;
      }
      var m = step.moves[i++];
      self.move(self.token, m[0], m[1], m[2], step.tone, run, next);
    })();
    if (this.playing && this.visible) {
      this.timer = setTimeout(function () {
        self.step = (self.step + 1) % STORIES[self.story].length;
        self.show();
      }, STEP_MS + Math.max(0, step.moves.length - 1) * MOVE_MS);
    }
  };

  Flow.prototype.markWires = function () {
    var self = this;
    this.svg.querySelectorAll(".flow-wire").forEach(function (w) {
      w.classList.remove("on");
      TONES.forEach(function (t) { w.classList.remove(t); });
    });
    (this.active || []).forEach(function (m) {
      var p = self.path(m[0], m[1]);
      if (p) p.el.classList.add("on", "t-" + self.tone);
    });
  };

  // Put the token where the step's last move ended, after a redraw.
  Flow.prototype.settle = function () {
    var step = STORIES[this.story][this.step];
    var m = step.moves[step.moves.length - 1];
    if (!m || this.token.hidden) return;
    var p = this.path(m[0], m[1]);
    if (p) this.place(this.token, p, 1);
  };

  Flow.prototype.place = function (token, p, t) {
    var len = p.el.getTotalLength();
    var pt = p.el.getPointAtLength((p.back ? 1 - t : t) * len);
    token.style.transform = "translate(" + pt.x + "px, " + pt.y + "px) translate(-50%, -50%)";
  };

  Flow.prototype.move = function (token, from, to, label, tone, run, done) {
    var p = this.path(from, to), self = this;
    if (!p) { done(); return; }
    token.textContent = label;
    token.classList.remove("landed");
    TONES.forEach(function (t) { token.classList.remove(t); });
    token.classList.add("t-" + tone);
    token.hidden = false;
    if (still) { this.place(token, p, 1); done(); return; }
    var start = null;
    function frame(now) {
      if (run !== undefined && run !== self.run) return;
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / MOVE_MS);
      self.place(token, p, t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      if (t < 1) requestAnimationFrame(frame);
      else done();
    }
    requestAnimationFrame(frame);
  };

  // What the device is doing right now (approval page only), from the page's light events.
  Flow.prototype.setLive = function (state) {
    if (!LIVE[state]) return;
    var self = this;
    this.liveLine.textContent = LIVE[state];
    this.liveLine.dataset.state = state;
    Object.keys(this.nodes).forEach(function (k) {
      var n = self.nodes[k];
      n.classList.remove("live", "live-ok", "live-wait", "live-send");
      if ((LIVE_AT[state] || []).indexOf(k) >= 0) n.classList.add("live", "live-" + LIVE_TONE[state]);
    });
    if (state === "sending") {
      this.move(this.liveToken, "check", "muse", "tagged result", "send", undefined, function () {
        setTimeout(function () { self.liveToken.hidden = true; }, 1200);
      });
    }
  };

  document.querySelectorAll("[data-flow]").forEach(function (fig) { new Flow(fig); });
})();
