/* Helpers shared by the shop and admin pages. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); }
  function money(kobo) { return "\u20a6" + Math.round(Number(kobo) / 100).toLocaleString("en-NG"); }
  function clock(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function when(ms) { try { return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }

  async function api(method, url, body) {
    var res;
    try {
      res = await fetch(url, { method: method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    } catch (e) { throw new Error("Could not reach the server. Check your connection."); }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error((data && data.error) || "Something went wrong."); err.status = res.status; throw err; }
    return data;
  }

  var timer;
  function toast(msg) {
    var t = $("toast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(timer); timer = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }
  function copy(text, node) {
    function fallback() {
      try { var r = document.createRange(); r.selectNodeContents(node); var s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Press copy on your device."); } catch (e) {}
    }
    try { navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, fallback); } catch (e) { fallback(); }
  }
  window.HL = { $: $, esc: esc, money: money, clock: clock, when: when, api: api, toast: toast, copy: copy };
})();
