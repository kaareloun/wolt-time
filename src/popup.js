const orderLine = document.getElementById("orderLine");
const stats = document.getElementById("stats");
const fOriginal = document.getElementById("fOriginal");
const fLive = document.getElementById("fLive");
const fEta = document.getElementById("fEta");
const fDrift = document.getElementById("fDrift");
const histWrap = document.getElementById("histWrap");
const histEl = document.getElementById("hist");
const histTitle = document.getElementById("histTitle");

let orderId = null;
let recordKey = null;

const getOrderIdFromUrl = (url) => {
  if (!url) return null;
  let m = url.match(/group-order\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  m = url.match(/order-tracking-v2\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  m = url.match(/([a-f0-9]{16,})/i);
  return m ? m[1] : null;
};

const refresh = async () => {
  if (!recordKey) return;
  const out = await chrome.storage.local.get(recordKey);
  const record = out[recordKey];
  if (!record) {
    orderLine.textContent = `Order ${orderId}: waiting for Being delivered state…`;
    stats.hidden = true;
    return;
  }
  orderLine.textContent = `Order ${orderId}${record.venue ? ` · ${record.venue}` : ""}${record.deliveredAt ? " · delivered" : ""}`;
  stats.hidden = false;
  fOriginal.textContent = Number.isFinite(record.originalMinutes) ? `${record.originalMinutes} min` : "not captured";
  if (record.deliveredAt) {
    const total = (record.deliveredAt - record.firstSeenAt) / 60000;
    fLive.textContent = `delivered in ${total.toFixed(1)} min`;
    fEta.textContent = record.lastEta || record.etaFirst || "–";
    if (!Number.isFinite(record.originalMinutes)) {
      fDrift.textContent = "–";
    } else {
      const diff = total - record.originalMinutes;
      fDrift.textContent = `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} min`;
    }
  } else {
    fLive.textContent = `${record.lastMinutes ?? "?"} min left`;
    fEta.textContent = record.lastEta || record.etaFirst || "–";
    const elapsed = (Date.now() - record.firstSeenAt) / 60000;
    const drift = (record.lastMinutes ?? 0) - (record.originalMinutes - elapsed);
    fDrift.textContent = `${drift >= 0 ? "+" : ""}${drift.toFixed(1)} min`;
  }
  const parseEtaMinutes = (eta) => {
    if (!eta) return null;
    const m = String(eta).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
  };
  const etaTotalDelta = (baseEta, curEta) => {
    const b = parseEtaMinutes(baseEta);
    const c = parseEtaMinutes(curEta);
    if (b == null || c == null) return null;
    let d = c - b;
    if (d < -12 * 60) d += 24 * 60;
    else if (d > 12 * 60) d -= 24 * 60;
    return d;
  };
  // clockOf: delivered timestamp as "HH:MM" so it can be diffed against an ETA clock
  const clockOf = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const hist = Array.isArray(record.history) ? record.history : [];
  if (!hist.length) {
    histWrap.hidden = true;
    histEl.innerHTML = "";
  } else {
    histWrap.hidden = false;
    histTitle.textContent = `Estimate history (${hist.length})`;
    histEl.innerHTML = "";
    const implied = (h) => h.m + (h.t - record.firstSeenAt) / 60000;
    // Measure from the very first estimate: only use an ETA clock if the FIRST row has one
    const baselineEta = parseEtaMinutes(hist[0]?.eta) != null ? hist[0].eta : null;
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const row = document.createElement("div");
      row.className = "hist-row";
      const dot = document.createElement("span");
      dot.className = "hist-dot";
      row.appendChild(dot);
      const txt = document.createElement("span");
      const time = new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      let delta = "";
      let d = baselineEta ? etaTotalDelta(baselineEta, h.eta) : null;
      if (d == null && Number.isFinite(h.m) && Number.isFinite(hist[0]?.m)) {
        d = Math.round(implied(h) - implied(hist[0]));
      }
      if (d != null && d !== 0) delta = d > 0 ? ` (+${d})` : ` (${d})`;
      txt.textContent = `${time} · ${h.m} min${h.eta ? ` · ETA ${h.eta}` : ""}${delta}`;
      row.appendChild(txt);
      histEl.appendChild(row);
    }
    if (record.deliveredAt) {
      const row = document.createElement("div");
      row.className = "hist-row";
      const dot = document.createElement("span");
      dot.className = "hist-dot";
      dot.style.background = "#35c759";
      row.appendChild(dot);
      const txt = document.createElement("span");
      let ddelta = "";
      let dd = baselineEta ? etaTotalDelta(baselineEta, clockOf(record.deliveredAt)) : null;
      if (dd == null && Number.isFinite(hist[0]?.m))
        dd = Math.round((record.deliveredAt - hist[0].t) / 60000 - hist[0].m);
      if (dd != null) ddelta = dd > 0 ? ` (+${dd})` : ` (${dd})`;
      txt.textContent = `${new Date(record.deliveredAt).toLocaleTimeString()} · delivered${ddelta}`;
      row.appendChild(txt);
      histEl.appendChild(row);
    }
  }
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  orderId = getOrderIdFromUrl(tab?.url);
  if (!orderId) {
    orderLine.textContent = "Open a wolt.com order-tracking-v2 page first.";
    return;
  }
  recordKey = `wolt-time:${orderId}`;
  await refresh();
})();
