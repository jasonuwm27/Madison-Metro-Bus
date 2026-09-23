/**
 * Madison Metro reliability — client.
 *
 * No framework, no build step. The whole app is this file plus one stylesheet,
 * so first paint on a phone is a single round trip. The reader is standing at a
 * bus stop, possibly on a bad connection, and wants an answer in seconds.
 *
 * Data contract (written by scripts/export-site.ts):
 *   /data/index.json        dataset summary + every stop, for the picker
 *   /data/stops/<id>.json   one stop, all (route, hour, day_type) cells
 *
 * Thresholds and confidence labels are decided at export time, never here, so
 * the page and the exporter can never disagree about what counts as enough
 * data.
 */

const DAY_LABEL = { 0: "Weekdays", 1: "Saturday", 2: "Sunday" };
const LATE_THRESHOLD_MIN = 4;

// Live pulse: the one part of this static site that is actually live. See
// workers/live-status/README.md for why a Worker exists at all and how its
// free-tier budget holds up. Empty string means the pulse silently doesn't
// render -- same "absence disables the feature" pattern as the server-side
// healthcheck config.
const LIVE_STATUS_URL = "https://bus-live-status.live-status.workers.dev";
const LIVE_POLL_MS = 30_000; // matches the real collector's TripUpdates cadence

const $ = (sel) => document.querySelector(sel);
const view = $("#view");

let INDEX = null;

/* ------------------------------------------------------------------ utils */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * "215K+" style rounding for the trust-signal line -- mirrors
 * scripts/export-site.ts's compactCount exactly, since the SSR skeleton and
 * this client render must show the same number in the same format or the
 * page visibly changes shape the instant index.json loads. Always floors,
 * never rounds up, so the figure shown is never an overstatement.
 */
function compactCount(n) {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 1000)}K+`;
}

/**
 * The one error banner shared by every fetch failure that leaves a page
 * with nothing else to show (the index.json bootstrap, a stop fetch, a
 * route fetch). One wording everywhere means a visitor who sees this twice
 * recognises it as "the site's standard failure state", not a different
 * broken thing each time. Distinct from the "not enough data" empty states
 * below -- this is for when the FETCH itself failed, not when it succeeded
 * and simply found too little to show.
 */
function errorBannerHtml(backHref) {
  return `
    <div class="error-banner" role="alert">
      <p>Having trouble loading data. Try refreshing, or check back in a few minutes.</p>
      ${backHref ? `<p><a href="${esc(backHref)}" class="small">← Back</a></p>` : ""}
    </div>`;
}

/**
 * "This exists but there isn't enough collected yet" -- distinct from a
 * fetch failure. Shared wording (and shared threshold framing: "a few more
 * days") across stop and route pages so the two never phrase the same
 * concept two different ways.
 */
function insufficientDataHtml(kind) {
  return `<div class="card"><p class="muted">Not enough data for this ${kind} yet — check back after a few more days of collection.</p></div>`;
}

/**
 * Plain-language "what does late mean" note, shown next to every on-time
 * percentage on the site. Built from LATE_THRESHOLD_MIN rather than a
 * hard-coded "5 minutes" -- the constant IS the definition, so the two can
 * never drift out of sync the way a separately-written sentence could.
 *
 * A <details> disclosure, not a hover tooltip: hover doesn't exist on
 * touch, and this site is built for someone reading it on a phone at a bus
 * stop, same reasoning as every other progressive-disclosure control here
 * ("See the numbers", "See all hours").
 */
function onTimeDefHtml() {
  return `
    <details class="ontime-def">
      <summary>What counts as "late"?</summary>
      <p>Late means the bus arrived ${LATE_THRESHOLD_MIN}+ minutes after its scheduled time. Anything closer than that counts as on time.</p>
    </details>`;
}

/** Seconds → a phrase a student reads without decoding. */
function delayPhrase(sec) {
  const m = sec / 60;
  if (Math.abs(m) < 0.75) return { text: "about on time", cls: "ontime" };
  if (m > 0) return { text: `${m.toFixed(1)} min late`, cls: "late" };
  return { text: `${Math.abs(m).toFixed(1)} min early`, cls: "early" };
}

/**
 * The plain-English explanation of why a range is shown.
 *
 * Written for a student, not a statistician: no "confidence interval", no
 * "sample size", no "p". The number of times we've actually seen the bus is
 * the intuition that does the work.
 */
function uncertaintyNote(n) {
  if (n < 5)
    return `We've only seen this bus ${n} time${n === 1 ? "" : "s"} so far, so this is a rough estimate — the real figure is somewhere in the shaded range.`;
  if (n < 20)
    return `Based on ${n} arrivals. Still a small sample, so treat the shaded range as the honest answer rather than the single number.`;
  return `Based on ${n} arrivals. The shaded range narrows as we collect more.`;
}

/* -------------------------------------------------------- the range bar */

/**
 * Wilson interval as a visual band.
 *
 * The whole point is that a wide interval LOOKS wide without reading numbers.
 * The track spans the domain, the shaded band is the plausible range, and the
 * tick marks the observed figure. At n=3 the band covers most of the track,
 * which communicates "we don't really know yet" instantly.
 */
function rangeBar({ lo, hi, point, min, max, fmt }) {
  const span = max - min || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / span) * 100));
  const left = pct(lo);
  const width = Math.max(1.5, pct(hi) - left);
  return `
    <div class="range">
      <div class="track" role="img"
           aria-label="Plausible range ${fmt(lo)} to ${fmt(hi)}, best estimate ${fmt(point)}">
        <div class="band" style="left:${left}%;width:${width}%"></div>
        <div class="tick" style="left:calc(${pct(point)}% - 1.5px)"></div>
      </div>
      <div class="scale"><span>${fmt(min)}</span><span>${fmt(max)}</span></div>
    </div>`;
}

/* ------------------------------------------------------------- rendering */

/**
 * Dataset growth chart -- observations recorded per service day.
 *
 * Deliberately NOT labeled "live": the site exports once daily, so a live
 * label would be a false claim on data that's already up to a day old.
 * Framed instead as growth, which is what it actually shows and is also the
 * most compelling fact about the project -- nobody else has this history, and
 * every day the line gets longer is a day of history nobody else can produce.
 */
