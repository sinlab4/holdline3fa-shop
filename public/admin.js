(function () {
  "use strict";
  var H = window.HL, $ = H.$, esc = H.esc, money = H.money, api = H.api;
  var tab = "overview", ofilter = "", cache = {};

  var STATUS = { pending: "Starting", waiting: "Waiting", received: "Code received", finished: "Finished", cancelled: "Cancelled", expired: "No SMS", refunded: "Refunded", failed: "Failed" };
  var CLOSED = ["finished", "cancelled", "expired", "refunded", "failed"];
  function pill(s) { return '<span class="pill ' + (CLOSED.indexOf(s) !== -1 ? "closed" : s) + '">' + esc(STATUS[s] || s) + "</span>"; }
  function table(head, rows) {
    return '<div class="tablewrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
  }
  function ordersTable(list, withActions) {
    if (!list.length) return '<div class="empty">No orders yet. They appear here as customers buy numbers.</div>';
    return table(["Time", "Customer", "App", "Country", "Number", "Price", "Status"].concat(withActions ? ["Actions"] : []), list.map(function (o) {
      var act = "";
      if (withActions && (o.status === "waiting" || o.status === "received")) act = '<button class="btn small danger" type="button" data-refund="' + o.id + '">Refund</button>';
      return "<tr><td class=\"mono\">" + H.when(o.created_at) + "</td><td>" + esc(o.email) + "</td><td>" + esc(o.service) + "</td><td>" + esc(o.country) + '</td><td class="mono">' + esc(o.phone || "–") +
        '</td><td class="mono">' + money(o.price_cents) + "</td><td>" + pill(o.status) + "</td>" + (withActions ? "<td>" + act + "</td>" : "") + "</tr>";
    }));
  }

  // ---------- tabs ----------
  async function overview() {
    var o = await api("GET", "/api/admin/overview"), ord = await api("GET", "/api/admin/orders");
    var rate = o.closed ? Math.round(o.delivered / o.closed * 100) + "%" : "–";
    var pn = $("provNote");
    pn.hidden = o.provider !== "mock";
    pn.textContent = "Numbers and codes are simulated (PROVIDER=mock). Connect a real number provider before selling to the public.";
    var max = o.topApps.length ? o.topApps[0].cents : 1;
    var bars = o.topApps.length ? o.topApps.map(function (a) {
      return '<div class="bar"><span>' + esc(a.name) + '</span><span class="track"><span class="fill" data-w="' + Math.max(4, Math.round(a.cents / max * 100)) + '"></span></span><span class="mono">' + money(a.cents) + "</span></div>";
    }).join("") : '<div class="empty">Revenue by app appears after the first delivered code.</div>';
    $("body").innerHTML = '<div class="stats">' + [["Orders", o.orders], ["Revenue", money(o.revenue)], ["Refunded", money(o.refunded)], ["Waiting now", o.waiting], ["Delivery rate", rate], ["Customers", o.users]]
      .map(function (s) { return '<div class="stat"><small>' + s[0] + "</small><strong>" + s[1] + "</strong></div>"; }).join("") + "</div>" +
      '<div class="two"><div class="panel"><h3>Top apps by revenue</h3><div class="col">' + bars + '</div></div><div class="panel"><h3>Latest orders</h3>' + ordersTable(ord.orders.slice(0, 8), false) + "</div></div>";
    fillBars();
  }
  function fillBars() { Array.prototype.forEach.call(document.querySelectorAll(".fill[data-w]"), function (el) { el.style.width = el.dataset.w + "%"; }); }

  async function ordersTab() {
    var r = await api("GET", "/api/admin/orders" + (ofilter ? "?status=" + encodeURIComponent(ofilter) : ""));
    var opts = [""].concat(Object.keys(STATUS));
    $("body").innerHTML = '<div class="toolbar"><div class="inline"><label class="hint" for="ofilter">Show</label><select class="cell auto" id="ofilter">' +
      opts.map(function (s) { return '<option value="' + s + '"' + (s === ofilter ? " selected" : "") + ">" + (s ? STATUS[s] : "All orders") + "</option>"; }).join("") +
      '</select></div><span class="hint">' + r.orders.length + " shown (latest 300)</span></div>" + ordersTable(r.orders, true);
  }

  async function customers() {
    var r = await api("GET", "/api/admin/users");
    if (!r.users.length) { $("body").innerHTML = '<div class="empty">Customers appear here after they sign up.</div>'; return; }
    $("body").innerHTML = table(["Customer", "Joined", "Balance", "Orders", "Spent", "Adjust balance", "Account"], r.users.map(function (u) {
      var adj = [[-100000, "−\u20a61,000"], [100000, "+\u20a61,000"], [500000, "+\u20a65,000"], [1000000, "+\u20a610,000"]].map(function (d) { return '<button class="btn small" type="button" data-credit="' + u.id + '" data-amt="' + d[0] + '">' + d[1] + "</button>"; }).join("");
      var acct = u.role === "admin" ? '<span class="hint">Admin</span>' : '<button class="btn small ' + (u.disabled ? "" : "danger") + '" type="button" data-disable="' + u.id + '" data-to="' + (u.disabled ? 0 : 1) + '">' + (u.disabled ? "Enable" : "Disable") + "</button>";
      return "<tr><td>" + esc(u.email) + (u.disabled ? ' <span class="pill closed">Disabled</span>' : "") + '</td><td class="mono">' + H.when(u.created_at) + '</td><td class="mono">' + money(u.balance_cents) + '</td><td class="mono">' + u.orders + '</td><td class="mono">' + money(u.spent_cents) + '</td><td><div class="btnrow">' + adj + "</div></td><td>" + acct + "</td></tr>";
    }));
  }

  async function catalogTab() {
    var r = await api("GET", "/api/admin/catalog");
    cache.catalog = r;
    var sv = r.services.map(function (s) {
      return "<tr><td><input class=\"sw\" type=\"checkbox\" aria-label=\"Show " + esc(s.name) + "\" data-svc=\"" + s.id + "\" data-f=\"enabled\"" + (s.enabled ? " checked" : "") + "></td>" +
        '<td><input class="cell" aria-label="App name" value="' + esc(s.name) + '" data-svc="' + s.id + '" data-f="name"></td>' +
        '<td><input class="cell num" type="number" min="1" step="10" aria-label="Base price in naira" value="' + Math.round(s.base_cents / 100) + '" data-svc="' + s.id + '" data-f="base_cents"></td>' +
        '<td><input class="cell num" aria-label="Provider code" value="' + esc(s.provider_code) + '" data-svc="' + s.id + '" data-f="provider_code"></td>' +
        '<td><button class="btn small danger" type="button" data-delsvc="' + s.id + '">Remove</button></td></tr>';
    });
    var cs = r.countries.map(function (c) {
      return "<tr><td><input class=\"sw\" type=\"checkbox\" aria-label=\"Show " + esc(c.name) + "\" data-cty=\"" + c.id + "\" data-f=\"enabled\"" + (c.enabled ? " checked" : "") + "></td>" +
        '<td><input class="cell" aria-label="Country name" value="' + esc(c.name) + '" data-cty="' + c.id + '" data-f="name"></td>' +
        '<td><input class="cell num" aria-label="Dial code" value="' + esc(c.dial) + '" data-cty="' + c.id + '" data-f="dial"></td>' +
        '<td><input class="cell num" type="number" min="0.1" step="0.05" aria-label="Price multiplier" value="' + c.mult + '" data-cty="' + c.id + '" data-f="mult"></td>' +
        '<td><input class="cell num" type="number" min="0" step="1" placeholder="auto" aria-label="Stock override" value="' + (c.stock_override == null ? "" : c.stock_override) + '" data-cty="' + c.id + '" data-f="stock_override"></td>' +
        '<td><input class="cell num" aria-label="Provider code" value="' + esc(c.provider_code) + '" data-cty="' + c.id + '" data-f="provider_code"></td>' +
        '<td><button class="btn small danger" type="button" data-delcty="' + c.id + '">Remove</button></td></tr>';
    });
    $("body").innerHTML =
      '<div class="panel"><div class="toolbar"><h3>Apps</h3><span class="hint">Edits save when you leave a field. Provider code is the id your number provider uses for the app.</span></div>' +
      table(["Shown", "App", "Base price (\u20a6)", "Provider code", ""], sv) +
      '<div class="addrow"><div class="field"><label for="nsName">New app</label><input class="input" id="nsName" placeholder="e.g. Reddit"></div><div class="field"><label for="nsPrice">Base price (\u20a6)</label><input class="input" id="nsPrice" type="number" min="1" step="10" value="400"></div><button class="btn" type="button" id="addSvc">Add app</button></div></div>' +
      '<div class="panel"><div class="toolbar"><h3>Countries</h3><span class="hint">Price = base price × multiplier. Stock blank means use the provider\'s count; 0 marks it sold out.</span></div>' +
      table(["Shown", "Country", "Dial", "Price ×", "Stock", "Provider code", ""], cs) +
      '<div class="addrow"><div class="field"><label for="ncName">New country</label><input class="input" id="ncName" placeholder="e.g. Kenya"></div><div class="field"><label for="ncIso">Country code</label><input class="input" id="ncIso" placeholder="ke" maxlength="8"></div><div class="field"><label for="ncDial">Dial code</label><input class="input" id="ncDial" placeholder="+254"></div><div class="field"><label for="ncMult">Price ×</label><input class="input" id="ncMult" type="number" min="0.1" step="0.05" value="1"></div><button class="btn" type="button" id="addCty">Add country</button></div></div>';
  }

  async function settingsTab() {
    var s = (await api("GET", "/api/admin/settings")).settings;
    $("body").innerHTML = '<div class="panel"><h3>Storefront</h3><div class="fields">' +
      '<div class="field"><label for="sBanner">Announcement banner</label><input class="input" id="sBanner" maxlength="200" placeholder="Shown at the top of the shop. Blank hides it." value="' + esc(s.banner) + '"></div>' +
      '<div class="field"><span class="lbl">Maintenance mode</span><label class="inline"><input class="sw" id="sMaint" type="checkbox"' + (s.maintenance ? " checked" : "") + '><span>Pause new orders</span></label><span class="hint">Customers keep access to numbers they already bought.</span></div>' +
      '<div class="field"><span class="lbl">New sign-ups</span><label class="inline"><input class="sw" id="sSignups" type="checkbox"' + (s.signupsOpen ? " checked" : "") + '><span>Allow new accounts</span></label></div>' +
      '</div></div><div class="panel"><h3>Orders</h3><div class="fields">' +
      '<div class="field"><label for="sHold">Hold time (minutes)</label><input class="input" id="sHold" type="number" min="1" max="60" step="1" value="' + s.holdMinutes + '"><span class="hint">Orders with no SMS after this are refunded.</span></div>' +
      '<div class="field"><label for="sWel">Welcome credit (\u20a6)</label><input class="input" id="sWel" type="number" min="0" max="1000000" step="100" value="' + (s.welcomeCreditCents / 100) + '"><span class="hint">Given to each new account. Keep at 0 for a live site.</span></div>' +
      '</div><div><button class="btn primary" type="button" id="saveSettings">Save settings</button></div></div>';
  }

  var TABS = { overview: overview, orders: ordersTab, catalog: catalogTab, settings: settingsTab, customers: customers };
  async function render() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) { b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"); });
    try { await TABS[tab](); } catch (e) {
      if (e.status === 401 || e.status === 403) { location.href = "/?login=admin"; return; }
      $("body").innerHTML = '<div class="notice bad">' + esc(e.message) + "</div>";
    }
  }
  async function act(fn, ok, after) {
    try { await fn(); if (ok) H.toast(ok); await (after || render)(); } catch (e) { H.toast(e.message); render(); }
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("button"); if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; return render(); }
    if (t.id === "logout") { api("POST", "/api/auth/logout").catch(function () {}).then(function () { location.href = "/"; }); return; }
    if (t.dataset.refund) return act(function () { return api("POST", "/api/admin/orders/" + t.dataset.refund + "/refund"); }, "Refunded");
    if (t.dataset.credit) return act(function () { return api("POST", "/api/admin/users/" + t.dataset.credit + "/credit", { amountCents: Number(t.dataset.amt) }); }, "Balance updated");
    if (t.dataset.disable) return act(function () { return api("POST", "/api/admin/users/" + t.dataset.disable + "/disable", { disabled: t.dataset.to === "1" }); }, "Account updated");
    if (t.dataset.delsvc) return act(function () { return api("DELETE", "/api/admin/services/" + t.dataset.delsvc); }, "App removed");
    if (t.dataset.delcty) return act(function () { return api("DELETE", "/api/admin/countries/" + t.dataset.delcty); }, "Country removed");
    if (t.id === "addSvc") return act(function () { return api("POST", "/api/admin/services", { name: $("nsName").value, base_cents: Math.round(parseFloat($("nsPrice").value)) * 100 }); }, "App added");
    if (t.id === "addCty") return act(function () {
      var name = $("ncName").value, iso = $("ncIso").value || name.slice(0, 2);
      return api("POST", "/api/admin/countries", { name: name, iso: iso, dial: $("ncDial").value, mult: parseFloat($("ncMult").value) });
    }, "Country added");
    if (t.id === "saveSettings") return act(function () {
      return api("PUT", "/api/admin/settings", { banner: $("sBanner").value, maintenance: $("sMaint").checked, signupsOpen: $("sSignups").checked, holdMinutes: parseInt($("sHold").value, 10), welcomeCreditCents: Math.round(parseFloat($("sWel").value || "0") * 100) });
    }, "Settings saved", function () {});
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "ofilter") { ofilter = t.value; return render(); }
    if (t.id === "sMaint" || t.id === "sSignups") return; // saved with the Save button
    var kind = t.dataset.svc ? "services/" + t.dataset.svc : t.dataset.cty ? "countries/" + t.dataset.cty : null;
    if (!kind) return;
    var f = t.dataset.f, v = t.type === "checkbox" ? t.checked : t.value;
    if (f === "base_cents") v = Math.round(parseFloat(v)) * 100;
    else if (f === "mult") v = parseFloat(v);
    var body = {}; body[f] = v;
    act(function () { return api("PATCH", "/api/admin/" + kind, body); }, "Saved", function () {});
  });

  render();
})();
