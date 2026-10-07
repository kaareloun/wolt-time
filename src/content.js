(() => {
  const BADGE_ID = "wolt-time-compare";
  const POLL_MS = 5000;
  // PERF: tracking page mutates DOM constantly (map, countdowns) — never
  // tick more often than this, never overlap ticks, never re-render unchanged UI
  const TICK_MIN_MS = 4000;
  let ticking = false;
  let lastTickAt = 0;
  let lastRenderSig = null;

  const sel = (testId) =>
    document.querySelector(`[data-testid="${testId}"], [data-test-id="${testId}"]`);

  const selAll = (testId) =>
    document.querySelectorAll(`[data-testid="${testId}"], [data-test-id="${testId}"]`);

  const selAllPrefix = (prefix) =>
    document.querySelectorAll(`[data-testid^="${prefix}"], [data-test-id^="${prefix}"]`);

  const getOrderId = () => {
    const path = location.pathname;
    let m = path.match(/group-order\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    m = path.match(/order-tracking-v2\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    m = path.match(/tracking-v2\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    // Fallback: long hex-ish id anywhere in path (group ids look like 84e9dad4907e567eb1c872d2)
    m = path.match(/([a-f0-9]{16,})/i);
    if (m) return m[1];
    return null;
  };

  const isTrackingPage = () => location.pathname.includes("tracking");

  const getCircleBox = () => sel("order-tracking-v2.circle.status");

  // Wolt shows ranges like "22-32" — use lower bound consistently.
  const parseLeadingMinutes = (text) => {
    if (!text) return null;
    const m = String(text).match(/(\d+)(?:\s*[–-]\s*\d+)?\s*(?:min|minute)/i);
    if (m) return Number.parseInt(m[1], 10);
    const n = Number.parseInt(String(text).trim(), 10);
    return Number.isFinite(n) ? n : null;
  };

  const getLiveMinutes = () => {
    const box = getCircleBox();
    if (box) {
      const numEl = box.querySelector(".b17jf9b8");
      if (numEl) {
        const n = parseLeadingMinutes(numEl.textContent);
        if (Number.isFinite(n)) return n;
      }
      const n = parseLeadingMinutes(box.textContent);
      if (Number.isFinite(n)) return n;
    }
    // Fallback: any "NN min left / NN minutes" text on page
    const bodyHit = document.body?.textContent?.match(/(\d+)(?:\s*[–-]\s*\d+)?\s*minutes?\s+until/i);
    if (bodyHit) return Number.parseInt(bodyHit[1], 10);
    const titleN = parseLeadingMinutes(document.title);
    if (Number.isFinite(titleN)) return titleN;
    return null;
  };

  const getCircleLabel = () => {
    const box = getCircleBox();
    if (!box) return "";
    return box.textContent.toLowerCase();
  };

  const getInfoBox = () => sel("order-tracking-v2.summary.standard-delivery.information");

  const getStatusText = () => {
    const info = getInfoBox();
    const el = info?.querySelector(".fkqyrwa");
    return (el?.textContent || info?.textContent || "").toLowerCase();
  };

  const isDelivered = () => {
    if (document.title.toLowerCase().includes("order delivered")) return true;
    const status = getStatusText();
    if (status.includes("was delivered") || status.includes("order delivered")) return true;
    const box = getCircleBox();
    if (!box) return false;
    if (box.querySelector('img[data-testid*="delivered"], img[data-test-id*="delivered"], img[src*="delivered"]')) return true;
    return false;
  };

  const isBeingDelivered = (liveMinutes) => {
    const titleHit = document.title.toLowerCase().includes("being delivered");
    const statusText = getStatusText();
    const statusHit = statusText.includes("delivering your order now");
    const circleHit =
      getCircleLabel().includes("until delivery") && Number.isFinite(liveMinutes);
    // Group-order active states: "order sent", "waiting for venue", ETA clock visible
    const activeHit =
      statusText.includes("waiting for venue") ||
      statusText.includes("order sent") ||
      statusText.includes("estimated delivery") ||
      statusText.includes("preparing your order") ||
      document.title.toLowerCase().includes("order sent");
    return titleHit || statusHit || circleHit || activeHit;
  };

  const getEtaString = () => {
    // 1. Prefer dedicated ETA node in new UI
    const pageText = document.body?.textContent || "";
    let m = pageText.match(/estimated delivery(?: time)?:\s*([0-9]{1,2}:[0-9]{2})/i);
    if (m) return m[1];
    const info = getInfoBox();
    if (!info) return null;
    const text = info.textContent || "";
    m = text.match(/estimated delivery(?: time)?:\s*([0-9]{1,2}:[0-9]{2})/i);
    if (m) return m[1];
    const fallback = text.match(/arrives latest by\s*(.+)/i);
    if (fallback) return fallback[1].trim();
    return null;
  };

  const getVenue = () => {
    const info = getInfoBox();
    const el = info?.querySelector(".vf9c8ov");
    if (!el) return null;
    return el.textContent.trim();
  };

  const keyFor = (orderId) => `wolt-time:${orderId}`;

  const loadRecord = async (orderId) => {
    const key = keyFor(orderId);
    const out = await chrome.storage.local.get(key);
    return out[key] || null;
  };

  const saveRecord = async (orderId, record) => {
    await chrome.storage.local.set({ [keyFor(orderId)]: record });
  };

  const findAnchor = () => getInfoBox() || getCircleBox()?.parentElement;

  const removeBadgeIfStale = (anchor) => {
    const existing = document.getElementById(BADGE_ID);
    if (existing && (!anchor || !anchor.isConnected)) existing.remove();
  };

  // HIST: new row only when the ETA clock changes — minutes ticking down is not news
  const pushHistory = (record, liveMinutes, eta) => {
    if (!Number.isFinite(liveMinutes)) return false;
    if (!Array.isArray(record.history)) record.history = [];
    const now = Date.now();
    const last = record.history[record.history.length - 1];
    if (!last) {
      record.history.push({ t: now, m: liveMinutes, eta: eta || null });
      return true;
    }
    const prevEta = last.eta || null;
    const curEta = eta || null;
    if (prevEta !== null && curEta !== null) {
      if (prevEta === curEta) return false;
    } else if (prevEta === curEta && last.m === liveMinutes) {
      return false;
    }
    record.history.push({ t: now, m: liveMinutes, eta: curEta });
    if (record.history.length > 200) record.history = record.history.slice(-200);
    return true;
  };

  const ensureHistory = (record) => {
    if (!Array.isArray(record.history)) record.history = [];
    if (record.history.length > 0) return;
    if (Number.isFinite(record.originalMinutes))
      record.history.push({ t: record.firstSeenAt, m: record.originalMinutes, eta: record.etaFirst || null });
    if (Number.isFinite(record.lastMinutes) && record.lastMinutes !== record.originalMinutes)
      record.history.push({ t: record.lastSeenAt || record.firstSeenAt, m: record.lastMinutes, eta: record.lastEta || null });
  };

  // HIST: delta is total-from-start, based on the ETA clock the user sees.
  // ETA "12:49" vs baseline "12:44" => (+5). Matches visible clock math.
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
  // Fallback when ETA clock is missing/unparseable: implied total
  // (minutes-left + elapsed) vs first row, rounded.
  const impliedOf = (record, h) => h.m + (h.t - record.firstSeenAt) / 60000;
  const totalDelta = (record, first, baselineEta, cur) => {
    const ed = baselineEta ? etaTotalDelta(baselineEta, cur.eta) : null;
    if (ed != null) return ed;
    if (!first || !Number.isFinite(first.m) || !Number.isFinite(cur.m)) return null;
    return Math.round(impliedOf(record, cur) - impliedOf(record, first));
  };

  const clearBadge = (badge) => {
    badge.innerHTML = "";
  };

  const ensureBadge = (anchor) => {
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      anchor.insertAdjacentElement("afterend", badge);
    }
    return badge;
  };

  // HIST: history only, newest first, list scrolls after 10 rows (see CSS)
  const buildHistory = (badge, record, delivered) => {
    ensureHistory(record);
    const hist = record.history;
    if (!hist.length) return;
    const wrap = document.createElement("div");
    wrap.className = "wt-hist";
    const title = document.createElement("div");
    title.className = "wt-hist-t";
    title.textContent = delivered ? `Estimate history (${hist.length})` : `History (${hist.length})`;
    wrap.appendChild(title);
    const list = document.createElement("div");
    list.className = "wt-hist-list";
    // Drop consecutive rows that repeat the same ETA clock
    const shown = hist.filter((h, i) => i === 0 || !h.eta || h.eta !== hist[i - 1].eta);
    // BASELINE: measure everything from the very first estimate. Only use an ETA clock
    // when the FIRST row has one; otherwise the countdown is the baseline (picking a
    // later row's ETA would make deltas look like "diff from prev").
    const baselineEta = parseEtaMinutes(shown[0]?.eta) != null ? shown[0].eta : null;
    if (delivered) {
      const deliveredTs = record.deliveredAt || Date.now();
      // delivered row: final drift, same basis as the list — ETA clock if the start had
      // one, else actual time from the first row minus the first countdown
      let dd = baselineEta ? etaTotalDelta(baselineEta, clockOf(deliveredTs)) : null;
      if (dd == null && shown[0] && Number.isFinite(shown[0].m))
        dd = Math.round((deliveredTs - shown[0].t) / 60000 - shown[0].m);
      let delta = "";
      if (dd != null) delta = dd > 0 ? ` (+${dd})` : ` (${dd})`;
      const row = document.createElement("div");
      row.className = "wt-hist-row wt-hist-done";
      const dot = document.createElement("span");
      dot.className = "wt-hist-dot";
      row.appendChild(dot);
      const txt = document.createElement("span");
      txt.textContent = `${new Date(deliveredTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · delivered${delta}`;
      row.appendChild(txt);
      list.appendChild(row);
    }
    for (let ci = shown.length - 1; ci >= 0; ci--) {
      const h = shown[ci];
      const row = document.createElement("div");
      row.className = "wt-hist-row";
      const dot = document.createElement("span");
      dot.className = "wt-hist-dot";
      row.appendChild(dot);
      const txt = document.createElement("span");
      const time = new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      let delta = "";
      // Total from start, measured against the first row's estimate
      const d = totalDelta(record, shown[0], baselineEta, h);
      if (d != null && d !== 0) delta = d > 0 ? ` (+${d})` : ` (${d})`;
      txt.textContent = `${time} · ${h.m} min left${h.eta ? ` · ETA ${h.eta}` : ""}${delta}`;
      row.appendChild(txt);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    badge.appendChild(wrap);
  };

  const histSig = (record, delivered) => {
    const h = Array.isArray(record.history) ? record.history : [];
    const last = h[h.length - 1];
    return `${record.orderId}|${delivered ? "done" : "live"}|${h.length}|${last ? `${last.t}/${last.m}/${last.eta}` : "-"}`;
  };

  const renderDelivered = (anchor, record) => {
    const sig = histSig(record, true);
    if (sig === lastRenderSig && document.getElementById(BADGE_ID)?.isConnected) return;
    lastRenderSig = sig;
    const badge = ensureBadge(anchor);
    clearBadge(badge);
    buildHistory(badge, record, true);
  };

  const render = (anchor, record) => {
    const sig = histSig(record, false);
    if (sig === lastRenderSig && document.getElementById(BADGE_ID)?.isConnected) return;
    lastRenderSig = sig;
    const badge = ensureBadge(anchor);
    clearBadge(badge);
    buildHistory(badge, record, false);
  };

  const tick = async () => {
    if (ticking) return;
    const now = Date.now();
    if (now - lastTickAt < TICK_MIN_MS) return;
    ticking = true;
    lastTickAt = now;
    try {
      await tickInner();
    } finally {
      ticking = false;
    }
  };

  const tickInner = async () => {
    if (!isTrackingPage()) {
      document.getElementById(BADGE_ID)?.remove();
      return;
    }
    const orderId = getOrderId();
    if (!orderId) return;
    const anchor = findAnchor();
    if (!anchor) return;
    if (isDelivered()) {
      const venue = getVenue();
      let record = await loadRecord(orderId);
      if (!record) {
        record = {
          orderId,
          originalMinutes: null,
          firstSeenAt: Date.now(),
          deliveredAt: Date.now(),
          etaFirst: null,
          venue,
          lastMinutes: 0,
          lastEta: null,
          lastSeenAt: Date.now(),
          manuallySet: false,
          history: [],
        };
        await saveRecord(orderId, record);
      } else if (!record.deliveredAt || (!record.venue && venue)) {
        if (!record.deliveredAt) record.deliveredAt = Date.now();
        if (!record.venue && venue) record.venue = venue;
        await saveRecord(orderId, record);
      }
      removeBadgeIfStale(anchor);
      renderDelivered(anchor, record);
      return;
    }
    const liveMinutes = getLiveMinutes();
    if (!isBeingDelivered(liveMinutes)) {
      removeBadgeIfStale(anchor);
      return;
    }
    if (!Number.isFinite(liveMinutes)) return;
    const eta = getEtaString();
    const venue = getVenue();
    let record = await loadRecord(orderId);
    if (!record) {
      record = {
        orderId,
        originalMinutes: liveMinutes,
        firstSeenAt: Date.now(),
        etaFirst: eta,
        venue,
        lastMinutes: liveMinutes,
        lastEta: eta,
        lastSeenAt: Date.now(),
        manuallySet: false,
        history: [{ t: Date.now(), m: liveMinutes, eta: eta || null }],
      };
      await saveRecord(orderId, record);
    } else {
      ensureHistory(record);
      const newEta = eta || record.lastEta;
      const changed =
        record.lastMinutes !== liveMinutes ||
        (record.lastEta || null) !== (newEta || null) ||
        (!record.venue && venue);
      record.lastMinutes = liveMinutes;
      record.lastEta = newEta;
      if (!record.venue && venue) record.venue = venue;
      const rowAdded = pushHistory(record, liveMinutes, record.lastEta);
      if (changed || rowAdded) await saveRecord(orderId, record);
    }
    removeBadgeIfStale(anchor);
    render(anchor, record, liveMinutes);
  };

  // SPLIT: order-receipt modal — what each person owes
  // own items + an even share of delivery / service fees / discounts
  const SPLIT_ID = "wolt-time-split";
  const SPLIT_THROTTLE_MS = 1000;
  let lastSplitSig = null;
  let splitPending = false;

  const toCents = (v) => (v == null ? null : Math.round(v * 100));

  const parseMoney = (text) => {
    if (text == null) return null;
    const s = String(text).replace(/\u2212/g, "-").replace(/\u00a0/g, " ").replace(/[^\d.,-]/g, "");
    if (!s) return null;
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    const dec = Math.max(lastDot, lastComma);
    if (dec === -1) {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : null;
    }
    const separators = (s.match(/[.,]/g) || []).length;
    if (s.length - dec - 1 === 3 && separators === 1) {
      const n = Number.parseInt(s.replace(/[.,]/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    }
    const intPart = s.slice(0, dec).replace(/[.,]/g, "");
    const frac = s.slice(dec + 1).replace(/[.,]/g, "");
    const n = Number.parseFloat(`${intPart}.${frac}`);
    return Number.isFinite(n) ? n : null;
  };

  const moneyFrom = (el) => {
    if (!el) return null;
    const target = el.querySelector('span[translate="no"]') || el;
    return parseMoney(target.textContent);
  };

  const getCurrency = () => {
    const m = (sel("TotalRowCheckoutTotal")?.textContent || "").match(/[€$£₹₺₪¥]|\bkr\b|Kč|zł|\b(CHF|SEK|NOK|DKK|USD|GBP|ILS|JPY)\b/i);
    return m ? m[0] : "€";
  };

  const getParticipants = () => {
    const lines = [...selAll("ParticipantNameLine")];
    const out = [];
    for (const line of lines) {
      const amountEl = line.querySelector('span[translate="no"]');
      const amount = moneyFrom(amountEl);
      if (amount == null) continue;
      let name = "";
      let isHost = false;
      for (const child of line.children) {
        if (child.tagName === "IMG") continue;
        if (child.contains(amountEl)) continue;
        const t = (child.textContent || "").trim();
        if (!t) continue;
        if (/^host$/i.test(t)) {
          isHost = true;
          continue;
        }
        if (!name) name = t;
      }
      out.push({ name: name || `Person ${out.length + 1}`, isHost, itemCents: toCents(amount) });
    }
    return out;
  };

  const getFeeLines = () => {
    const out = [];
    for (const delivery of selAll("RowWithSubItems-MainRow")) {
      if (!/deliver|toimitus|leverans|lieferung|dostaw|dostav/i.test(delivery.textContent || "")) continue;
      const cells = [...delivery.querySelectorAll("td")];
      const cents = toCents(moneyFrom(cells[cells.length - 1]));
      if (cents != null) out.push({ label: "Delivery", cents });
    }
    const serviceFee = sel("OrderDetailsWoltServiceFee");
    if (serviceFee) {
      const cents = toCents(moneyFrom(serviceFee));
      if (cents != null) out.push({ label: "Service fee", cents });
    }
    for (const discount of selAllPrefix("OrderDetailsWoltDiscount")) {
      const cents = toCents(moneyFrom(discount));
      if (cents != null) out.push({ label: "Discount", cents });
    }
    return out;
  };

  const computeSplit = () => {
    const participants = getParticipants();
    if (participants.length < 2) return null;
    const itemCents = participants.reduce((a, p) => a + p.itemCents, 0);
    const feeCents = getFeeLines().reduce((a, f) => a + f.cents, 0);
    const totalCents = toCents(moneyFrom(sel("TotalRowCheckoutTotal")));

    // When the receipt total is known it is authoritative: whatever is left after
    // everyone's own items (fees, discounts, unattributed shared items) is shared
    // evenly, so per-person totals always sum back to the real total. Fall back to
    // the fee lines only when the total row is missing.
    const sharedCents = totalCents != null ? totalCents - itemCents : feeCents;

    const n = participants.length;
    const base = Math.floor(sharedCents / n);
    const remainder = sharedCents - base * n;
    const people = participants.map((p, i) => ({
      name: p.name,
      isHost: p.isHost,
      itemCents: p.itemCents,
      feeCents: base + (i < remainder ? 1 : 0),
    }));
    return {
      people,
      itemCents,
      feeCents: sharedCents,
      totalCents: people.reduce((a, p) => a + p.itemCents + p.feeCents, 0),
      currency: getCurrency(),
    };
  };

  const formatMoney = (cents, currency) => {
    const sign = cents < 0 ? "-" : "";
    const value = (Math.abs(cents) / 100).toFixed(2);
    return /^[A-Za-z]/.test(currency) ? `${sign}${value} ${currency}` : `${sign}${currency}${value}`;
  };

  const splitSig = (split) =>
    `${split.currency}|${split.totalCents}|` +
    split.people.map((p) => `${p.name}:${p.itemCents}:${p.feeCents}`).join("|");

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  };

  const findSplitAnchor = () =>
    sel("OrderReceiptHostGroupItemsSection") || sel("order-receipt-container-element");

  const getVenueName = () =>
    (sel("order-receipt-container-element")?.querySelector("h2")?.textContent || "")
      .replace(/\*+$/g, "")
      .trim();

  const makeCopyButton = (className, defaultText, ariaLabel, getText) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = defaultText;
    btn.setAttribute("aria-label", ariaLabel);
    let resetTimer = null;
    btn.addEventListener("click", async () => {
      const ok = await copyToClipboard(getText());
      if (resetTimer) clearTimeout(resetTimer);
      btn.textContent = ok ? "✓" : "✕";
      btn.setAttribute("aria-label", ok ? `Copied: ${ariaLabel}` : `Copy failed: ${ariaLabel}`);
      resetTimer = setTimeout(() => {
        btn.textContent = defaultText;
        btn.setAttribute("aria-label", ariaLabel);
        resetTimer = null;
      }, 1200);
    });
    return btn;
  };

  const buildSplitPanel = (panel, split) => {
    panel.innerHTML = "";
    const head = document.createElement("div");
    head.className = "wt-split-head";
    const title = document.createElement("span");
    title.className = "wt-split-title";
    title.textContent = "Who owes what";
    const actions = document.createElement("div");
    actions.className = "wt-split-actions";
    actions.append(
      makeCopyButton("wt-split-btn", "Copy name", "Copy order name", getVenueName),
      makeCopyButton("wt-split-btn", "Copy total", "Copy total amount", () =>
        (split.totalCents / 100).toFixed(2),
      ),
    );
    head.append(title, actions);

    const list = document.createElement("div");
    list.className = "wt-split-list";
    for (const p of split.people) {
      const row = document.createElement("div");
      row.className = "wt-split-row";
      const name = document.createElement("span");
      name.className = "wt-split-name";
      name.textContent = p.name;
      if (p.isHost) {
        const tag = document.createElement("em");
        tag.className = "wt-split-host";
        tag.textContent = "Host";
        name.append(" ", tag);
      }
      const amount = document.createElement("span");
      amount.className = "wt-split-amount";
      amount.textContent = formatMoney(p.itemCents + p.feeCents, split.currency);
      row.append(
        name,
        amount,
        makeCopyButton("wt-split-copy-amount", "Copy", `Copy amount for ${p.name}`, () =>
          ((p.itemCents + p.feeCents) / 100).toFixed(2),
        ),
      );
      list.appendChild(row);
    }

    const summary = document.createElement("div");
    summary.className = "wt-split-summary";
    summary.textContent =
      `Items ${formatMoney(split.itemCents, split.currency)} · ` +
      `shared ${formatMoney(split.feeCents, split.currency)} · ` +
      `total ${formatMoney(split.totalCents, split.currency)}`;

    panel.append(head, list, summary);
  };

  const renderSplit = () => {
    const anchor = findSplitAnchor();
    if (!anchor) {
      document.getElementById(SPLIT_ID)?.remove();
      lastSplitSig = null;
      return;
    }
    const split = computeSplit();
    if (!split) {
      document.getElementById(SPLIT_ID)?.remove();
      lastSplitSig = null;
      return;
    }
    const sig = splitSig(split);
    let panel = document.getElementById(SPLIT_ID);
    if (sig === lastSplitSig && panel?.isConnected) return;
    if (!panel || !panel.isConnected) {
      panel = document.createElement("div");
      panel.id = SPLIT_ID;
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Who owes what");
      anchor.insertAdjacentElement("afterend", panel);
    } else if (panel.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement("afterend", panel);
    }
    buildSplitPanel(panel, split);
    lastSplitSig = sig;
  };

  const scheduleSplit = () => {
    if (splitPending) return;
    splitPending = true;
    setTimeout(() => {
      splitPending = false;
      renderSplit();
    }, SPLIT_THROTTLE_MS);
  };

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastRenderSig = null;
      lastSplitSig = null;
      document.getElementById(BADGE_ID)?.remove();
      document.getElementById(SPLIT_ID)?.remove();
    }
    tick().catch(() => undefined);
    renderSplit();
  }, POLL_MS);

  new MutationObserver(() => {
    tick().catch(() => undefined);
    scheduleSplit();
  }).observe(document.documentElement, { childList: true, subtree: true });

  tick().catch(() => undefined);
  renderSplit();
})();