function growthChartSvg(series) {
  const W = 640, H = 160, padL = 4, padR = 4, padT = 10, padB = 22;
  // Never return an empty string here -- an empty SVG area under a caption
  // reads as a broken chart, not as "no data yet". Say so instead.
  if (series.length === 0) return `<p class="small muted">Not enough data yet to chart growth.</p>`;
  const max = Math.max(...series.map((d) => d.n), 1);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (n) => padT + innerH - (n / max) * innerH;
  const line = series.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.n).toFixed(1)}`).join(" ");
  const area = `${line} L${x(series.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`;
  const first = series[0], last = series[series.length - 1];
  const firstLabel = first.date ? new Date(first.date + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const lastLabel = last.date ? new Date(last.date + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return `
    <svg class="growth-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Observations recorded per day, ${series.length} days, rising from ${first.n} to ${last.n}">
      <path d="${area}" fill="var(--band)" opacity="0.5"></path>
      <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
      <text x="${padL}" y="${H - 6}" font-size="11" fill="var(--muted)">${esc(firstLabel)}</text>
      <text x="${W - padR}" y="${H - 6}" font-size="11" fill="var(--muted)" text-anchor="end">${esc(lastLabel)}</text>
    </svg>`;
}

/**
 * Trust-signal line under the subtitle: scale, start date, cadence -- in
 * place of a raw "240,113 arrivals recorded" counter, which reads as a
 * log-file number rather than a claim about how much data backs the site.
 * "Updated nightly" is the real cadence (bus-deploy.timer, 05:15 CT); this
 * line exists specifically to set accurate expectations, so it must never
 * itself overclaim freshness the way the old title implied.
 */
function trustLineHtml(d, growth) {
  if (!d.firstServiceDate) return "";
  const totalN = (growth || []).reduce((t, g) => t + g.n, 0) || d.totalObservations;
  const since = new Date(d.firstServiceDate + "T12:00:00Z").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
  return `<p class="trust-line">Built from ${compactCount(totalN)} arrivals · Collecting since ${esc(since)} · Updated nightly</p>`;
}

/**
 * System snapshot: one day's system-wide on-time rate and its worst
 * routes, shown on the landing page below the search bar -- something to
 * look at before anyone has typed or tapped anything.
 *
 * date is NOT necessarily the most recent collected day -- export-site.ts
 * walks backward past any day below 85% coverage (a collection gap, known
 * or not-yet-diagnosed) so this never presents a bad-COLLECTION day as bad
 * BUS service. The date is always shown explicitly for that reason: this
 * is "this is what <date> looked like", not implicitly "today".
 */
function systemSnapshotHtml(snapshot) {
  if (!snapshot || !snapshot.date || snapshot.n === 0) return "";
  const dateLabel = new Date(snapshot.date + "T12:00:00Z").toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
  const onTimePct = Math.max(0, 100 - snapshot.pctLate);
  const worstRows = snapshot.worstRoutes.map((r) => `
    <li>
      <a class="snapshot-route-link" href="/route/${encodeURIComponent(r.id)}">
        <span>
          <span class="rn">Route ${esc(r.id)}</span>
          <span class="rn-sub">${esc(r.name || "")}</span>
        </span>
        <span class="rv late">${r.pctLate.toFixed(0)}% late</span>
      </a>
    </li>`).join("");
  return `
    <section class="section" aria-label="System snapshot">
      <h2>System snapshot</h2>
      <p class="small muted" style="margin-top:-4px">${esc(dateLabel)}, the most recent day with reliable collection.</p>
      <div class="card">
        <p class="headline">System-wide on-time rate: <span class="hi ${onTimePct >= 75 ? "ontime" : "late"}">${onTimePct.toFixed(0)}%</span></p>
        <p class="headline-sub">${snapshot.n.toLocaleString()} arrivals recorded that day</p>
        ${snapshot.worstRoutes.length ? `
          <p class="lbl" style="margin-top:14px">Worst-performing routes that day</p>
          <ul class="rank-list snapshot-worst">${worstRows}</ul>` : ""}
        ${onTimeDefHtml()}
      </div>
    </section>`;
}

function growthSectionHtml(d, growth) {
  const totalN = (growth || []).reduce((t, g) => t + g.n, 0) || d.totalObservations;
  return `
    <section class="section" aria-label="Dataset growth">
      <h2>Dataset</h2>
      <div class="growth-card">
        <p class="growth-claim">Nobody else keeps this history — it did not exist before this site started collecting.</p>
        <p class="growth-sub">${totalN.toLocaleString()} arrivals recorded across ${d.serviceDays} service day${d.serviceDays === 1 ? "" : "s"}, every 30 seconds, archived from Madison Metro's public feed.</p>
        ${growthChartSvg(growth || [])}
        <p class="growth-caption">Observations per day · dataset grows nightly, not live</p>
      </div>
    </section>`;
}

/**
 * Data completeness: coverage by day, with known collection gaps annotated.
 *
 * Framed as a feature, not an apology -- an agency-side feed outage the
 * archive can PROVE happened (not just suspect) is exactly what an
 * independent archive is for. Reliability figures elsewhere on the site
 * already exclude these flagged days server-side (see
 * build_stop_route_hour_stats in sql/004_stats.sql), so a bad-collection
 * day never quietly reads as bad service -- this section is what makes
 * that exclusion visible and explained, not just silently applied.
 */
function dataCompletenessHtml(dayCoverage) {
  if (!dayCoverage || dayCoverage.length === 0) return "";
  const rows = dayCoverage.map((d) => {
    const pct = d.coveragePct;
    const flagged = d.knownGapReason !== null;
    // Unflagged-but-low is a real signal worth a visually distinct state --
    // it means something happened that hasn't been diagnosed yet, which is
    // different from "explained" (flagged) and different from "normal".
    const cls = flagged ? "gap-known" : pct < 85 ? "gap-unexplained" : "gap-none";
    const label = new Date(d.date + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `
      <div class="cov-row ${cls}">
        <span class="cov-date">${esc(label)}</span>
        <div class="cov-bar-track"><div class="cov-bar-fill" style="width:${Math.max(2, pct)}%"></div></div>
        <span class="cov-pct">${pct.toFixed(0)}%</span>
        ${flagged ? `<p class="cov-reason">${esc(d.knownGapReason)}</p>` : cls === "gap-unexplained" ? `<p class="cov-reason muted">Low coverage, not yet diagnosed.</p>` : ""}
      </div>`;
  }).join("");
  return `
    <section class="section" aria-label="Data completeness">
      <h2>Data completeness</h2>
      <p class="small muted" style="margin-top:-4px">
        How much of the scheduled service this archive actually captured, per day. Reliability figures elsewhere
        on this site exclude days with a known collection gap, so a bad day here never reads as a bad bus.
      </p>
      <div class="coverage-list">${rows}</div>
    </section>`;
}

function bannerHtml(d) {
  const since = new Date(d.firstServiceDate + "T12:00:00Z").toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric",
  });
  const generated = `Data updated ${new Date(d.generatedAt || Date.now()).toLocaleString()}.`;
  const stats = [
    [d.totalObservations.toLocaleString(), "arrivals recorded"],
    [d.serviceDays.toLocaleString(), d.serviceDays === 1 ? "service day" : "service days"],
    [d.stopsWithData.toLocaleString(), "stops covered"],
    [d.routesWithData.toLocaleString(), "routes"],
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
  return `
    <section class="banner" aria-label="About this dataset">
      <div class="small muted"><strong>Collecting since ${esc(since)}.</strong> Every 30 seconds, continuously.</div>
      <div class="stat-row">${stats}</div>
    </section>
    <p class="tiny muted">${esc(generated)}</p>`;
}

/* ------------------------------------------------------------- live pulse */

/**
 * "Is this actually running right now" -- the one live element on an
 * otherwise static, once-nightly site. See workers/live-status/README.md.
 *
 * Deliberately not a dashboard widget: no numbers-in-boxes. A thin animated
 * waveform plus one line of text is meant to read as a pulse, not a stat.
 * Silently absent when LIVE_STATUS_URL is unset or unreachable -- this is
 * cosmetic, and a broken or missing pulse must never look like an error.
 */
function pulseHtml() {
  // 24 bars is arbitrary but plentiful enough that the CSS animation (which
  // staggers each bar's phase) reads as a continuous wave rather than a
  // handful of blinking segments.
  const bars = Array.from({ length: 24 }, (_, i) => `<span class="pbar" style="--i:${i}"></span>`).join("");
  return `
    <div class="pulse" id="pulse" aria-live="polite">
      <div class="pulse-wave" aria-hidden="true">${bars}</div>
      <p class="pulse-text muted tiny" id="pulseText">Connecting to the live collector…</p>
    </div>`;
}

/** Human "updated Ns ago", recomputed client-side so it visibly counts up. */
function agoLabel(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function startPulse() {
  const el = $("#pulse");
  if (!el || !LIVE_STATUS_URL) { el?.remove(); return; }
  let last = null; // last successfully fetched status, for the ticking clock

  function paintText() {
    const t = $("#pulseText");
    if (!t) return;
    if (last === null) return;
    if (!last.available) { t.textContent = "Collector status unavailable."; return; }
    t.textContent =
      `${last.busesTracked} bus${last.busesTracked === 1 ? "" : "es"} tracked right now · ` +
      `${last.rowsLastPoll.toLocaleString()} arrivals in the last poll · updated ${agoLabel(Date.parse(last.lastPollAt))}`;
  }

  async function fetchStatus() {
    try {
      const r = await fetch(LIVE_STATUS_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      last = await r.json();
      el.classList.toggle("stale", !last.available);
    } catch {
      // A missed fetch (offline, Worker briefly down) leaves the last known
      // status on screen rather than blanking it -- a stale pulse still reads
      // as "was alive recently", which is more honest than flashing an error
      // for what is very likely a transient network blip.
      el.classList.add("stale");
    }
    paintText();
  }

  fetchStatus();
  const dataTimer = setInterval(fetchStatus, LIVE_POLL_MS);
  const clockTimer = setInterval(paintText, 5_000);
  // Cleared on the next SPA navigation so a background timer from the home
  // screen doesn't keep firing (and re-querying a removed #pulseText) after
  // the visitor has moved to a stop or route page.
  pulseCleanup = () => { clearInterval(dataTimer); clearInterval(clockTimer); };
}

let pulseCleanup = null;

/* --------------------------------------------------------- recent stops */

// localStorage, no accounts: most people check the same one or two stops
// repeatedly, and the site should learn that without asking anyone to sign
// in for it. Capped at 5 and de-duplicated on write so the list stays a
// short, genuinely "recent" set rather than an ever-growing history.
const RECENT_KEY = "bus:recentStops";
const RECENT_MAX = 5;

function getRecentStopIds() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    // Private browsing, quota exceeded, or a previous version wrote
    // malformed JSON -- treat as "no history" rather than breaking the page.
    return [];
  }
}

function recordRecentStop(id) {
  try {
    const ids = getRecentStopIds().filter((x) => x !== id);
    ids.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
  } catch {
    // Storage can fail (quota, private mode); losing "recent stops" is
    // cosmetic, never worth surfacing an error for.
  }
}

function recentStopsHtml() {
  const ids = getRecentStopIds();
  const byId = new Map(INDEX.stops.map((s) => [s.id, s]));
  const stops = ids.map((id) => byId.get(id)).filter(Boolean);
  if (stops.length === 0) return "";
  return `
    <div class="recent">
      <h2>Recent</h2>
      <ul class="stops">${stops.map(stopRow).join("")}</ul>
    </div>`;
}

/* ------------------------------------------------------------ home screen */

function renderHome() {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }

  // The one-tap case: someone standing at a stop, phone in hand, wants their
  // stop and nothing else. Geolocation is the biggest, first thing on the
  // page -- not one option among several -- because for that reader it IS
  // the whole interaction. Recent stops sit right below it: for a repeat
  // visitor "the same stop as yesterday" beats even geolocation, since it
  // works indoors and needs no permission prompt.
  //
  // The combined search box sits directly under the subtitle, ABOVE the
  // geolocation button: it's the fastest path for anyone who already knows
  // what they're looking for (a route number or a stop name) and don't want
  // to wait on a location prompt or scan a grid. Auto-focused so typing
  // works immediately on desktop; harmless on mobile, where focus doesn't
  // pop the keyboard without a user gesture anyway.
  view.innerHTML = `
    <div class="hero">
      <span class="disclaimer-pill">Not affiliated with the City of Madison</span>
      <h1>Is my bus late?</h1>
      <p class="lede">Historical on-time performance for every Madison Metro route and stop — not a live tracker.</p>
      ${trustLineHtml(INDEX.dataset, INDEX.growth)}
      ${pulseHtml()}

      <div class="omnisearch">
        <input type="search" id="omniq" class="omniq" autofocus
               placeholder="Search by route number or stop name…" autocomplete="off"
               enterkeyhint="search" aria-label="Search by route number or stop name">
        <ul class="stops" id="omniResults"></ul>
      </div>

      <div class="pill-row" id="quickRoutes" aria-label="Common routes"></div>

      <button class="locate-btn" id="near"><span class="ic">📍</span> Stops near me</button>
      <p class="tiny muted" id="geostatus" style="margin:10px 0 0;min-height:16px"></p>
    </div>

    <div id="nearResults"></div>

    ${systemSnapshotHtml(INDEX.systemSnapshot)}

    ${recentStopsHtml()}

    <div class="section">
      <h2>By route</h2>
      <p class="small muted" style="margin-top:-4px">Know your bus number? Tap it.</p>
      <div class="route-grid" id="routeGrid"></div>
      <button class="btn link-btn" id="moreRoutes" style="margin-top:2px">All routes</button>
    </div>

    <div class="section">
      <h2>By stop name</h2>
      <input type="search" id="q" placeholder="Stop name, e.g. Union South" autocomplete="off"
             enterkeyhint="search" aria-label="Search stops by name">
      <ul class="stops" id="results"></ul>
      <button class="btn link-btn" id="moreStops" style="margin-top:2px">All stops</button>
    </div>

    ${growthSectionHtml(INDEX.dataset, INDEX.growth)}
    ${dataCompletenessHtml(INDEX.dayCoverage)}
    ${bannerHtml({ ...INDEX.dataset, generatedAt: INDEX.generatedAt })}`;

  // Route tiles: a fixed-size grid of the busiest usable routes, equal
  // visual weight to stop search rather than tucked behind a secondary tab.
  // "All routes" reaches the rest -- most riders take one of a handful of
  // routes regularly, so the grid covers the common case at a glance.
  const routes = (INDEX.routes || []).filter((r) => r.usable).sort((a, b) => b.n - a.n);
  $("#routeGrid").innerHTML = routes.slice(0, 12).map(routeTile).join("");
  $("#moreRoutes").addEventListener("click", () => renderAllRoutes());
  $("#moreStops").addEventListener("click", () => renderAllStops());

  // Quick-select pills: the 5 busiest routes, one tap straight to the route
  // page. Same "usable" + busiest-first ordering as the grid below, just a
  // shorter slice, so the two never suggest a different "top route".
  $("#quickRoutes").innerHTML = routes.slice(0, 5).map(routePill).join("");

  $("#near").addEventListener("click", () => locate("#nearResults", "#geostatus"));
  $("#q").addEventListener("input", (e) => search(e.target.value));
  $("#omniq").addEventListener("input", (e) => omniSearch(e.target.value));

  startPulse();
}

/** One quick-select pill under the search box -- a route number, tappable. */
function routePill(r) {
  return `<a class="pill-btn" href="/route/${encodeURIComponent(r.id)}">Route ${esc(r.id)}</a>`;
}

/**
 * Combined route + stop search for the omnisearch box.
 *
 * Routes are matched first and shown first: someone typing "80" wants
 * Route 80, not the 25 stops that happen to have "80" in an address.
 * Numeric-looking queries in particular are almost always a route number.
 */
function omniSearch(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const el = $("#omniResults");
  if (!el) return;
  if (q.length < 1) { el.innerHTML = ""; return; }

  const routeHits = (INDEX.routes || [])
    .filter((r) => (r.id + " " + (r.name || "")).toLowerCase().includes(q))
    .sort((a, b) => (b.usable - a.usable) || b.n - a.n)
    .slice(0, 5);

  let stopHits = [];
  if (q.length >= 2) {
    const terms = q.split(/\s+/);
    stopHits = INDEX.stops
      .filter((s) => {
        const hay = (s.name + " " + (s.headsigns || []).join(" ") + " " + s.routes.join(" ")).toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => (b.usable - a.usable) || b.n - a.n)
      .slice(0, 8);
  }

  if (routeHits.length === 0 && stopHits.length === 0) {
    el.innerHTML = `<li class="small muted">No routes or stops match “${esc(qRaw)}”.</li>`;
    return;
  }
  el.innerHTML = routeHits.map(routeRow).join("") + stopHits.map(stopRow).join("");
}

/** One route tile in the landing-screen grid -- a route number, tappable. */
function routeTile(r) {
  return `<a class="route-tile" href="/route/${encodeURIComponent(r.id)}">${esc(r.id)}</a>`;
}

/** Full route list, reached via "All routes" -- the fallback, not the default. */
function renderAllRoutes() {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }
  const readyRoutes = (INDEX.routes || []).filter((r) => r.usable).length;
  view.innerHTML = `
    <p><a href="/" class="small">← Back</a></p>
    <h2 style="margin-top:10px">All routes</h2>
    <p class="small muted">${readyRoutes.toLocaleString()} of ${(INDEX.routes || []).length.toLocaleString()} routes have enough arrivals to show a figure.</p>
    <input type="search" id="rq" placeholder="Route number, e.g. 80" autocomplete="off"
           enterkeyhint="search" aria-label="Search routes by number or name">
    <ul class="stops" id="routeList"></ul>`;
  $("#rq").addEventListener("input", (e) => searchRoutes(e.target.value));
  $("#routeList").innerHTML = (INDEX.routes || [])
    .slice().sort((a, b) => (b.usable - a.usable) || b.n - a.n)
    .map(routeRow).join("");
}

/** Full stop list, reached via "All stops" -- the fallback, not the default. */
function renderAllStops() {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }
  const ready = INDEX.stops.filter((s) => s.usable).length;
  view.innerHTML = `
    <p><a href="/" class="small">← Back</a></p>
    <h2 style="margin-top:10px">All stops</h2>
    <p class="small muted">
      ${ready.toLocaleString()} of ${INDEX.stops.length.toLocaleString()} stops have enough
      arrivals to show a figure. The rest are still collecting.
    </p>
    <input type="search" id="q2" placeholder="Stop name, e.g. Union South" autocomplete="off"
           enterkeyhint="search" aria-label="Search stops by name">
    <ul class="stops" id="results2"></ul>`;
  $("#q2").addEventListener("input", (e) => search(e.target.value, "#results2"));
  const top = INDEX.stops.filter((s) => s.usable).sort((a, b) => b.n - a.n).slice(0, 40);
  $("#results2").innerHTML = top.map(stopRow).join("");
}

/** One row in the route picker. */
function routeRow(r) {
  const badge = r.usable
    ? `<span class="pill">${r.n} arrivals</span>`
    : `<span class="pill wait">collecting</span>`;
  return `<li><a class="stop" href="/route/${encodeURIComponent(r.id)}" data-route-link="${esc(r.id)}">
      <span class="nm">Route ${esc(r.id)}${badge}</span>
      <span class="sub">${esc(r.name || "")}</span>
    </a></li>`;
}

function searchRoutes(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const el = $("#routeResults");
  if (!el) return;
  if (q.length < 1) { el.innerHTML = ""; return; }
  const hits = (INDEX.routes || [])
    .filter((r) => (r.id + " " + (r.name || "")).toLowerCase().includes(q))
    .sort((a, b) => (b.usable - a.usable) || b.n - a.n)
    .slice(0, 20);
  el.innerHTML = hits.length ? hits.map(routeRow).join("") : `<li class="small muted">No routes match “${esc(qRaw)}”.</li>`;
}

/** One row in any stop list. Headsigns disambiguate directional pairs. */
function stopRow(s) {
  const where = s.headsigns && s.headsigns.length ? `towards ${s.headsigns.slice(0, 2).join(", ")}` : "";
  const badge = s.usable
    ? `<span class="pill">${s.n} arrivals</span>`
    : `<span class="pill wait">collecting</span>`;
  return `<li><a class="stop" href="/stop/${encodeURIComponent(s.id)}" data-id="${esc(s.id)}">
      <span class="nm">${esc(s.name)}${badge}</span>
      <span class="sub">${esc(where)}${where && s.routes.length ? " · " : ""}${
        s.routes.length ? "Routes " + esc(s.routes.join(", ")) : ""
      }${s._km !== undefined ? ` · ${s._km.toFixed(1)} km away` : ""}</span>
    </a></li>`;
}

function search(qRaw, targetSel = "#results") {
  const q = qRaw.trim().toLowerCase();
  const el = $(targetSel);
  if (!el) return;
  if (q.length < 2) { el.innerHTML = ""; return; }
  // Token matching, not prefix: stop names are compound ("University at
  // University Bay"), so "bay" must find it.
  const terms = q.split(/\s+/);
  const hits = INDEX.stops
    .filter((s) => {
      const hay = (s.name + " " + (s.headsigns || []).join(" ") + " " + s.routes.join(" ")).toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (b.usable - a.usable) || b.n - a.n)
    .slice(0, 25);
  el.innerHTML = hits.length ? hits.map(stopRow).join("") : `<li class="small muted">No stops match “${esc(qRaw)}”.</li>`;
}

/**
 * "Stops near me" -- the whole interaction for the primary use case (someone
 * standing at a stop, phone in hand). resultsSel/statusSel let this be
 * called from the home screen; there's currently only one caller, but
 * keeping it parameterised avoids hard-coding #results/#geostatus twice.
 */
function locate(resultsSel, statusSel) {
  const status = $(statusSel);
  const results = $(resultsSel);
  if (!navigator.geolocation) { status.textContent = "This browser can't share your location."; return; }
  status.innerHTML = `<span class="spinner"></span> Finding your location…`;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const { latitude: la, longitude: lo } = coords;
      const near = INDEX.stops
        .filter((s) => s.lat != null && s.lon != null)
        .map((s) => {
          // Equirectangular approximation: at city scale the error is metres,
          // and it avoids trigonometry on 1,464 stops for every tap.
          const x = (s.lon - lo) * Math.cos(((la + s.lat) / 2) * Math.PI / 180);
          const y = s.lat - la;
          return { ...s, _km: Math.sqrt(x * x + y * y) * 111.32 };
        })
        .sort((a, b) => a._km - b._km)
        .slice(0, 10);
      status.textContent = near.length ? `Nearest stops to you:` : `No stops found nearby.`;
      results.innerHTML = `<ul class="stops">${near.map(stopRow).join("")}</ul>`;
      results.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    (err) => {
      status.textContent =
        err.code === 1
          ? "Location permission denied — search by name instead."
          : "Couldn't get your location — search by name instead.";
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  );
}

/* ------------------------------------------------------------ stop detail */

// Named windows of hours, checked in order. "Right now" is computed from the
// visitor's local clock so the very first thing they see needs no thought.
// Rush windows are approximate on purpose -- a student doesn't think in exact
// hour boundaries, they think "morning" and "evening".
const PRESETS = [
  { id: "now", label: "Right now", hours: null }, // hours resolved per-render
  { id: "morning", label: "Morning rush", hours: [7, 8, 9] },
  { id: "evening", label: "Evening rush", hours: [16, 17, 18] },
];

function presetHours(preset) {
  if (preset.id === "now") return [new Date().getHours()];
  return preset.hours;
}

/** Aggregate several hour-cells (same route+day) into one combined figure. */
function combineCells(cells) {
  if (cells.length === 0) return null;
  if (cells.length === 1) return cells[0];
  const n = cells.reduce((s, c) => s + c.n, 0);
  if (n === 0) return { ...cells[0], n: 0 };
  const nLate = cells.reduce((s, c) => s + c.nLate, 0);
  const mean = cells.reduce((s, c) => s + c.mean * c.n, 0) / n;
  // Wilson interval recomputed over the pooled n/nLate, same formula the
  // exporter uses, so a combined preset window is held to the same honesty
  // standard as a single hour rather than approximated.
  const z = 1.96, p = nLate / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const sd = cells.reduce((s, c) => s + (c.sd ?? 0) * (c.sd ?? 0) * Math.max(c.n - 1, 0), 0);
  const days = Math.max(...cells.map((c) => c.days ?? 0));
  return {
    r: cells[0].r, d: cells[0].d, h: cells[0].h,
    n, nLate, mean,
    sd: n > cells.length ? Math.sqrt(sd / (n - cells.length)) : (cells[0].sd ?? 0),
    pctLate: p * 100, pctLateLo: Math.max(0, center - half) * 100, pctLateHi: Math.min(1, center + half) * 100,
    days, confidence: n >= 20 ? "good" : n >= 5 ? "ok" : "sparse", fallback: null,
  };
}

async function renderStop(id) {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }
  view.innerHTML = `<p class="muted"><span class="spinner"></span> Loading stop…</p>`;
  let data;
  try {
    const r = await fetch(`/data/stops/${encodeURIComponent(id)}.json`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    view.innerHTML = errorBannerHtml("/");
    return;
  }
  recordRecentStop(id);

  // A stop that exists in the export but hasn't collected enough arrivals
  // yet -- distinct from a fetch failure above. Checked BEFORE building
  // route/day state off data.routes/data.cells, which can legitimately be
  // empty here; without this check that state construction (routes[0],
  // etc.) would proceed against empty arrays and the page below would
  // render broken rather than explain why there's nothing to show.
  if (!data.hasUsableData) {
    view.innerHTML = `
      <p><a href="/" class="small">← All stops</a></p>
      <h2 style="margin-top:6px">${esc(data.stop.name)}</h2>
      ${insufficientDataHtml("stop")}`;
    return;
  }

  // Only offer day types that actually exist in the data. A Saturday tab that
  // can only ever say "no data" is worse than no tab.
  const present = INDEX.dataset.dayTypesPresent || [0];
  const routes = data.routes;
  const state = { route: routes[0], day: present[0], preset: "now", hour: null };

  const head = `
    <p><a href="/" class="small">← All stops</a></p>
    <h2 style="margin-top:6px">${esc(data.stop.name)}</h2>
    <p class="small muted">${
      data.stop.headsigns?.length ? "Towards " + esc(data.stop.headsigns.slice(0, 3).join(", ")) : ""
    }</p>`;

  function paint() {
    const cells = data.cells.filter((c) => c.r === state.route && c.d === state.day);
    const byHour = new Map(cells.map((c) => [c.h, c]));

    const routeTabs = routes.map((r) =>
      `<button class="tab" role="tab" aria-selected="${r === state.route}" data-route="${esc(r)}">Route ${esc(r)}</button>`).join("");
    const dayTabs = present.map((d) =>
      `<button class="tab" role="tab" aria-selected="${d === state.day}" data-day="${d}">${DAY_LABEL[d]}</button>`).join("");

    // Preset cards: each shows its own one-line answer inline, so choosing a
    // window IS seeing a result -- no extra tap to reveal it.
    const presetCards = PRESETS.map((p) => {
      const hrs = presetHours(p);
      const combined = combineCells(hrs.map((h) => byHour.get(h)).filter(Boolean));
      const wl = combined && combined.n > 0 ? delayPhrase(combined.mean) : null;
      return `<button class="preset" role="tab" aria-selected="${state.preset === p.id}" data-preset="${p.id}">
        <span><span class="pn">${esc(p.label)}</span><span class="pw">${esc(presetWindowLabel(p, hrs))}</span></span>
        <span class="pv ${wl ? wl.cls : ""}">${wl ? esc(wl.text) : combined ? "no data" : "collecting"}</span>
      </button>`;
    }).join("");

    const hourBtns = Array.from({ length: 24 }, (_, h) => {
      const c = byHour.get(h);
      const label = h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
      return `<button class="hr ${c ? "" : "none"}" role="tab" aria-selected="${state.preset === "hour" && h === state.hour}"
        ${c ? "" : "disabled"} data-hour="${h}">${label}<span class="n">${c ? c.n : "–"}</span></button>`;
    }).join("");

    let activeCell;
    if (state.preset === "hour") {
      activeCell = state.hour === null ? null : byHour.get(state.hour) ?? null;
    } else {
      const p = PRESETS.find((p) => p.id === state.preset);
      activeCell = combineCells(presetHours(p).map((h) => byHour.get(h)).filter(Boolean));
    }

    view.innerHTML = `${head}
      <div class="tabs" role="tablist" aria-label="Route">${routeTabs}</div>
      ${present.length > 1 ? `<div class="tabs" role="tablist" aria-label="Day">${dayTabs}</div>` : ""}

      <div class="presets" role="tablist" aria-label="Time window">${presetCards}</div>
      <div id="detail"></div>

      <details class="grid-toggle" id="gridToggle">
        <summary>See all hours</summary>
        <div class="hours" role="tablist" aria-label="Hour">${hourBtns}</div>
      </details>`;

    $("#detail").innerHTML = activeCell === null || activeCell.n === 0
      ? `<div class="card"><p class="muted">No arrivals recorded for this window yet.</p></div>`
      : cellCard(activeCell, state);

    view.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => { state.preset = b.dataset.preset; paint(); }));

    view.querySelectorAll("[data-route]").forEach((b) =>
      b.addEventListener("click", () => { state.route = b.dataset.route; state.hour = null; state.preset = "now"; paint(); }));
    view.querySelectorAll("[data-day]").forEach((b) =>
      b.addEventListener("click", () => { state.day = Number(b.dataset.day); state.hour = null; state.preset = "now"; paint(); }));
    view.querySelectorAll("[data-hour]").forEach((b) =>
      b.addEventListener("click", () => { state.hour = Number(b.dataset.hour); state.preset = "hour"; paint(); }));

    // Keep the grid open across a repaint if the reader opened it -- closing
    // it out from under them on every tap would defeat the point of showing it.
    if (state._gridOpen) $("#gridToggle").open = true;
    $("#gridToggle").addEventListener("toggle", (e) => { state._gridOpen = e.target.open; });
  }
  paint();
}

/** Human label for a preset's underlying hour window. */
function presetWindowLabel(p, hrs) {
  if (p.id === "now") return hourLabel(hrs[0]);
  return `${hourLabel(Math.min(...hrs))}–${hourLabel(Math.max(...hrs) + 1)}`;
}

function hourLabel(h) {
  return h === 0 ? "midnight" : h < 12 ? `${h}am` : h === 12 ? "noon" : `${h - 12}pm`;
}

function cellCard(c, state) {
  const when = `${hourLabel(c.h)}, ${DAY_LABEL[state.day].toLowerCase()}`;

  // A sparse cell falls back to a wider window. The scope MUST be stated: an
  // all-day figure must never be mistaken for an 8am figure.
  const fb = c.confidence === "sparse" ? c.fallback : null;
  const usingFallback = fb !== null && fb !== undefined;

  const n = usingFallback ? fb.n : c.n;
  const pct = usingFallback ? fb.pctLate : c.pctLate;
  const lo = usingFallback ? fb.pctLateLo : c.pctLateLo;
  const hi = usingFallback ? fb.pctLateHi : c.pctLateHi;
  const mean = usingFallback ? fb.mean : c.mean;

  // Mean interval: standard error of the mean, same 95% convention as Wilson.
  // Shown because "usually 2 min late" is what someone at the stop wants,
  // while the percentage tells them whether to leave a buffer.
  const se = c.n > 1 && c.sd ? c.sd / Math.sqrt(c.n) : 0;
  const mLo = mean - 1.96 * se, mHi = mean + 1.96 * se;
  const phrase = delayPhrase(mean);

  let scopeNote = "";
  if (usingFallback) {
    const hrs = fb.hours;
    const span =
      fb.scope === "band"
        ? `${hourLabel(Math.min(...hrs))}–${hourLabel((Math.max(...hrs) + 1) % 24)}`
        : "the whole day";
    // Stating the substituted window is not optional: an all-day figure that
    // looked like an 8am figure would be actively misleading, which is worse
    // than showing nothing.
    scopeNote = `<div class="scope">Too few arrivals at ${hourLabel(c.h)} alone — showing ${esc(span)} instead</div>`;
  }

  const domainMax = Math.max(240, Math.ceil(Math.max(Math.abs(mHi), Math.abs(mLo)) / 60) * 60);

  // The headline is the answer, read as a sentence -- everything else on the
  // card is supporting evidence for someone who wants it, not the first thing
  // a reader has to parse. "The 80 usually runs 2 min late here."
  const headline = `The ${esc(c.r)} usually runs <span class="hi ${phrase.cls}">${esc(phrase.text)}</span> here.`;
  const headlineSub = `${esc(when)} · ${pct.toFixed(0)}% of arrivals are ${LATE_THRESHOLD_MIN}+ min late`;

  return `
    <div class="card">
      <h3>Route ${esc(c.r)}</h3>
      ${scopeNote}

      <p class="headline">${headline}</p>
      <p class="headline-sub">${headlineSub}</p>

      <details class="more">
        <summary>See the numbers</summary>

        <div class="metric">
          <div class="lbl">Typically runs</div>
          <div class="val ${phrase.cls}">${esc(phrase.text)}</div>
          ${rangeBar({
            lo: mLo, hi: mHi, point: mean,
            min: -domainMax, max: domainMax,
            fmt: (v) => `${(v / 60).toFixed(1)}m`,
          })}
        </div>

        <div class="metric">
          <div class="lbl">How often is it ${LATE_THRESHOLD_MIN}+ minutes late?</div>
          <div class="val ${pct >= 25 ? "late" : "ontime"}">${pct.toFixed(0)}% of the time</div>
          ${rangeBar({
            lo, hi, point: pct, min: 0, max: 100,
            fmt: (v) => `${Math.round(v)}%`,
          })}
        </div>

        <div class="counts">
          ${n} arrival${n === 1 ? "" : "s"} recorded · ${
            usingFallback ? fb.nLate : c.nLate
          } were ${LATE_THRESHOLD_MIN}+ min late${
            c.days ? ` · over ${c.days} service day${c.days === 1 ? "" : "s"}` : ""
          }
        </div>

        <div class="note">${esc(uncertaintyNote(n))}</div>
        ${onTimeDefHtml()}
      </details>
    </div>`;
}

/* ----------------------------------------------------------------- route detail */

/**
 * Delay profile along the line -- one point per stop, in schedule order.
 * This is the shape the user specifically asked to see: does lateness
 * accumulate toward the end of the route? A rising line answers "yes, catch
 * this bus early in its run if you can."
 *
 * Stops with no data (n=0, mean=null) are plotted as gaps, not zeros -- a
 * missing observation is not the same as "on time", and drawing it as 0
 * would understate the delay trend right where data happens to be thin.
 *
 * INTERACTION: tap-to-select with a persistent label, not a hover tooltip.
 * Hover doesn't exist on touch, and most visitors here are on a phone at a
 * bus stop -- a tooltip that vanishes the instant a finger lifts is useless
 * to them. Each dot is a real <button> (keyboard- and screen-reader
 * reachable, unlike a bare SVG circle) with a touch target padded well past
 * its visible radius. Desktop pointer users get hover as a bonus preview via
 * plain CSS (:hover), never as the only way to see a value.
 */
function profileSvg(stops, headsign) {
  const W = Math.max(640, stops.length * 14), H = 170, padL = 8, padR = 8, padT = 12, padB = 14;
  const withData = stops.filter((s) => s.mean !== null);
  if (withData.length < 2) return { html: `<p class="small muted">Not enough data yet to chart this direction.</p>`, bind: () => {} };
  const maxAbs = Math.max(60, ...withData.map((s) => Math.abs(s.mean)));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (stops.length === 1 ? innerW / 2 : (i / (stops.length - 1)) * innerW);
  const y = (mean) => padT + innerH / 2 - (mean / maxAbs) * (innerH / 2);

  // Break the line at gaps (consecutive stops both need data to connect).
  let d = "";
  let drawing = false;
  stops.forEach((s, i) => {
    if (s.mean === null) { drawing = false; return; }
    d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(s.mean).toFixed(1)} `;
    drawing = true;
  });

  const zeroY = y(0).toFixed(1);

  // foreignObject hosts real <button> elements inside the SVG so each dot is
  // a proper focusable, tappable control rather than a shape with a click
  // listener bolted on -- screen readers and keyboard nav get it for free.
  const dots = stops
    .map((s, i) => {
      if (s.mean === null) return "";
      const cx = x(i), cy = y(s.mean);
      return `
        <g class="pdot-g" data-idx="${i}">
          <circle class="pdot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5"></circle>
          <foreignObject x="${(cx - 11).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="22" height="22">
            <button class="pdot-hit" data-idx="${i}" aria-label="${esc(s.name || s.id)}, stop ${i + 1} of ${stops.length}, ${esc(delayPhrase(s.mean).text)}"></button>
          </foreignObject>
        </g>`;
    })
    .join("");

  const html = `
    <div class="profile-wrap">
      <svg class="profile-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" id="profileSvg"
           aria-label="Average delay by stop position along the route, ${withData.length} stops with data">
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="var(--line)" stroke-width="1"></line>
        <path d="${d.trim()}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
        ${dots}
      </svg>
    </div>
    <p class="profile-note">Tap a stop for detail. Left to right is schedule order; the line is on time, above is late, below is early.</p>
    <div id="profileDetail" class="profile-detail"></div>`;

  function detailHtml(i) {
    const s = stops[i];
    if (s.mean === null) return `<p class="small muted">No data yet for ${esc(s.name || s.id)}.</p>`;
    const phrase = delayPhrase(s.mean);
    const lo = delayPhrase(s.meanLo).text, hi = delayPhrase(s.meanHi).text;
    return `
      <div class="card profile-card">
        <h3>Stop ${i + 1} of ${stops.length}${headsign ? ` · towards ${esc(headsign)}` : ""}</h3>
        <p class="headline">${esc(s.name || s.id)}</p>
        <p class="headline-sub">Usually <span class="hi ${phrase.cls}">${esc(phrase.text)}</span> here (95% range: ${esc(lo)} to ${esc(hi)})</p>
        <p class="counts">${s.n.toLocaleString()} arrival${s.n === 1 ? "" : "s"} recorded at this position</p>
      </div>`;
  }

  function bind() {
    const svg = $("#profileSvg");
    const detail = $("#profileDetail");
    if (!svg || !detail) return;
    svg.querySelectorAll(".pdot-hit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.idx);
        svg.querySelectorAll(".pdot-g").forEach((g) => g.classList.toggle("selected", Number(g.dataset.idx) === i));
        detail.innerHTML = detailHtml(i);
      });
    });
  }

  return { html, bind };
}

