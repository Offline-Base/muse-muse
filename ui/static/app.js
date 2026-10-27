/* Muse Privacy approval page. Plain JavaScript, no build step, no external scripts.
   Forms work without this file; with it, decisions post as JSON and the page updates in place. */
(function () {
  "use strict";

  var LABELS = {
    idle: "Idle",
    working: "Working on this device",
    waiting: "Waiting for your OK",
    sending: "Sending a tagged result to Muse"
  };
  var body = document.body;
  var page = body.dataset.page || "";

  function setLight(state) {
    var light = document.getElementById("light");
    if (!light || !LABELS[state]) return;
    light.dataset.state = state;
    var label = document.getElementById("light-label");
    if (label) label.textContent = LABELS[state];
  }

  function listen() {
    if (!window.EventSource || body.dataset.live !== "1") return;
    var source = new EventSource("/events");
    source.onmessage = function (msg) {
      var ev;
      try { ev = JSON.parse(msg.data); } catch (e) { return; }
      setLight(ev.state);
      if (ev.state === "waiting" && page === "approvals") {
        var notice = document.getElementById("new-notice");
        if (notice) notice.hidden = false;
      }
    };
  }

  async function post(url, payload) {
    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload || {}),
      credentials: "same-origin"
    });
    var data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : "That did not go through. Try again.");
    }
    return data;
  }

  function updateBadge(delta) {
    var badge = document.querySelector(".nav-item .badge");
    if (!badge) return;
    var n = Math.max(0, (parseInt(badge.textContent, 10) || 0) + delta);
    if (n === 0) badge.remove(); else badge.textContent = String(n);
  }

  function wireApprovals() {
    document.querySelectorAll("form.js-approval").forEach(function (form) {
      var chosen = null;
      form.querySelectorAll("button[name=approve]").forEach(function (button) {
        button.addEventListener("click", function () { chosen = button.value; });
      });
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var value = event.submitter ? event.submitter.value : chosen;
        var approve = value === "1";
        var remember = form.querySelector("input[name=remember]").checked;
        var card = form.closest(".approval");
        var msg = card.querySelector(".form-msg");
        var buttons = form.querySelectorAll("button");
        buttons.forEach(function (b) { b.disabled = true; });
        try {
          await post(form.action, { approve: approve, remember: remember });
          card.classList.add("done");
          form.remove();
          msg.textContent = approve
            ? "Shared. Muse gets it the next time it checks."
            : "Kept on your device. Muse is told it stays here.";
          updateBadge(-1);
          setTimeout(function () {
            card.remove();
            var list = document.getElementById("approval-list");
            var empty = document.getElementById("approvals-empty");
            if (list && empty && !list.querySelector(".approval")) empty.hidden = false;
          }, 1600);
        } catch (err) {
          msg.textContent = err.message;
          buttons.forEach(function (b) { b.disabled = false; });
        }
      });
    });
  }

  function wireDeletes() {
    document.querySelectorAll("form.js-delete").forEach(function (form) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!window.confirm("Delete this decision? It will be left out of the next dreaming run.")) return;
        var row = form.closest("tr");
        var button = form.querySelector("button");
        button.disabled = true;
        try {
          await post(form.action, {});
          row.classList.add("deleted");
          row.querySelector(".request-cell").innerHTML = '<span class="muted">Deleted</span>';
          form.outerHTML = '<span class="muted">Deleted</span>';
        } catch (err) {
          button.disabled = false;
          window.alert(err.message);
        }
      });
    });
  }

  function wireDream() {
    var form = document.querySelector("form.js-dream");
    if (!form) return;
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = form.querySelector("button");
      var msg = document.getElementById("dream-msg");
      button.disabled = true;
      try {
        await post(form.action, {});
        msg.textContent = "Dreaming started. Reload this page when it finishes to see the new numbers.";
      } catch (err) {
        msg.textContent = err.message;
        button.disabled = false;
      }
    });
  }

  listen();
  wireApprovals();
  wireDeletes();
  wireDream();
})();
