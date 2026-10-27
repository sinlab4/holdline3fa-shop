(function () {
  "use strict";
  var H = window.HL, $ = H.$, esc = H.esc, money = H.money, api = H.api;

  var me = null, catalog = null, orders = [], countries = [];
  var sel = { svc: null, cty: null, q: "" };
  var mode = "login", topCents = 1000, busy = false;

  var STATUS = {
    pending: ["Starting…", "pending"], waiting: ["Waiting for SMS", "waiting"], received: ["Code received", "received"], finished: ["Finished", "closed"],
    cancelled: ["Cancelled · refunded", "closed"], expired: ["No SMS · refunded", "closed"], refunded: ["Refunded by support", "closed"], failed: ["Failed · refunded", "closed"]
  };

  // ---------- header / session ----------
  function renderWho() {
    var w = $("who");
    if (!me) { w.innerHTML = '<button class="btn" id="loginBtn" type="button">Log in</button><button class="btn primary" id="signupBtn" type="button">Create account</button>'; return; }
    w.innerHTML = '<div class="balance"><small>Balance</small><strong id="balance">' + money(me.balance_cents) + '</strong></div>' +
      '<button class="btn primary" id="topupBtn" type="button">Add credit</button>' +
      (me.role === "admin" ? '<a class="btn" href="/admin">Admin</a>' : "") +
      '<button class="btn" id="logoutBtn" type="button" title="' + esc(me.email) + '">Log out</button>';
  }
  async function refreshMe() {
    try { me = (await api("GET", "/api/me")).user; } catch (e) { me = null; }
    renderWho(); renderBuy();
  }

  // ---------- catalog ----------
  function renderChrome() {
    $("siteName").textContent = catalog.siteName; document.title = catalog.siteName;
    var b = $("banner");
    if (catalog.banner) { b.textContent = catalog.banner; b.hidden = false; } else b.hidden = true;
    $("maint").hidden = !catalog.maintenance;
  }
  function renderServices() {
    var q = sel.q.trim().toLowerCase(), all = catalog.services;
    var list = all.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) !== -1; });
    $("svcCount").textContent = list.length + " of " + all.length;
    $("services").innerHTML = list.length ? list.map(function (s) {
      return '<button type="button" class="svc" data-svc="' + s.id + '" aria-pressed="' + (sel.svc === s.id) + '"><span class="tile">' + esc(s.name.charAt(0).toUpperCase()) +
        '</span><span><span class="nm">' + esc(s.name) + '</span><span class="fr">from ' + money(s.from_cents) + '</span></span></button>';
    }).join("") : '<div class="empty">' + (all.length ? "No app matches “" + esc(sel.q) + "”." : "No apps are available right now.") + "</div>";
  }
  function renderCountries() {
    var box = $("countries");
    if (!sel.svc) { box.innerHTML = '<div class="empty">Choose an app to see countries and prices.</div>'; return; }
    if (!countries.length) { box.innerHTML = '<div class="empty">No countries are available for this app right now.</div>'; return; }
    box.innerHTML = countries.map(function (c) {
      return '<button type="button" class="cty" data-cty="' + c.id + '" aria-pressed="' + (sel.cty === c.id) + '"' + (c.stock <= 0 ? " disabled" : "") + '>' +
        '<span class="cn">' + esc(c.name) + "<small>" + esc(c.dial) + '</small></span><span class="st">' + (c.stock <= 0 ? "Out of stock" : c.stock + " in stock") + '</span><span class="pr">' + money(c.price_cents) + "</span></button>";
    }).join("");
  }
  async function loadCountries() {
    countries = [];
    renderCountries();
    if (!sel.svc) return;
    var id = sel.svc;
    try {
      var r = await api("GET", "/api/catalog/" + id + "/countries");
      if (sel.svc !== id) return;
      countries = r.countries;
    } catch (e) { H.toast(e.message); }
    var c = countries.filter(function (x) { return x.id === sel.cty; })[0];
    if (!c || c.stock <= 0) sel.cty = null;
    renderCountries(); renderBuy();
  }
  function renderBuy() {
    var btn = $("buy"), t = $("sumTitle"), s = $("sumSub");
    btn.textContent = "Buy number";
    if (catalog && catalog.maintenance) { t.textContent = "Orders paused"; s.textContent = "Please check back soon."; btn.disabled = true; return; }
    var svc = catalog && catalog.services.filter(function (x) { return x.id === sel.svc; })[0];
    if (!svc) { t.textContent = "Choose an app"; s.textContent = "Prices update with your choice."; btn.disabled = true; return; }
    var c = countries.filter(function (x) { return x.id === sel.cty; })[0];
    if (!c) { t.textContent = svc.name; s.textContent = "Now choose a country."; btn.disabled = true; return; }
    t.textContent = svc.name + " · " + c.name;
    btn.textContent = "Buy for " + money(c.price_cents);
    if (!me) { s.textContent = "Log in or create an account to buy."; btn.disabled = false; }
    else if (me.balance_cents < c.price_cents) { s.textContent = "You need " + money(c.price_cents - me.balance_cents) + " more credit."; btn.disabled = false; btn.textContent = "Add credit"; }
    else { s.textContent = "Held for " + catalog.holdMinutes + " minutes. Refunded if no SMS arrives."; btn.disabled = busy; }
  }

  // ---------- orders ----------
  function orderHtml(o) {
    var st = STATUS[o.status] || [o.status, "closed"], body = "", actions = "";
    if (o.status === "waiting" || o.status === "pending") {
      body = '<div class="wait"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Request the code in ' + esc(o.service) + ' now. Time left <b class="mono" data-left="' + o.id + '" data-exp="' + (o.expires_at || 0) + '">' + (o.expires_at ? H.clock(o.expires_at - Date.now()) : "–") + '</b></span></div>';
      if (o.status === "waiting") actions = '<button class="btn small" type="button" data-act="cancel" data-id="' + o.id + '">Cancel and refund</button>';
    } else if (o.status === "received") {
      body = '<div class="numrow"><div><span class="k">Verification code</span><span class="code" id="code-' + o.id + '">' + esc(o.code) + '</span></div><button class="btn small" type="button" data-act="copycode" data-id="' + o.id + '">Copy</button></div>' +
        (o.sms_text ? '<div class="sms">“' + esc(o.sms_text) + '”</div>' : "");
      actions = '<button class="btn small" type="button" data-act="finish" data-id="' + o.id + '">Finish</button>';
    }
    var live = ["waiting", "received", "finished"].indexOf(o.status) !== -1 && o.phone;
    var num = live ? '<div class="numrow"><div><span class="k">Number</span><span class="v" id="num-' + o.id + '">' + esc(o.phone) + "</span></div>" +
      (o.status === "finished" ? "" : '<button class="btn small" type="button" data-act="copynum" data-id="' + o.id + '">Copy</button>') + "</div>" : "";
    return '<article class="order ' + esc(o.status) + '"><div class="row"><div class="o-svc"><span class="tile">' + esc(o.service.charAt(0).toUpperCase()) + "</span><span>" + esc(o.service) + '</span></div><span class="pill ' + st[1] + '">' + st[0] + "</span></div>" +
      num + body + '<div class="o-foot"><span>' + esc(o.country) + " · " + money(o.price_cents) + "</span><div>" + actions + "</div></div></article>";
  }
  function renderOrders() {
    var box = $("orders");
    if (!me) { box.innerHTML = '<div class="empty">Log in to see your numbers and codes.</div>'; return; }
    box.innerHTML = orders.length ? orders.map(orderHtml).join("") : '<div class="empty">No numbers yet. Pick an app and a country to buy your first one. The number and its code will appear here.</div>';
  }
  var lastSig = "";
  async function pollOrders() {
    if (!me) return;
    try {
      var r = await api("GET", "/api/orders");
      var sig = JSON.stringify(r.orders.map(function (o) { return [o.id, o.status, o.code]; }));
      var newCode = r.orders.some(function (o) { return o.status === "received" && !orders.some(function (p) { return p.id === o.id && p.status === "received"; }) && orders.length; });
      orders = r.orders;
      if (sig !== lastSig) { lastSig = sig; renderOrders(); await refreshMe(); }
      if (newCode) H.toast("Your code has arrived");
    } catch (e) { if (e.status === 401) { me = null; renderWho(); renderOrders(); } }
  }
  function tick() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-left]"), function (el) {
      var exp = Number(el.dataset.exp); if (exp) el.textContent = H.clock(exp - Date.now());
    });
  }

  // ---------- dialogs ----------
  function openAuth(m) {
    mode = m;
    var login = m === "login";
    $("authTitle").textContent = login ? "Log in" : "Create account";
    $("authSubmit").textContent = login ? "Log in" : "Create account";
    $("authSwitch").textContent = login ? "Need an account? Create one" : "Already have an account? Log in";
    $("termsRow").hidden = login; $("pwHint").hidden = login;
    $("password").autocomplete = login ? "current-password" : "new-password";
    $("password").minLength = login ? 1 : 10;
    $("authErr").textContent = "";
    var d = $("authDlg"); if (!d.open) d.showModal();
    $("email").focus();
  }
  async function submitAuth(e) {
    e.preventDefault();
    var err = $("authErr"); err.textContent = "";
    var login = mode === "login";
    if (!login && !$("terms").checked) { err.textContent = "Please accept the rules to continue."; return; }
    $("authSubmit").disabled = true;
    try {
      var r = await api("POST", login ? "/api/auth/login" : "/api/auth/register", { email: $("email").value, password: $("password").value, acceptTerms: $("terms").checked });
      me = r.user; $("password").value = ""; $("authDlg").close();
      renderWho(); renderBuy(); lastSig = ""; await pollOrders(); renderOrders();
      H.toast(login ? "Welcome back" : "Account created");
    } catch (ex) { err.textContent = ex.message; }
    $("authSubmit").disabled = false;
  }

  function openTopup() {
    var min = (catalog && catalog.topupMin) || 100000;
    var m = catalog && catalog.topupMode;
    var presets = [100000, 200000, 500000, 1000000, 2000000].filter(function (c) { return c >= min; });
    topCents = presets[1] || presets[0] || min;
    $("amounts").innerHTML = presets.map(function (c) { return '<button class="btn small" type="button" data-amt="' + c + '" aria-pressed="' + (c === topCents) + '">' + money(c) + "</button>"; }).join("");
    $("customAmt").value = "";
    $("topErr").textContent = "";
    $("topNote").textContent = m === "stripe" ? "You will be sent to a secure card payment page. Your balance updates as soon as the payment completes." :
      m === "demo" ? "Test mode: credit is added instantly and no payment is taken." : "Card payments are not set up yet. Please check back soon.";
    $("topSubmit").disabled = m === "none";
    var d = $("topupDlg"); if (!d.open) d.showModal();
  }
  async function submitTopup(e) {
    e.preventDefault();
    var custom = parseFloat($("customAmt").value);
    var cents = isFinite(custom) && custom > 0 ? Math.round(custom) * 100 : topCents;
    $("topErr").textContent = ""; $("topSubmit").disabled = true;
    try {
      var r = await api("POST", "/api/wallet/topup", { amountCents: cents });
      if (r.url) { location.href = r.url; return; }
      $("topupDlg").close(); await refreshMe(); H.toast("Credit added");
    } catch (ex) { $("topErr").textContent = ex.message; }
    $("topSubmit").disabled = false;
  }

  async function buy() {
    var c = countries.filter(function (x) { return x.id === sel.cty; })[0];
    if (!c) return;
    if (!me) { openAuth("signup"); return; }
    if (me.balance_cents < c.price_cents) { openTopup(); return; }
    busy = true; renderBuy();
    try {
      await api("POST", "/api/orders", { serviceId: sel.svc, countryId: sel.cty });
      H.toast("Number reserved"); lastSig = ""; await pollOrders();
    } catch (e) { H.toast(e.message); if (e.status === 401) { me = null; renderWho(); } loadCountries(); }
    busy = false; await refreshMe();
  }

  // ---------- events ----------
  document.addEventListener("click", async function (e) {
    var t = e.target.closest("button"); if (!t) return;
    var id = t.id;
    if (id === "loginBtn") return openAuth("login");
    if (id === "signupBtn") return openAuth("signup");
    if (id === "authSwitch") return openAuth(mode === "login" ? "signup" : "login");
    if (id === "authCancel") return $("authDlg").close();
    if (id === "topupBtn") return openTopup();
    if (id === "topCancel") return $("topupDlg").close();
    if (id === "logoutBtn") { try { await api("POST", "/api/auth/logout"); } catch (x) {} me = null; orders = []; lastSig = ""; renderWho(); renderOrders(); renderBuy(); return; }
    if (id === "buy") return buy();
    if (t.dataset.amt) {
      topCents = Number(t.dataset.amt); $("customAmt").value = "";
      Array.prototype.forEach.call($("amounts").children, function (b) { b.setAttribute("aria-pressed", b === t ? "true" : "false"); });
      return;
    }
    if (t.dataset.svc) { sel.svc = Number(t.dataset.svc); sel.cty = null; renderServices(); renderBuy(); return loadCountries(); }
    if (t.dataset.cty) { sel.cty = Number(t.dataset.cty); renderCountries(); renderBuy(); return; }
    var act = t.dataset.act; if (!act) return;
    var o = orders.filter(function (x) { return x.id === Number(t.dataset.id); })[0]; if (!o) return;
    if (act === "copynum") return H.copy(o.phone, $("num-" + o.id));
    if (act === "copycode") return H.copy(o.code, $("code-" + o.id));
    try {
      await api("POST", "/api/orders/" + o.id + "/" + act);
      H.toast(act === "cancel" ? "Refunded" : "Done"); lastSig = ""; await pollOrders();
    } catch (ex) { H.toast(ex.message); pollOrders(); }
  });
  $("authForm").addEventListener("submit", submitAuth);
  $("topupForm").addEventListener("submit", submitTopup);
  $("q").addEventListener("input", function (e) { sel.q = e.target.value; renderServices(); });

  // ---------- start ----------
  (async function init() {
    try { catalog = await api("GET", "/api/catalog"); } catch (e) { $("services").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; return; }
    renderChrome(); renderServices(); renderCountries(); renderOrders();
    await refreshMe();
    var p = new URLSearchParams(location.search);
    if (p.get("topup") === "success") { var n = $("paid"); n.textContent = "Payment received. Your credit appears in your balance within a few seconds."; n.hidden = false; history.replaceState(null, "", "/"); setTimeout(refreshMe, 4000); }
    else if (p.get("topup") === "cancelled") { history.replaceState(null, "", "/"); }
    else if (p.get("login") === "admin" && !me) { openAuth("login"); history.replaceState(null, "", "/"); }
    await pollOrders(); renderOrders();
    setInterval(pollOrders, 3000);
    setInterval(tick, 1000);
    setInterval(async function () { try { catalog = await api("GET", "/api/catalog"); renderChrome(); renderBuy(); } catch (e) {} }, 30000);
  })();
})();