/**
 * One row in the best/worst stops ranking.
 *
 * Position along the route is shown alongside delay because delay genuinely
 * accumulates down a route (see the profile chart) -- so "3rd worst stop" at
 * position 80 of 85 is expected and not very interesting, while the same
 * rank at position 12 of 85 is a real anomaly. The "worse than expected"
 * badge is exactly that second case, computed at export time (see
 * export-site.ts) as a stop sitting well above the route's own delay-vs-
 * position trend line, not an arbitrary fixed cutoff.
 */
function rankRow(s, cls) {
  const pos = s.seq !== null ? `Stop ${s.seq} of ${s.seqOf}` : "Position unknown";
  const flag = s.flagged ? `<span class="flag-badge">worse than expected here</span>` : "";
  return `
    <li>
      <span>
        <span class="rn">${esc(s.name)}</span>
        <span class="rn-sub">${esc(pos)} · ${s.n.toLocaleString()} arrivals${flag}</span>
      </span>
      <span class="rv ${cls}">${s.pctLate.toFixed(0)}% late</span>
    </li>`;
}

async function renderRoute(id) {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }
  view.innerHTML = `<p class="muted"><span class="spinner"></span> Loading route…</p>`;
  let data;
  try {
    const r = await fetch(`/data/routes/${encodeURIComponent(id)}.json`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    view.innerHTML = errorBannerHtml("/");
    return;
  }

  if (!data.hasUsableData) {
    view.innerHTML = `
      <p><a href="/" class="small">← All routes</a></p>
      <h2 style="margin-top:6px">Route ${esc(data.route.id)}</h2>
      <p class="muted">${esc(data.route.name || "")}</p>
      ${insufficientDataHtml("route")}`;
    return;
  }

  const present = INDEX.dataset.dayTypesPresent || [0];
  const state = { day: present[0], dir: data.profile[0] ? data.profile[0].direction : 0 };

  const overallPhrase = delayPhrase(data.mean);

  function paint() {
    const dayTabs = present.map((d) =>
      `<button class="tab" role="tab" aria-selected="${d === state.day}" data-day="${d}">${DAY_LABEL[d]}</button>`).join("");
    const dirEntry = data.profile.find((p) => p.direction === state.dir) || data.profile[0];
    const dirTabs = data.profile.length > 1
      ? `<div class="tabs dir-tabs" role="tablist" aria-label="Direction">${data.profile.map((p) =>
          `<button class="tab" role="tab" aria-selected="${p.direction === state.dir}" data-dir="${p.direction}">Direction ${p.direction === 0 ? "A" : "B"}</button>`).join("")}</div>`
      : "";

    const profile = dirEntry ? profileSvg(dirEntry.stops, dirEntry.headsign) : { html: "", bind: () => {} };

    const hourRows = data.hours.filter((h) => h.d === state.day).sort((a, b) => a.h - b.h);
    // "% late" labeled inline on every bar, not just implied by a bare
    // number -- someone landing straight on this grid (from a bookmark,
    // say) never sees the headline sentence above that spells it out.
    const byHourBars = hourRows.length
      ? `<div class="hours">${hourRows.map((h) => `
          <div class="hr" style="cursor:default" aria-selected="false">
            ${h.h === 0 ? "12a" : h.h < 12 ? h.h + "a" : h.h === 12 ? "12p" : (h.h - 12) + "p"}
            <span class="n">${h.pctLate.toFixed(0)}% late</span>
          </div>`).join("")}</div>`
      : `<p class="small muted">No hourly breakdown yet for ${DAY_LABEL[state.day].toLowerCase()}.</p>`;

    view.innerHTML = `
      <p><a href="/" class="small">← All routes</a></p>
      <div class="route-head">
        <h2 style="margin-top:6px">Route ${esc(data.route.id)}</h2>
        <p class="muted small">${esc(data.route.name || "")}</p>
        <p class="headline">Route ${esc(data.route.id)} usually runs <span class="hi ${overallPhrase.cls}">${esc(overallPhrase.text)}</span>, across all stops.</p>
        <p class="headline-sub">${data.pctLate.toFixed(0)}% of arrivals are ${LATE_THRESHOLD_MIN}+ min late · ${data.n.toLocaleString()} arrivals recorded</p>
      </div>

      ${present.length > 1 ? `<div class="tabs" role="tablist" aria-label="Day">${dayTabs}</div>` : ""}

      <h2 style="margin-top:24px">Delay along the route</h2>
      ${dirTabs}
      ${profile.html}

      <div class="two-col">
        <div>
          <h2>Best stops</h2>
          <p class="tiny muted" style="margin:-4px 0 8px">20+ arrivals recorded</p>
          <ul class="rank-list">${data.best.map((s) => rankRow(s, "ontime")).join("")}</ul>
        </div>
        <div>
          <h2>Worst stops</h2>
          <p class="tiny muted" style="margin:-4px 0 8px">20+ arrivals recorded</p>
          <ul class="rank-list">${data.worst.map((s) => rankRow(s, "late")).join("")}</ul>
        </div>
      </div>

      <h2 style="margin-top:24px">By time of day, ${esc(DAY_LABEL[state.day].toLowerCase())}</h2>
      ${byHourBars}

      ${onTimeDefHtml()}`;

    view.querySelectorAll("[data-day]").forEach((b) =>
      b.addEventListener("click", () => { state.day = Number(b.dataset.day); paint(); }));
    view.querySelectorAll("[data-dir]").forEach((b) =>
      b.addEventListener("click", () => { state.dir = Number(b.dataset.dir); paint(); }));
    profile.bind();
  }
  paint();
}

