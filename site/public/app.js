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

function renderBanner(d) {
  const since = new Date(d.firstServiceDate + "T12:00:00Z").toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric",
  });
  $("#collecting").innerHTML =
    `<strong>Collecting since ${esc(since)}.</strong> Every 30 seconds, continuously.`;
  $("#stats").innerHTML = [
    [d.totalObservations.toLocaleString(), "arrivals recorded"],
    [d.serviceDays.toLocaleString(), d.serviceDays === 1 ? "service day" : "service days"],
    [d.stopsWithData.toLocaleString(), "stops covered"],
    [d.routesWithData.toLocaleString(), "routes"],
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
  $("#generated").textContent = `Data updated ${new Date(d.generatedAt || Date.now()).toLocaleString()}.`;
}

function renderHome() {
  const ready = INDEX.stops.filter((s) => s.usable).length;
  view.innerHTML = `
    <div class="btn-row">
      <button class="btn" id="near">📍 Find stops near me</button>
    </div>
    <p class="tiny muted" id="geostatus" style="margin-top:8px"></p>

    <h2>Search stops</h2>
    <input type="search" id="q" placeholder="Stop name, e.g. Union South" autocomplete="off"
           enterkeyhint="search" aria-label="Search stops by name">
    <ul class="stops" id="results"></ul>

    <h2>Ready now</h2>
    <p class="small muted">
      ${ready.toLocaleString()} of ${INDEX.stops.length.toLocaleString()} stops have enough
      arrivals to show a figure. The rest are still collecting — most need about two more weeks.
    </p>
    <ul class="stops" id="ready"></ul>`;

  $("#near").addEventListener("click", locate);
  $("#q").addEventListener("input", (e) => search(e.target.value));

  const top = INDEX.stops.filter((s) => s.usable).sort((a, b) => b.n - a.n).slice(0, 8);
  $("#ready").innerHTML = top.map(stopRow).join("");
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
  const state = { route: routes[0], day: present[0], hour: null };

  const head = `
    <p><a href="/" class="small">← All stops</a></p>
    <h2 style="margin-top:6px">${esc(data.stop.name)}</h2>
    <p class="small muted">${
      data.stop.headsigns?.length ? "Towards " + esc(data.stop.headsigns.slice(0, 3).join(", ")) : ""
    }</p>`;

  function paint() {
    const cells = data.cells.filter((c) => c.r === state.route && c.d === state.day);
    const byHour = new Map(cells.map((c) => [c.h, c]));
    if (state.hour === null || !byHour.has(state.hour)) {
      // Default to the busiest hour so the first thing shown is the most
      // informative thing available.
      state.hour = cells.length ? cells.slice().sort((a, b) => b.n - a.n)[0].h : null;
    }

    const routeTabs = routes.map((r) =>
      `<button class="tab" role="tab" aria-selected="${r === state.route}" data-route="${esc(r)}">Route ${esc(r)}</button>`).join("");
    const dayTabs = present.map((d) =>
      `<button class="tab" role="tab" aria-selected="${d === state.day}" data-day="${d}">${DAY_LABEL[d]}</button>`).join("");
    const hourBtns = Array.from({ length: 24 }, (_, h) => {
      const c = byHour.get(h);
      const label = h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
      return `<button class="hr ${c ? "" : "none"}" role="tab" aria-selected="${h === state.hour}"
        ${c ? "" : "disabled"} data-hour="${h}">${label}<span class="n">${c ? c.n : "–"}</span></button>`;
    }).join("");

    view.innerHTML = `${head}
      <div class="tabs" role="tablist" aria-label="Route">${routeTabs}</div>
      ${present.length > 1 ? `<div class="tabs" role="tablist" aria-label="Day">${dayTabs}</div>` : ""}
      <h2>Time of day</h2>
      <div class="hours" role="tablist" aria-label="Hour">${hourBtns}</div>
      <div id="detail"></div>`;

    $("#detail").innerHTML = state.hour === null
      ? `<div class="card"><p class="muted">No arrivals recorded for this route yet.</p></div>`
      : cellCard(byHour.get(state.hour), state);

    view.querySelectorAll("[data-route]").forEach((b) =>
      b.addEventListener("click", () => { state.route = b.dataset.route; state.hour = null; paint(); }));
    view.querySelectorAll("[data-day]").forEach((b) =>
      b.addEventListener("click", () => { state.day = Number(b.dataset.day); state.hour = null; paint(); }));
    view.querySelectorAll("[data-hour]").forEach((b) =>
      b.addEventListener("click", () => { state.hour = Number(b.dataset.hour); paint(); }));
  }
  paint();
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

  return `
    <div class="card">
      <h3>Route ${esc(c.r)} · ${esc(when)}</h3>
      ${scopeNote}

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
    </div>`;
}

/* ----------------------------------------------------------------- router */

function route() {
  const m = location.pathname.match(/^\/stop\/([^/]+)/);
  if (m) renderStop(decodeURIComponent(m[1]));
  else renderHome();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a.stop");
  if (!a) return;
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  route();
  window.scrollTo(0, 0);
});
window.addEventListener("popstate", route);

(async function start() {
  try {
    const r = await fetch("/data/index.json");
    INDEX = await r.json();
    renderBanner({ ...INDEX.dataset, generatedAt: INDEX.generatedAt });
    route();
  } catch {
    view.innerHTML = `<p>Couldn't load the data. Please refresh.</p>`;
  }
})();
