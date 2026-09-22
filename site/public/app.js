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

const $ = (sel) => document.querySelector(sel);
const view = $("#view");

let INDEX = null;

/* ------------------------------------------------------------------ utils */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

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
  if (series.length === 0) return "";
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

function renderHome() {
  const ready = INDEX.stops.filter((s) => s.usable).length;
  const readyRoutes = (INDEX.routes || []).filter((r) => r.usable).length;

  // Screen 1: answer "what is this / what do I do" in one glance, then one
  // clear choice -- route or stop -- as the primary action. Numbers are not
  // an action, so they move below the fold.
  view.innerHTML = `
    <div class="hero">
      <h1>Is my bus late?</h1>
      <p class="lede">See how often Madison Metro actually runs on time — by route or by stop.</p>

      <div class="entry">
        <button class="entry-btn" id="pickRoute">
          <span class="ic">🚌</span>
          <span class="et">By route</span>
          <span class="es">Know your bus number</span>
        </button>
        <button class="entry-btn" id="pickStop">
          <span class="ic">📍</span>
          <span class="et">By stop</span>
          <span class="es">Know where you'll wait</span>
        </button>
      </div>
    </div>

    <div id="picker"></div>

    ${growthSectionHtml(INDEX.dataset, INDEX.growth)}
    ${bannerHtml({ ...INDEX.dataset, generatedAt: INDEX.generatedAt })}`;

  const state = { mode: "route" };

  function paintPicker() {
    $("#picker").innerHTML = `
      <div class="seg" role="tablist" aria-label="Search by">
        <button role="tab" aria-selected="${state.mode === "route"}" data-mode="route">Routes</button>
        <button role="tab" aria-selected="${state.mode === "stop"}" data-mode="stop">Stops</button>
      </div>
      ${state.mode === "route" ? routePickerHtml(readyRoutes) : stopPickerHtml(ready)}`;

    $("#picker").querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => { state.mode = b.dataset.mode; paintPicker(); }));

    if (state.mode === "stop") {
      $("#near")?.addEventListener("click", locate);
      $("#q")?.addEventListener("input", (e) => search(e.target.value));
      const top = INDEX.stops.filter((s) => s.usable).sort((a, b) => b.n - a.n).slice(0, 8);
      $("#ready").innerHTML = top.map(stopRow).join("");
    } else {
      $("#rq")?.addEventListener("input", (e) => searchRoutes(e.target.value));
      $("#routeList").innerHTML = (INDEX.routes || [])
        .slice().sort((a, b) => (b.usable - a.usable) || b.n - a.n)
        .map(routeRow).join("");
    }
  }

  $("#pickRoute").addEventListener("click", () => { state.mode = "route"; paintPicker(); $("#picker").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("#pickStop").addEventListener("click", () => { state.mode = "stop"; paintPicker(); $("#picker").scrollIntoView({ behavior: "smooth", block: "start" }); });

  paintPicker();
}

function routePickerHtml(readyRoutes) {
  return `
    <h2>Search routes</h2>
    <input type="search" id="rq" placeholder="Route number, e.g. 80" autocomplete="off"
           enterkeyhint="search" aria-label="Search routes by number or name">
    <ul class="stops" id="routeResults"></ul>
    <h2 style="margin-top:20px">All routes</h2>
    <p class="small muted">${readyRoutes.toLocaleString()} of ${(INDEX.routes || []).length.toLocaleString()} routes have enough arrivals to show a figure.</p>
    <ul class="stops" id="routeList"></ul>`;
}

function stopPickerHtml() {
  return `
    <button class="locate-btn" id="near" style="margin-top:4px"><span class="ic">📍</span> Find my stop</button>
    <p class="tiny muted" id="geostatus" style="margin:10px 0 20px;min-height:16px"></p>

    <h2>Search stops</h2>
    <input type="search" id="q" placeholder="Stop name, e.g. Union South" autocomplete="off"
           enterkeyhint="search" aria-label="Search stops by name">
    <ul class="stops" id="results"></ul>

    <h2 style="margin-top:20px">Ready now</h2>
    <ul class="stops" id="ready"></ul>`;
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

function search(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const el = $("#results");
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

function locate() {
  const status = $("#geostatus");
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
      status.textContent = `Nearest stops to you:`;
      $("#results").innerHTML = near.map(stopRow).join("");
      $("#results").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  view.innerHTML = `<p class="muted"><span class="spinner"></span> Loading stop…</p>`;
  let data;
  try {
    const r = await fetch(`/data/stops/${encodeURIComponent(id)}.json`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    view.innerHTML = `<p>Couldn't load that stop. <a href="/">Back to search</a></p>`;
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
 */
function profileSvg(stops) {
  const W = Math.max(640, stops.length * 14), H = 170, padL = 8, padR = 8, padT = 12, padB = 14;
  const withData = stops.filter((s) => s.mean !== null);
  if (withData.length < 2) return `<p class="small muted">Not enough data yet to chart this direction.</p>`;
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
  const dots = stops
    .map((s, i) => (s.mean === null ? "" : `<circle cx="${x(i).toFixed(1)}" cy="${y(s.mean).toFixed(1)}" r="2.5" fill="var(--ink)"></circle>`))
    .join("");

  return `
    <div class="profile-wrap">
      <svg class="profile-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Average delay by stop position along the route, ${withData.length} stops with data">
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="var(--line)" stroke-width="1"></line>
        <path d="${d.trim()}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
        ${dots}
      </svg>
    </div>
    <p class="profile-note">Each dot is one stop, left to right in schedule order. The line is on time; above is late, below is early.</p>`;
}

async function renderRoute(id) {
  view.innerHTML = `<p class="muted"><span class="spinner"></span> Loading route…</p>`;
  let data;
  try {
    const r = await fetch(`/data/routes/${encodeURIComponent(id)}.json`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    view.innerHTML = `<p>Couldn't load that route. <a href="/">Back to search</a></p>`;
    return;
  }

  if (!data.hasUsableData) {
    view.innerHTML = `
      <p><a href="/" class="small">← All routes</a></p>
      <h2 style="margin-top:6px">Route ${esc(data.route.id)}</h2>
      <p class="muted">${esc(data.route.name || "")}</p>
      <div class="card"><p class="muted">Not enough arrivals recorded for this route yet. Most routes need about two weeks of collection.</p></div>`;
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

    const hourRows = data.hours.filter((h) => h.d === state.day).sort((a, b) => a.h - b.h);
    const byHourBars = hourRows.length
      ? `<div class="hours">${hourRows.map((h) => `
          <div class="hr" style="cursor:default" aria-selected="false">
            ${h.h === 0 ? "12a" : h.h < 12 ? h.h + "a" : h.h === 12 ? "12p" : (h.h - 12) + "p"}
            <span class="n">${h.pctLate.toFixed(0)}%</span>
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
      ${dirEntry ? profileSvg(dirEntry.stops) : ""}

      <div class="two-col">
        <div>
          <h2>Best stops</h2>
          <ul class="rank-list">${data.best.map((s) => `<li><span class="rn">${esc(s.name)}</span><span class="rv ontime">${s.pctLate.toFixed(0)}%</span></li>`).join("")}</ul>
        </div>
        <div>
          <h2>Worst stops</h2>
          <ul class="rank-list">${data.worst.map((s) => `<li><span class="rn">${esc(s.name)}</span><span class="rv late">${s.pctLate.toFixed(0)}%</span></li>`).join("")}</ul>
        </div>
      </div>

      <h2 style="margin-top:24px">By time of day, ${esc(DAY_LABEL[state.day].toLowerCase())}</h2>
      ${byHourBars}`;

    view.querySelectorAll("[data-day]").forEach((b) =>
      b.addEventListener("click", () => { state.day = Number(b.dataset.day); paint(); }));
    view.querySelectorAll("[data-dir]").forEach((b) =>
      b.addEventListener("click", () => { state.dir = Number(b.dataset.dir); paint(); }));
  }
  paint();
}

/* ----------------------------------------------------------------- router */

function route() {
  const stopMatch = location.pathname.match(/^\/stop\/([^/]+)/);
  const routeMatch = location.pathname.match(/^\/route\/([^/]+)/);
  if (stopMatch) renderStop(decodeURIComponent(stopMatch[1]));
  else if (routeMatch) renderRoute(decodeURIComponent(routeMatch[1]));
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
    INDEX = await r.json();
    route();
  } catch {
    view.innerHTML = `<p>Couldn't load the data. Please refresh.</p>`;
  }
})();