/* ------------------------------------------------------------------ about */

/**
 * "How this works" -- data source, collection method, update frequency, in
 * plain language. No jargon like "GTFS-realtime" here or anywhere else in
 * the UI (it stays in code comments and the README); this page exists
 * specifically so someone can understand what they're looking at without
 * knowing transit-data terminology.
 */
function renderAbout() {
  if (pulseCleanup) { pulseCleanup(); pulseCleanup = null; }
  const d = INDEX.dataset;
  const since = d.firstServiceDate
    ? new Date(d.firstServiceDate + "T12:00:00Z").toLocaleDateString(undefined, {
        month: "long", day: "numeric", year: "numeric",
      })
    : null;
  view.innerHTML = `
    <p><a href="/" class="small">← Back</a></p>
    <h2 style="margin-top:10px">How this works</h2>

    <div class="card">
      <h3>Where the data comes from</h3>
      <p>Madison Metro publishes a live feed of where its buses actually are and when they're
      actually expected to arrive at each stop. This site checks that feed every 30 seconds,
      around the clock, and keeps a permanent record of what it saw.</p>
    </div>

    <div class="card">
      <h3>How "late" is measured</h3>
      <p>Every scheduled arrival time comes from Metro's published timetable. Every actual
      arrival time comes from that live feed. The difference between the two is the delay --
      compared against the ${LATE_THRESHOLD_MIN}-minute threshold used everywhere on this site
      to call an arrival "late".</p>
    </div>

    <div class="card">
      <h3>How often this updates</h3>
      <p>Collection runs continuously, but the numbers on this site are rebuilt and published
      once every night. So this is never a live tracker of where a bus is right now --
      it's a historical record of how a route or stop has actually performed, built from
      real arrivals rather than the schedule alone.</p>
    </div>

    ${d.firstServiceDate ? `
    <div class="card">
      <h3>How much history exists</h3>
      <p>Collection began on ${esc(since)}. Nobody published this data before that date, and
      nobody else keeps an ongoing archive of it -- once a day passes, Metro's live feed moves
      on and that day's predictions are gone unless something recorded them first.</p>
    </div>` : ""}

    ${dataCompletenessHtml(INDEX.dayCoverage)}`;
}

/* ----------------------------------------------------------------- router */

function route() {
  const stopMatch = location.pathname.match(/^\/stop\/([^/]+)/);
  const routeMatch = location.pathname.match(/^\/route\/([^/]+)/);
  if (stopMatch) renderStop(decodeURIComponent(stopMatch[1]));
  else if (routeMatch) renderRoute(decodeURIComponent(routeMatch[1]));
  // Trailing slash matters: Cloudflare Pages 308-redirects the bare /about
  // to / before _redirects is even evaluated (a platform quirk with
  // extensionless single-segment paths -- /about/ is unaffected). Matching
  // both here costs nothing and means a visitor who types the bare form
  // still lands on the right view rather than silently seeing the redirect
  // take them home.
  else if (location.pathname === "/about" || location.pathname === "/about/") renderAbout();
  else renderHome();
}

// Intercepts every internal link (stop rows, route rows, "back to search")
// so navigation never costs a full page reload -- app.js and index.json stay
// in memory across a whole browsing session.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  e.preventDefault();
  history.pushState({}, "", href);
  route();
  window.scrollTo(0, 0);
});
window.addEventListener("popstate", route);

(async function start() {
  try {
    const r = await fetch("/data/index.json");
    if (!r.ok) throw new Error(String(r.status));
    INDEX = await r.json();
    route();
  } catch {
    // The one failure that can leave the ENTIRE app with nothing to render --
    // every other page (stop, route) at least has INDEX already loaded by
    // this point. A visible banner with a concrete next step, not a bare
    // sentence, since this is the "is the site actually broken" moment for
    // a visitor with no other page to fall back to.
    view.innerHTML = errorBannerHtml();
  }
})();
