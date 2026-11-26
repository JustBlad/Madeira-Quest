/* =========================================================
   Madeira Quest – App
   Plain HTML/CSS/JS, no build tools.
   - Demo mode: everything stays in the browser (localStorage),
     other students are example data.
   - Live mode (firebase-config.js filled in): visits, ratings,
     photos and points are shared via Firebase Firestore.
   ========================================================= */
(() => {
  "use strict";

  // ---------- State ----------
  const STORE_KEY = "madeiraQuest.v1";
  const LIVE = typeof FIREBASE_CONFIG !== "undefined" && !!FIREBASE_CONFIG.apiKey;
  const FB_VERSION = "10.12.2";

  const defaultState = () => ({
    user: null,            // { name, color }
    visits: {},            // placeId -> { photo, ts, verified, shared, caption }
    ratings: {},           // placeId -> 1..5
    favorites: [],
    points: 0,
    challengeWeeks: [],
    geoAsked: false,
    filter: "all",
  });

  let state = load();
  if (state.mapStyleV !== 3) { state.mapStyle = "dataviz"; state.mapStyleV = 3; } // default after style update: Light
  // ---------- Theme (auto / light / dark) ----------
  const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const isDark = () => (state.theme || "auto") === "dark" || ((state.theme || "auto") === "auto" && darkMQ && darkMQ.matches);
  function applyTheme() {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#0B1420" : "#0E2A47";
    if (typeof mapApi !== "undefined" && mapApi) setMapStyle(state.mapStyle || "dataviz"); // swap to light/dark map tiles
  }
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener("change", () => { if ((state.theme || "auto") === "auto") applyTheme(); });

  let userPos = null;      // { lat, lng, acc }
  let geoWatchId = null;
  let mapInited = false;
  let selectedId = null;
  let pendingUpload = null;
  let lastRoute = null, prevRoute = null;

  // Other students (never includes me). Filled from demo data or Firebase.
  const community = {
    ratings: {},   // placeId -> [values]
    visitors: {},  // placeId -> [{ uid, name, color, flag, caption, ts }]
    users: [],     // [{ uid, name, color, flag, points }]
  };
  let db = null, uid = null;
  const photoCache = {}; // placeId -> [{ uid, name, color, caption, photo }]

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return defaultState();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; }
    catch (e) { toast("Phone storage is full – the photo couldn't be saved locally."); return false; }
  }

  // ---------- Helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const byId = (id) => PLACES.find((p) => p.id === id);
  const isVisited = (id) => !!state.visits[id];
  const level1Done = () => PLACES.filter((p) => p.level === 1 && isVisited(p.id)).length;
  const isUnlocked = (p) => !CONFIG.lockLevels || p.level === 1 || level1Done() >= CONFIG.level2Unlock;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const safeColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(c || "") ? c : "#999");
  const safeImg = (src) => (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src || "") ? src : "");

  function avgRating(id) {
    const r = (community.ratings[id] || []).slice();
    if (state.ratings[id]) r.push(state.ratings[id]);
    if (!r.length) return { avg: 0, count: 0 };
    return { avg: r.reduce((a, b) => a + b, 0) / r.length, count: r.length };
  }
  function visitorsOf(id) {
    const v = (community.visitors[id] || []).slice();
    if (isVisited(id) && state.user) v.push({ uid: uid || "me", name: state.user.name, color: state.user.color, me: true });
    return v;
  }
  function starsHTML(v) {
    let s = "";
    for (let i = 1; i <= 5; i++) s += `<span class="${v >= i - 0.25 ? "" : "off"}">★</span>`;
    return `<span class="stars" aria-label="${v.toFixed(1)} out of 5">${s}</span>`;
  }
  function haversine(a, b) {
    const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const distTo = (p) => (userPos ? haversine(userPos, p) : null);
  function fmtDist(m) {
    if (m == null) return "–";
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }
  const walkMin = (m) => (m == null ? "" : `${Math.max(1, Math.round(m / 80))} min walk`);
  const initials = (n) => (n || "?").trim().charAt(0).toUpperCase();
  const avatarHTML = (name, color, cls = "") => `<span class="avatar ${cls}" style="background:${safeColor(color)}">${esc(initials(name))}</span>`;
  const avatarsHTML = (list, n) => `<span class="avatars">${list.slice(-n).map((v) => avatarHTML(v.name, v.color)).join("")}</span>`;
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const routeURL = (p) => `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${p.lat},${p.lng}`;

  // Points: 5 per visited place, 1 per rating (only for places you visited)
  const myPoints = () =>
    Object.keys(state.visits).length * CONFIG.points.visit +
    Object.keys(state.ratings).filter((id) => state.visits[id]).length * CONFIG.points.rating;

  // Weekly streak: weeks in a row (Mon–Sun) with at least one visited place
  function startOfWeek(at = new Date()) {
    const d = new Date(at); const day = (d.getDay() + 6) % 7; // Mon = 0
    d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d;
  }
  function streak() {
    const weeks = new Set(Object.values(state.visits).map((v) => startOfWeek(v.ts).getTime()));
    const d = startOfWeek();
    const thisWeek = weeks.has(d.getTime());
    if (!thisWeek) d.setDate(d.getDate() - 7);
    let n = 0;
    while (weeks.has(d.getTime())) { n++; d.setDate(d.getDate() - 7); }
    return { n, thisWeek };
  }
  function endOfWeek() { const d = startOfWeek(); d.setDate(d.getDate() + 7); return new Date(d.getTime() - 1); }
  const weekVisits = () => { const s = startOfWeek().getTime(); return Object.values(state.visits).filter((v) => v.ts >= s).length; };
  function countdown(to) {
    const ms = Math.max(0, to - Date.now());
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
  }


  // ---------- Line icons (Lucide-style, 24px grid) ----------
  const ICONS = {
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
    martini: '<path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8Z"/>',
    utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    icecream: '<path d="m7 11 4.08 10.35a1 1 0 0 0 1.84 0L17 11"/><path d="M17 7A5 5 0 0 0 7 7"/><path d="M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
    map: '<path d="M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.4A1 1 0 0 0 3 7.3v12.1a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.2a1 1 0 0 0 .6-.9V4.6a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0Z"/><path d="M15 5.8v15M9 3.2v15"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    anchor: '<path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/><circle cx="12" cy="5" r="3"/>',
    pin: '<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9Z"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    nav: '<path d="M3 11 22 2l-9 19-2-8Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>',
    timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22v-7"/>',
    sprout: '<path d="M7 20h10M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8Z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2Z"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 12.9 17 22l-5-3-5 3 1.5-9.1"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4M12 17h.01"/>',
    arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    auto: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  };
  ICONS.trophy = '<path d="M6 4h12v5a6 6 0 0 1-12 0V4Z"/><path d="M12 15v5M8 20h8M6 6H3v1a3 3 0 0 0 3 3M18 6h3v1a3 3 0 0 1-3 3"/>';
  ICONS.user = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
  // Closed "body" shapes per icon. In the app-tile style they show as a soft
  // filled layer behind the line drawing (see .ic .fl in styles.css).
  const FILL = {
    coffee: '<path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>',
    martini: '<path d="m19 3-7 8-7-8Z"/>',
    utensils: '<path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Z"/>',
    icecream: '<path d="m7 11 4.08 10.35a1 1 0 0 0 1.84 0L17 11Z"/><path d="M17 7A5 5 0 0 0 7 7a2 2 0 0 0 0 4h10a2 2 0 0 0 0-4Z"/>',
    waves: '<circle cx="18" cy="4.5" r="2.2"/>',
    grid: ICONS.grid,
    map: '<path d="M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.4A1 1 0 0 0 3 7.3v12.1a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.2a1 1 0 0 0 .6-.9V4.6a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0Z"/>',
    globe: '<circle cx="12" cy="12" r="10"/>',
    pin: '<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/>',
    star: ICONS.star, nav: ICONS.nav, flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/>', unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/>',
    award: '<circle cx="12" cy="8" r="6"/>', flame: ICONS.flame, timer: '<circle cx="12" cy="14" r="8"/>', clock: '<circle cx="12" cy="12" r="10"/>',
    trophy: '<path d="M6 4h12v5a6 6 0 0 1-12 0V4Z"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0Z"/>',
    users: '<circle cx="9" cy="7" r="4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2Z"/>', target: '<circle cx="12" cy="12" r="10"/>',
    pencil: ICONS.pencil, trash: '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z"/>', bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5Z"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/>', alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/>',
    sun: '<circle cx="12" cy="12" r="4"/>', moon: ICONS.moon, auto: '<rect width="14" height="20" x="5" y="2" rx="2"/>', sprout: '<path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8Z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2Z"/>',
    anchor: '<circle cx="12" cy="5" r="3"/>',
  };
  const ic = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FILL[name] ? `<g class="fl">${FILL[name]}</g>` : ""}${ICONS[name] || ""}</svg>`;
  // App-tile icon: white symbol on a coloured, slightly glossy tile
  const tile = (name, color, cls = "") => `<span class="itile ${cls}"${color ? ` style="--t:${color}"` : ""}>${ic(name)}</span>`;

  // ---------- Art (illustrated placeholder pictures) ----------
  const LOGO = `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="lg-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FD3F2"/><stop offset="1" stop-color="#2FA6D9"/></linearGradient>
    <linearGradient id="lg-land" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7BCB4F"/><stop offset="1" stop-color="#3E9B3A"/></linearGradient></defs>
    <ellipse cx="60" cy="80" rx="54" ry="26" fill="url(#lg-sea)"/>
    <path d="M14 82c6-14 18-20 30-22 8-10 20-14 32-10 12 2 22 10 30 22-10 10-28 14-46 14S20 90 14 82Z" fill="url(#lg-land)"/>
    <path d="M38 68l10-14 8 10 8-16 12 20" fill="none" stroke="#2E7D32" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M30 86c10 3 24 4 34 3" stroke="#fff" stroke-opacity=".6" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M60 8c-13 0-23 10-23 23 0 17 23 39 23 39s23-22 23-39C83 18 73 8 60 8Z" fill="#1D6FE8"/>
    <circle cx="60" cy="31" r="9" fill="#fff"/></svg>`;

  const PALETTES = {
    beach: [["#8FD8F5", "#FFE3B8"], ["#FFB27A", "#FFD9A8"], ["#6EC6EC", "#E9F7FF"], ["#FF9E7A", "#FFE0C2"]],
    cafe:  [["#FFE1C7", "#FFC79A"], ["#F6D5B8", "#E7B48A"], ["#FFEBD9", "#FFB98A"], ["#FDE4CF", "#F3B98C"]],
    bar:   [["#3A1424", "#8E2C48"], ["#0E2A47", "#8E2C48"], ["#4A1A2D", "#1D6FE8"], ["#0E2A47", "#1E7FA8"]],
    food:  [["#E5F6EA", "#BFE6C8"], ["#FFF1DC", "#F8D29A"], ["#E9F7EE", "#A9DDB8"], ["#FFF4E6", "#FFC98F"]],
    sweet: [["#FFE3F1", "#FFC1DD"], ["#FFF0E0", "#FFD0E4"], ["#E6F4FF", "#FFD6EA"], ["#FFF5D6", "#FFC7DF"]],
  };
  let artSeq = 0;
  function placeArt(p, v = 0) {
    const pal = PALETTES[p.cat][v % 4];
    const gid = `g${p.id}${v}_${artSeq++}`;
    const bg = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs>
      <rect width="200" height="200" fill="url(#${gid})"/>`;
    const shift = (v * 23) % 60 - 30;
    let fg = "";
    if (p.cat === "beach") {
      fg = `<circle cx="${140 + shift / 2}" cy="${60 + (v % 2) * 10}" r="22" fill="#FFD45C"/>
        <path d="M0 120 C40 110 80 128 120 118 S180 110 200 116 V200 H0Z" fill="#2FA6D9"/>
        <path d="M0 132 C40 124 80 140 120 130 S180 124 200 128" stroke="#fff" stroke-opacity=".6" stroke-width="3" fill="none"/>
        <path d="M0 160 C50 150 110 168 200 150 V200 H0Z" fill="#E9C98F"/>
        ${v % 2 ? `<path d="M40 150 l20 -50 l4 0 l-14 50z" fill="#8A5A3A"/><path d="M20 104 Q62 70 100 102 Z" fill="#FF7A1A"/>` : `<rect x="${130 + shift / 3}" y="78" width="30" height="40" fill="#FFC52E" rx="3"/><rect x="${126 + shift / 3}" y="72" width="38" height="8" fill="#E8A800"/>`}`;
    } else if (p.cat === "cafe") {
      fg = `<ellipse cx="100" cy="150" rx="62" ry="12" fill="#000" opacity=".08"/>
        <path d="M58 92 h76 v34 a30 30 0 0 1 -30 30 h-16 a30 30 0 0 1 -30 -30z" fill="#fff"/>
        <path d="M134 100 h8 a14 14 0 0 1 0 28 h-10" fill="none" stroke="#fff" stroke-width="8"/>
        <ellipse cx="96" cy="94" rx="36" ry="7" fill="#8B5A33"/>
        <path d="M84 78 c-8 -10 8 -14 0 -26 M100 76 c-8 -10 8 -14 0 -26 M116 78 c-8 -10 8 -14 0 -26" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity=".85"/>
        ${v % 2 ? `<circle cx="${40 + shift / 3}" cy="150" r="14" fill="#F4B740"/><circle cx="${40 + shift / 3}" cy="150" r="9" fill="#E38B1F"/>` : ""}`;
    } else if (p.cat === "bar") {
      fg = `${[...Array(12)].map((_, i) => `<circle cx="${(i * 47 + v * 31) % 200}" cy="${(i * 29 + v * 17) % 80}" r="${1 + (i % 3)}" fill="#fff" opacity=".6"/>`).join("")}
        <path d="M60 70 h80 l-40 46z" fill="#FFB347"/>
        <path d="M60 70 h80 l-40 46z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
        <rect x="97" y="114" width="6" height="34" fill="#fff"/><rect x="78" y="146" width="44" height="6" rx="3" fill="#fff"/>
        <circle cx="132" cy="66" r="11" fill="#FFE14D"/><path d="M118 44 l-22 32" stroke="#FF5E7E" stroke-width="4" stroke-linecap="round"/>`;
    } else if (p.cat === "food") {
      fg = `<ellipse cx="100" cy="150" rx="70" ry="12" fill="#000" opacity=".08"/>
        <ellipse cx="100" cy="118" rx="62" ry="30" fill="#D9A15A"/>
        <ellipse cx="100" cy="110" rx="58" ry="26" fill="#F2C27B"/>
        <path d="M60 106 q40 -18 80 0" stroke="#C98A3E" stroke-width="3" fill="none" opacity=".6"/>
        <circle cx="80" cy="104" r="3" fill="#C98A3E"/><circle cx="118" cy="100" r="3" fill="#C98A3E"/><circle cx="104" cy="116" r="3" fill="#C98A3E"/>
        ${v % 2 ? `<path d="M50 118 q50 18 100 0" stroke="#2BB673" stroke-width="7" fill="none" stroke-linecap="round"/>` : ""}`;
    } else {
      fg = `<path d="M78 98 l22 64 l22 -64z" fill="#E7A65A"/>
        <path d="M84 104 l32 0 M88 116 l24 0 M92 128 l16 0" stroke="#C78433" stroke-width="2"/>
        <circle cx="100" cy="84" r="26" fill="${["#FFD45C", "#FF9EC4", "#8BE0B8", "#FFFFFF"][v % 4]}"/>
        <circle cx="86" cy="70" r="18" fill="${["#FF9EC4", "#FFD45C", "#FFB27A", "#C7A6FF"][v % 4]}"/>
        <circle cx="114" cy="70" r="18" fill="${["#8BE0B8", "#FFFFFF", "#FF9EC4", "#FFD45C"][v % 4]}"/>`;
    }
    return `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${bg}${fg}</svg>`;
  }

  // ---------- Toast / modal / confetti ----------
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  }
  function openModal(html) {
    const m = $("#modal"); m.innerHTML = `<div class="modal-card">${html}</div>`; m.hidden = false;
    m.onclick = (e) => { if (e.target === m) closeModal(); };
    return m;
  }
  function closeModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; }
  const modalOpen = () => !$("#modal").hidden;
  function confetti() {
    const c = document.createElement("div"); c.className = "confetti";
    const colors = ["#1D6FE8", "#FFC23D", "#2BB673", "#5FB3FF", "#0E2A47", "#E5746A"];
    for (let i = 0; i < 70; i++) {
      const s = document.createElement("i");
      s.style.left = Math.random() * 100 + "%";
      s.style.background = colors[i % colors.length];
      s.style.animationDuration = 1.6 + Math.random() * 1.6 + "s";
      s.style.animationDelay = Math.random() * 0.4 + "s";
      c.appendChild(s);
    }
    $("#app").appendChild(c); setTimeout(() => c.remove(), 3800);
  }

  // =========================================================
  //  COMMUNITY BACKEND (demo data or Firebase)
  // =========================================================
  function buildDemoCommunity() {
    if (!CONFIG.demoCommunity) return;
    const find = (n) => DEMO_USERS.find((u) => u.name === n) || { name: n, color: "#999", country: "" };
    PLACES.forEach((p) => {
      const a = DEMO_ACTIVITY[p.id] || { ratings: [], visitors: [], captions: [] };
      community.ratings[p.id] = a.ratings.slice();
      community.visitors[p.id] = a.visitors.map((n, i) => {
        const u = find(n);
        return { uid: "demo-" + n, name: n, color: u.color, flag: u.country, ts: 0, caption: a.captions.length ? a.captions[i % a.captions.length] : "" };
      });
    });
    community.users = DEMO_USERS.map((u) => ({ uid: "demo-" + u.name, name: u.name, color: u.color, flag: u.country, points: PLACES.filter((p) => (DEMO_ACTIVITY[p.id] || { visitors: [] }).visitors.includes(u.name)).length * (CONFIG.points.visit + CONFIG.points.rating) }));
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load " + src));
      document.head.appendChild(s);
    });
  }

  async function initFirebase() {
    const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
    await loadScript(base + "firebase-app-compat.js");
    await Promise.all([loadScript(base + "firebase-auth-compat.js"), loadScript(base + "firebase-firestore-compat.js")]);
    firebase.initializeApp(FIREBASE_CONFIG);
    const cred = await firebase.auth().signInAnonymously();
    uid = cred.user.uid;
    db = firebase.firestore();

    // Points of other players are NOT taken from their (self-written) profile:
    // they are recomputed from visit + rating documents (max 1 per place each).
    const valid = new Set(PLACES.map((p) => p.id));
    const byUid = { visits: {}, ratings: {}, names: {} };
    let usersRaw = [];
    const rebuildUsers = () => {
      const uids = new Set([...usersRaw.map((u) => u.uid), ...Object.keys(byUid.visits)]);
      community.users = [...uids].filter((u) => u !== uid).map((u) => {
        const prof = usersRaw.find((x) => x.uid === u) || byUid.names[u] || {};
        const vis = byUid.visits[u] || new Set(), rat = byUid.ratings[u] || new Set();
        const pts = vis.size * CONFIG.points.visit + [...rat].filter((id) => vis.has(id)).length * CONFIG.points.rating;
        return { uid: u, name: prof.name || "Student", color: prof.color, flag: "", points: pts };
      });
    };

    db.collection("visits").onSnapshot((snap) => {
      const v = {}; byUid.visits = {};
      snap.forEach((d) => {
        const x = d.data();
        if (!valid.has(x.placeId) || d.id !== `${x.placeId}_${x.uid}`) return;
        (byUid.visits[x.uid] = byUid.visits[x.uid] || new Set()).add(x.placeId);
        byUid.names[x.uid] = { name: x.name, color: x.color };
        if (x.uid === uid) return;
        (v[x.placeId] = v[x.placeId] || []).push({ uid: x.uid, name: x.name, color: x.color, ts: x.ts || 0 });
      });
      Object.values(v).forEach((list) => list.sort((a, b) => a.ts - b.ts));
      community.visitors = v; rebuildUsers(); onCommunityChange();
    }, (e) => console.warn("visits", e));

    db.collection("ratings").onSnapshot((snap) => {
      const r = {}; byUid.ratings = {};
      snap.forEach((d) => {
        const x = d.data(), v = Number(x.value);
        if (!valid.has(x.placeId) || !(v >= 1 && v <= 5) || d.id !== `${x.placeId}_${x.uid}`) return;
        (byUid.ratings[x.uid] = byUid.ratings[x.uid] || new Set()).add(x.placeId);
        if (x.uid !== uid) (r[x.placeId] = r[x.placeId] || []).push(Math.round(v));
      });
      community.ratings = r; rebuildUsers(); onCommunityChange();
    }, (e) => console.warn("ratings", e));

    db.collection("users").limit(300).onSnapshot((snap) => {
      usersRaw = [];
      snap.forEach((d) => { const x = d.data(); usersRaw.push({ uid: d.id, name: String(x.name || "").slice(0, 20), color: x.color }); });
      rebuildUsers(); onCommunityChange();
    }, (e) => console.warn("users", e));

    syncUser();
    // Upload visits made while offline / before Firebase loaded
    Object.keys(state.visits).forEach((id) => { if (!state.visits[id].synced) pushVisit(id).catch(() => {}); });
    Object.keys(state.ratings).forEach(pushRating);
  }

  async function fetchPhotos(placeId) {
    if (!db) return [];
    const snap = await db.collection("photos").where("placeId", "==", placeId).get();
    const list = [];
    snap.forEach((d) => { const x = d.data(); if (x.uid !== uid) list.push(x); });
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    photoCache[placeId] = list;
    return list;
  }

  function syncUser() {
    if (!db || !uid || !state.user) return;
    db.collection("users").doc(uid).set({
      name: state.user.name, color: state.user.color, points: myPoints(),
      visited: Object.keys(state.visits).length, updatedAt: Date.now(),
    }).catch((e) => console.warn("user sync", e));
  }
  async function pushVisit(placeId, photoData) {
    if (!db || !uid) return;
    const v = state.visits[placeId], key = `${placeId}_${uid}`;
    const base = { placeId, uid, name: state.user.name, color: state.user.color, ts: v.ts };
    await db.collection("visits").doc(key).set({ ...base, verified: !!v.verified });
    const photo = photoData || v.photo;
    if (v.shared && photo) await db.collection("photos").doc(key).set({ ...base, photo, caption: v.caption || "" });
    v.synced = true; save();
    syncUser();
  }
  function pushRating(placeId) {
    if (!db || !uid || !state.ratings[placeId]) return;
    db.collection("ratings").doc(`${placeId}_${uid}`).set({ placeId, uid, value: state.ratings[placeId], ts: Date.now() })
      .catch((e) => console.warn("rating", e));
    syncUser();
  }
  async function deleteMyData() {
    if (!db || !uid) return;
    const jobs = [];
    PLACES.forEach((p) => ["ratings", "photos", "visits"].forEach((c) => jobs.push(db.collection(c).doc(`${p.id}_${uid}`).delete().catch(() => {}))));
    jobs.push(db.collection("users").doc(uid).delete().catch(() => {}));
    await Promise.all(jobs);
  }

  let changeTimer;
  function onCommunityChange() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      refreshMarkers();
      if (selectedId) renderSheet(selectedId, true);
      if (modalOpen() || !state.user) return; // don't disturb the user mid-action
      const [, page, arg] = (location.hash || "#/map").split("/");
      if (page === "quests") keepScroll("#view-quests", renderQuests);
      else if (page === "profile") keepScroll("#view-profile", renderProfile);
      else if (page === "place" && arg) keepScroll("#view-place", () => renderPlace(arg, true));
    }, 250);
  }
  function keepScroll(sel, fn) { const el = $(sel), y = el.scrollTop; fn(); el.scrollTop = y; }

  // ---------- Geolocation ----------
  // Anti-spoofing (client side, best effort):
  //  - a fake-GPS app usually "teleports": jumping kilometres in seconds is flagged
  //  - accuracy of exactly 0–1 m is typical for mock locations, real GPS is ~3–30 m
  //  - at upload we ask for a FRESH position (no cached one) and check its age
  const GEO = { maxAccuracy: 100, maxAgeMs: 60000, maxSpeed: 70 /* m/s ≈ 250 km/h */, suspectMs: 10 * 60000 };
  let lastFix = null, geoSuspectUntil = 0;
  function trackFix(pos) {
    const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: pos.timestamp || Date.now(), acc: pos.coords.accuracy };
    if (lastFix) {
      const dist = haversine(lastFix, fix), dt = Math.max(1, (fix.t - lastFix.t) / 1000);
      if (dist > 1000 && dist / dt > GEO.maxSpeed) geoSuspectUntil = Date.now() + GEO.suspectMs; // teleport
    }
    if (fix.acc != null && fix.acc < 1) geoSuspectUntil = Date.now() + GEO.suspectMs; // unrealistically perfect
    lastFix = fix;
    return fix;
  }
  function freshFix() {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => { const f = trackFix(pos); userPos = { lat: f.lat, lng: f.lng, acc: f.acc }; updateMe(); resolve(f); },
        () => resolve(lastFix && Date.now() - lastFix.t <= GEO.maxAgeMs ? lastFix : null), // fall back to a recent fix
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 }
      );
    });
  }
  // Returns { ok, reason } – whether a visit can count as "verified on site"
  function onSiteCheck(p, fix, file) {
    if (!fix) return { ok: false, reason: "Location unknown – saved without on-site check." };
    const d = haversine(fix, p);
    if (Date.now() < geoSuspectUntil) return { ok: false, reason: "Your location jumped unrealistically – saved without on-site check." };
    if (fix.acc > GEO.maxAccuracy) return { ok: false, reason: `GPS too inaccurate (±${Math.round(fix.acc)} m) – saved without on-site check.` };
    if (Date.now() - fix.t > GEO.maxAgeMs) return { ok: false, reason: "Location is outdated – saved without on-site check." };
    if (d > CONFIG.checkinRadius) return { ok: false, reason: `You're ${fmtDist(d)} away – saved without on-site check.` };
    if (file && file.lastModified && Date.now() - file.lastModified > 24 * 3600e3) return { ok: false, reason: "This photo is older than 24 h – saved without on-site check." };
    return { ok: true, reason: "You're on site – your visit will be verified." };
  }

  function startGeo(userInitiated) {
    if (!("geolocation" in navigator)) { if (userInitiated) toast("Your browser doesn't support GPS."); return; }
    state.geoAsked = true; save();
    if (geoWatchId != null) { if (userInitiated && userPos) centerOnMe(); return; }
    let first = true;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        trackFix(pos);
        userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        updateMe();
        if (first && userInitiated) centerOnMe();
        first = false;
        refreshDistances();
      },
      (err) => {
        if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
        $("#locateBtn").classList.remove("active");
        if (err.code === 1) toast("Location blocked – you can allow it in your browser settings.");
        else if (userInitiated) toast("Couldn't find your location.");
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
  }
  function updateMe() {
    if (!mapApi || !userPos) return;
    mapApi.setMe(userPos.lat, userPos.lng, userPos.acc);
    $("#locateBtn").classList.add("active");
  }
  // Always fly to where the user really is – in Funchal or anywhere else.
  function centerOnMe() {
    if (!userPos || !mapApi) return;
    mapApi.flyTo(userPos.lat, userPos.lng, 16);
    const km = haversine(userPos, { lat: CONFIG.center[0], lng: CONFIG.center[1] }) / 1000;
    if (km > 15) toast(`You're ${km < 100 ? km.toFixed(0) : Math.round(km).toLocaleString("en")} km from Funchal – tap “Funchal” to jump back`);
  }
  // show all places at once (they spread from Praia Formosa to the university)
  function placesBounds() {
    const lats = PLACES.map((p) => p.lat), lngs = PLACES.map((p) => p.lng);
    return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
  }
  function goFunchal() { mapApi && mapApi.fitBounds(placesBounds()); }
  function refreshDistances() {
    if (selectedId) renderSheet(selectedId, true);
    const h = location.hash;
    if (h.startsWith("#/place/")) {
      const el = $("#distVal"), p = byId(h.split("/")[2]);
      if (el && p) { el.textContent = fmtDist(distTo(p)); $("#distSub").textContent = walkMin(distTo(p)) || "Distance"; updateGpsState(p); }
    }
  }
  function updateGpsState(p) {
    const el = $("#gpsState"); if (!el) return;
    const d = distTo(p);
    if (d == null) {
      el.className = "gps-state";
      el.innerHTML = `${ic("pin")} <a href="#" id="gpsAsk" style="text-decoration:underline">Turn on location</a> to verify your visit on site`;
      $("#gpsAsk").onclick = (e) => { e.preventDefault(); startGeo(true); };
    } else if (d <= CONFIG.checkinRadius) {
      el.className = "gps-state ok"; el.innerHTML = `${ic("check")} You're here – your visit will be verified`;
    } else {
      el.className = "gps-state"; el.textContent = `You're ${fmtDist(d)} away. Upload on site to get it verified.`;
    }
  }

  // =========================================================
  //  MAP – Google Maps (if CONFIG.googleMapsKey) or Leaflet fallback.
  //  The rest of the app only talks to `mapApi`.
  // =========================================================
  let mapApi = null;

  // Map styles the user can pick (layer button). "sat" = satellite with labels.
  const MAP_STYLES = [
    { id: "dataviz", name: "Light",     mt: "dataviz",   dark: "dataviz-dark",    hint: "Calm & clean, pins stand out", sw: ["#F6F6F4", "#E9E9E6", "#D5E4EC"] },
    { id: "bright",  name: "Bright",    mt: "bright-v2", dark: "streets-v2-dark", hint: "Colourful & friendly",         sw: ["#F8F4EC", "#FFD86B", "#8FD0F0"] },
    { id: "sat",     name: "Satellite", mt: "hybrid",                             hint: "Photo with street names",      sw: ["#3B5A3A", "#6E8B5A", "#1E5A7A"], ext: "jpg" },
  ];
  const styleById = (id) => MAP_STYLES.find((x) => x.id === id) || MAP_STYLES[0];

  function markerHTML(p) {
    const c = CATEGORIES[p.cat], { avg } = avgRating(p.id);
    const cls = ["mq-marker", isVisited(p.id) && "visited", !isUnlocked(p) && "locked", selectedId === p.id && "selected"].filter(Boolean).join(" ");
    const label = !isUnlocked(p) ? ic("lock", "ic-xs") : avg ? `<b class="st">★</b>${avg.toFixed(1)}` : "new";
    return `<div class="${cls}" style="--c:${c.color}"><div class="mq-pin"></div><div class="mq-pin-ic">${ic(c.icon)}</div><div class="mq-rating">${label}</div>${isVisited(p.id) ? `<div class="mq-done">${ic("check")}</div>` : ""}</div>`;
  }
  const ME_HTML = '<div class="mq-me"></div>';

  function initMap() {
    const el = $("#map");
    const startLeaflet = () => { el.innerHTML = ""; el.className = ""; mapApi = leafletMap(el); afterMapReady(); };
    if (CONFIG.googleMapsKey) {
      googleMap(el).then((api) => { mapApi = api; afterMapReady(); })
        .catch((e) => { console.warn("Google Maps failed – using fallback map", e); toast("Google Maps unavailable – using backup map"); startLeaflet(); });
    } else startLeaflet();
    $("#locateBtn").onclick = () => { if (userPos) centerOnMe(); else startGeo(true); };
    $("#funchalBtn").onclick = goFunchal;
    $("#layerBtn").onclick = (e) => { e.stopPropagation(); toggleStyleMenu(); };
    $("#styleMenu").onclick = (e) => {
      e.stopPropagation();
      const b = e.target.closest("[data-style]"); if (!b) return;
      setMapStyle(b.dataset.style); toggleStyleMenu(false);
    };
    document.addEventListener("click", () => { const m = $("#styleMenu"); if (m && !m.hidden) toggleStyleMenu(false); });
    renderChips();
  }
  function afterMapReady() {
    PLACES.forEach((p) => mapApi.addMarker(p.id, p.lat, p.lng, markerHTML(p), () => selectPlace(p.id)));
    mapApi.onMapClick(closeSheet);
    setMapStyle(state.mapStyle || "dataviz");
    applyFilter();
    updateMe();
    if (!userPos) setTimeout(goFunchal, 50); // start with all places in view
  }
  function setMapStyle(style) {
    if (!mapApi) return;
    if (!MAP_STYLES.some((x) => x.id === style)) style = MAP_STYLES[0].id; // old/removed saved value
    const st = styleById(style);
    mapApi.setStyle(st.id);
    state.mapStyle = st.id; save();
    $("#view-map").classList.toggle("sat", st.id === "sat");
    $("#layerIc").innerHTML = ic(st.id === "sat" ? "globe" : "map");
    $("#layerTxt").textContent = st.name;
    renderStyleMenu();
  }
  function renderStyleMenu() {
    const menu = $("#styleMenu"); if (!menu) return;
    const list = mapApi && mapApi.kind === "google" ? MAP_STYLES.filter((x) => x.id === "dataviz" || x.id === "sat") : MAP_STYLES;
    menu.innerHTML = `<div class="sm-title">Map style</div>` + list.map((x) => `
      <button class="sm-item ${state.mapStyle === x.id ? "on" : ""}" data-style="${x.id}">
        <span class="sm-sw">${x.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
        <span class="sm-txt"><b>${x.name}</b><small>${x.hint}</small></span>
        ${state.mapStyle === x.id ? ic("check") : ""}
      </button>`).join("");
  }
  function toggleStyleMenu(open) {
    const menu = $("#styleMenu");
    const willOpen = open ?? menu.hidden;
    menu.hidden = !willOpen;
    if (willOpen) renderStyleMenu();
  }

  // ---------- Google Maps implementation ----------
  function loadGoogleMaps() {
    if (window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      window.__mqGmapsReady = () => { clearTimeout(timer); resolve(); };
      window.gm_authFailure = () => { clearTimeout(timer); reject(new Error("Google Maps key rejected")); if (window.__mqOnAuthFail) window.__mqOnAuthFail(); };
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CONFIG.googleMapsKey)}&v=weekly&loading=async&callback=__mqGmapsReady`;
      s.async = true; s.onerror = () => { clearTimeout(timer); reject(new Error("script load failed")); };
      document.head.appendChild(s);
    });
  }
  async function googleMap(el) {
    await loadGoogleMaps();
    const { Map, Circle } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const g = new Map(el, {
      center: { lat: CONFIG.center[0], lng: CONFIG.center[1] }, zoom: CONFIG.zoom,
      mapId: CONFIG.googleMapId || "DEMO_MAP_ID",
      mapTypeId: state.mapStyle === "sat" ? "hybrid" : "roadmap",
      disableDefaultUI: true, gestureHandling: "greedy", clickableIcons: false, tilt: 0,
      colorScheme: isDark() ? "DARK" : "LIGHT",
    });
    // key rejected after the map was created (e.g. billing off) → swap to the backup map
    window.__mqOnAuthFail = () => { toast("Google Maps key rejected – using backup map"); el.innerHTML = ""; mapApi = leafletMap(el); afterMapReady(); };
    const mk = {}; let me = null, acc = null;
    const box = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
    return {
      kind: "google",
      addMarker(id, lat, lng, html, onClick) {
        const m = new AdvancedMarkerElement({ map: g, position: { lat, lng }, content: box(html), gmpClickable: true });
        m.addListener("click", onClick);
        mk[id] = m;
      },
      updateMarker(id, html) { if (mk[id]) mk[id].content.innerHTML = html; },
      showMarker(id, on) { if (mk[id]) mk[id].map = on ? g : null; },
      setMe(lat, lng, accuracy) {
        const pos = { lat, lng };
        if (!me) {
          const d = box(ME_HTML); d.style.transform = "translateY(50%)";
          me = new AdvancedMarkerElement({ map: g, position: pos, content: d, zIndex: 1000 });
          acc = new Circle({ map: g, center: pos, radius: accuracy, strokeColor: "#2F80ED", strokeWeight: 1, fillColor: "#2F80ED", fillOpacity: 0.1, clickable: false });
        } else { me.position = pos; acc.setCenter(pos); acc.setRadius(accuracy); }
      },
      flyTo(lat, lng, zoom) { g.panTo({ lat, lng }); if (zoom != null) g.setZoom(zoom); },
      panTo(lat, lng) { g.panTo({ lat, lng }); },
      fitBounds(b) { g.fitBounds(b, { top: 120, bottom: 24, left: 20, right: 64 }); },
      onMapClick(fn) { g.addListener("click", fn); },
      setStyle(style) { g.setMapTypeId(style === "sat" ? "hybrid" : "roadmap"); },
      resize() {},
    };
  }

  // ---------- Leaflet fallback implementation ----------
  function leafletMap(el) {
    const m = L.map(el, { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 }).setView(CONFIG.center, CONFIG.zoom);
    const mk = {}; let me = null, acc = null, layers = [], maptilerFailed = false;
    const icon = (html) => L.divIcon({ className: "", iconSize: [44, 46], iconAnchor: [22, 44], html });
    const mtLayer = (st) => L.tileLayer(`https://api.maptiler.com/maps/${isDark() && st.dark ? st.dark : st.mt}/{z}/{x}/{y}{r}.${st.ext || "png"}?key=${CONFIG.maptilerKey}`, {
      tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 20, crossOrigin: true,
      attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    });
    const BASE = {
      esri: () => [
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, maxNativeZoom: 19, className: "sat-imagery", attribution: "Imagery &copy; Esri, Maxar &middot; Labels &copy; CARTO, OSM" }),
        L.tileLayer("https://{s}.basemap.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}{r}.png", { maxZoom: 20, subdomains: "abcd", className: "sat-labels" }),
      ],
      carto: () => [L.tileLayer(`https://{s}.basemap.cartocdn.com/rastertiles/${isDark() ? "dark_all" : "voyager"}/{z}/{x}/{y}{r}.png`, { maxZoom: 19, subdomains: "abcd", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>' })],
      osm: () => [L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })],
    };
    const layersFor = (style) => {
      if (BASE[style]) return BASE[style]();
      if (CONFIG.maptilerKey && !maptilerFailed) return [mtLayer(styleById(style))];
      return style === "sat" ? BASE.esri() : BASE.carto();
    };
    function setBase(style) {
      layers.forEach((l) => m.removeLayer(l));
      layers = layersFor(style);
      let errors = 0;
      layers[0].on("tileerror", () => {
        if (++errors !== 6) return;
        if (CONFIG.maptilerKey && !maptilerFailed && !BASE[style]) { maptilerFailed = true; console.warn("MapTiler failed – using free fallback"); setBase(style); return; }
        if (style !== "osm") { toast("Map tiles failed to load – switching provider"); setBase(style === "sat" && !BASE[style] ? "carto" : "osm"); }
      });
      layers.forEach((l) => l.addTo(m));
      layers[0].bringToBack();
    }
    return {
      kind: "leaflet",
      addMarker(id, lat, lng, html, onClick) {
        mk[id] = L.marker([lat, lng], { icon: icon(html) }).addTo(m).on("click", (e) => { L.DomEvent.stopPropagation(e); onClick(); });
      },
      updateMarker(id, html) { if (mk[id]) mk[id].setIcon(icon(html)); },
      showMarker(id, on) { const x = mk[id]; if (!x) return; if (on && !m.hasLayer(x)) x.addTo(m); if (!on && m.hasLayer(x)) m.removeLayer(x); },
      setMe(lat, lng, accuracy) {
        if (!me) {
          me = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: ME_HTML, iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000, interactive: false }).addTo(m);
          acc = L.circle([lat, lng], { radius: accuracy, color: "#2F80ED", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(m);
        } else { me.setLatLng([lat, lng]); acc.setLatLng([lat, lng]).setRadius(accuracy); }
      },
      flyTo(lat, lng, zoom) { m.flyTo([lat, lng], zoom ?? m.getZoom(), { duration: 0.9 }); },
      panTo(lat, lng) { m.panTo([lat, lng], { animate: true }); },
      fitBounds(b) { m.flyToBounds([[b.south, b.west], [b.north, b.east]], { paddingTopLeft: [20, 120], paddingBottomRight: [64, 24], duration: 0.9 }); },
      onMapClick(fn) { m.on("click", fn); },
      setStyle(style) { setBase(style); },
      resize() { m.invalidateSize(); },
    };
  }

  function refreshMarkers() { if (mapApi) PLACES.forEach((p) => mapApi.updateMarker(p.id, markerHTML(p))); }
  function renderChips() {
    const chips = [["all", "All", "grid"], ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.label, c.icon])];
    $("#chips").innerHTML = chips.map(([k, l, e]) => `<button class="chip ${state.filter === k ? "active" : ""}" data-f="${k}">${tile(e, state.filter === k ? "var(--orange)" : "var(--tile-off)", "sm")}${l}</button>`).join("");
    $("#chips").onclick = (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.filter = b.dataset.f; save(); renderChips(); applyFilter(); closeSheet();
    };
  }
  function applyFilter() {
    if (!mapApi) return;
    PLACES.forEach((p) => mapApi.showMarker(p.id, state.filter === "all" || p.cat === state.filter));
  }
  function selectPlace(id) {
    const prev = selectedId; selectedId = id;
    if (prev) mapApi.updateMarker(prev, markerHTML(byId(prev)));
    mapApi.updateMarker(id, markerHTML(byId(id)));
    const p = byId(id);
    mapApi.panTo(p.lat - 0.0012, p.lng);
    renderSheet(id);
  }
  function renderSheet(id, silent) {
    if (!silent) wantPhotos(byId(id));
    const p = byId(id), c = CATEGORIES[p.cat], { avg, count } = avgRating(id), v = visitorsOf(id), d = distTo(p);
    const unlocked = isUnlocked(p), visit = state.visits[id];
    $("#sheet").innerHTML = `
      <button class="sheet-close" aria-label="Close">${ic("x")}</button>
      <div class="sheet-card">
        <div class="sheet-thumb ph" data-thumb="${p.id}">${thumbHTML(p)}</div>
        <div class="sheet-body">
          <span class="tag ${visit ? "green" : !unlocked ? "grey" : ""}" style="align-self:flex-start">${visit ? ic("check", "ic-sm") + " Visited" : !unlocked ? ic("lock", "ic-sm") + " Level " + p.level : ic(c.icon, "ic-sm") + " " + c.label}</span>
          <div class="sheet-title">${esc(p.name)}</div>
          <div class="sheet-meta">${count ? `${starsHTML(avg)} <b style="color:var(--ink)">${avg.toFixed(1)}</b> (${count})` : "No ratings yet"} · ${fmtDist(d)}</div>
          <div class="sheet-social">${v.length ? `${avatarsHTML(v, 3)} ${plural(v.length, "student has", "students have")} been here` : ic("sprout") + " Be the first one here!"}</div>
        </div>
      </div>
      <div class="sheet-actions">
        <a class="btn btn-outline" href="${routeURL(p)}" target="_blank" rel="noopener">${ic("nav")} Route</a>
        <a class="btn btn-primary" href="#/place/${p.id}">Open</a>
      </div>`;
    $(".sheet-close").onclick = closeSheet;
    if (!silent) { $("#sheet").classList.add("open"); $("#view-map").classList.add("sheet-open"); }
  }
  function closeSheet() {
    $("#sheet").classList.remove("open"); $("#view-map").classList.remove("sheet-open");
    const prev = selectedId; selectedId = null;
    if (prev && mapApi) mapApi.updateMarker(prev, markerHTML(byId(prev)));
  }

  // ---------- Place page ----------
  // Real pictures for the header: official photos from data.js (img/ folder),
  // then photos the group uploaded, then my own photo. Illustrations fill the rest.
  // ---------- Real photos of the places via Google Places API (official, with attribution) ----------
  // Needs CONFIG.googleMapsKey with "Places API (New)" enabled. Photos are fetched on demand
  // (when a place is opened) and kept for this browser session only.
  const gPhotos = {};          // placeId -> [{ src, credit, link }]
  const gPending = {};
  const G_CACHE = "mq.gphotos.v1";
  try { Object.assign(gPhotos, JSON.parse(sessionStorage.getItem(G_CACHE) || "{}")); } catch (e) { /* ignore */ }
  const usePlacePhotos = () => !!CONFIG.googleMapsKey && CONFIG.googlePlacePhotos !== false;
  function loadPlacePhotos(p) {
    if (!usePlacePhotos() || gPhotos[p.id] || gPending[p.id]) return Promise.resolve(gPhotos[p.id] || []);
    gPending[p.id] = (async () => {
      try {
        await loadGoogleMaps();
        const { Place } = await google.maps.importLibrary("places");
        const { places } = await Place.searchByText({
          textQuery: `${p.name}, Funchal, Madeira`,
          fields: ["id", "displayName", "location", "photos"],
          locationBias: { center: { lat: p.lat, lng: p.lng }, radius: 300 },
          maxResultCount: 1,
        });
        const place = places && places[0];
        // only accept a result that is really at our place (≤ 400 m)
        if (!place || !place.location || haversine({ lat: place.location.lat(), lng: place.location.lng() }, p) > 400) { gPhotos[p.id] = []; return []; }
        gPhotos[p.id] = (place.photos || []).slice(0, 3).map((ph) => {
          const a = (ph.authorAttributions || [])[0] || {};
          return { src: ph.getURI({ maxWidth: 900 }), credit: `© ${a.displayName || "Google user"} · Google Maps`, link: a.uri || "" };
        });
        try { sessionStorage.setItem(G_CACHE, JSON.stringify(gPhotos)); } catch (e) { /* ignore */ }
        return gPhotos[p.id];
      } catch (e) { console.warn("Place photos", p.id, e); gPhotos[p.id] = []; return []; }
      finally { delete gPending[p.id]; }
    })();
    return gPending[p.id];
  }
  // after photos arrived: refresh the visible picture slots of that place
  function refreshPlacePictures(p) {
    if (location.hash === `#/place/${p.id}` && $("#heroWrap")) $("#heroWrap").innerHTML = heroHTML(p);
    if (selectedId === p.id) renderSheet(p.id, true);
    document.querySelectorAll(`[data-thumb="${p.id}"]`).forEach((el) => (el.innerHTML = thumbHTML(p)));
  }
  function wantPhotos(p) { if (usePlacePhotos() && !gPhotos[p.id]) loadPlacePhotos(p).then(() => refreshPlacePictures(p)); }

  function placePhotos(p) {
    const list = (p.photos || []).map((src) => ({ src, credit: p.photoCredit || "" }));
    (gPhotos[p.id] || []).forEach((x) => list.push(x));
    (photoCache[p.id] || []).forEach((x) => { const img = safeImg(x.photo); if (img) list.push({ src: img, credit: `Photo: ${x.name}` }); });
    const v = state.visits[p.id];
    if (v && v.photo) list.push({ src: v.photo, credit: "Your photo" });
    return list;
  }
  function thumbHTML(p) {
    const v = state.visits[p.id];
    const g = gPhotos[p.id] && gPhotos[p.id][0];
    const src = (p.photos && p.photos[0]) || (g && g.src) || (v && v.photo);
    return src ? `<img src="${esc(src)}" alt="" loading="lazy">` : placeArt(p, 0);
  }
  function heroHTML(p) {
    const photos = placePhotos(p);
    return [0, 1, 2].map((i) => photos[i]
      ? `<div class="ph"><img src="${esc(photos[i].src)}" alt="${esc(p.name)}" loading="lazy" data-fallback>${photos[i].credit ? (photos[i].link ? `<a class="ph-credit" href="${esc(photos[i].link)}" target="_blank" rel="noopener nofollow">${esc(photos[i].credit)}</a>` : `<span class="ph-credit">${esc(photos[i].credit)}</span>`) : ""}</div>`
      : `<div class="ph">${placeArt(p, i)}</div>`).join("");
  }

  function galleryItems(p) {
    const visit = state.visits[p.id], items = [];
    if (visit && visit.photo) items.push({ name: state.user.name, color: state.user.color, cap: visit.caption || "You", img: visit.photo });
    if (LIVE) {
      (photoCache[p.id] || []).forEach((x) => { const img = safeImg(x.photo); if (img) items.push({ name: x.name, color: x.color, cap: x.caption || x.name, img }); });
    } else {
      (community.visitors[p.id] || []).forEach((x, i) => items.push({ name: x.name, color: x.color, cap: x.caption || x.name, art: placeArt(p, i + 1) }));
    }
    return items;
  }
  function galleryHTML(p) {
    const items = galleryItems(p);
    if (!items.length) return `<div class="empty">No shared photos yet.</div>`;
    return `<div class="gallery-grid">${items.map((it) => `<div class="ph">${it.img ? `<img src="${it.img}" alt="Photo by ${esc(it.name)}" loading="lazy">` : it.art}<div class="ph-cap">${avatarHTML(it.name, it.color)}${esc(it.cap)}</div></div>`).join("")}</div>`;
  }

  function renderPlace(id, fromRefresh) {
    const p = byId(id); if (!p) { location.hash = "#/map"; return; }
    if (!fromRefresh) wantPhotos(p);
    const c = CATEGORIES[p.cat], { avg, count } = avgRating(id), v = visitorsOf(id), d = distTo(p);
    const visit = state.visits[id], unlocked = isUnlocked(p), fav = state.favorites.includes(id);
    const others = (community.visitors[id] || []).length;
    const missing = CONFIG.level2Unlock - level1Done();

    let action;
    if (!unlocked) {
      action = `<div class="empty">${ic("lock")} Visit <b>${plural(missing, "more Level 1 place", "more Level 1 places")}</b> to unlock this one.</div>`;
    } else if (!visit) {
      action = `<div class="upload-card">
          <div class="upload-ic">+</div>
          <h3>Been here?</h3>
          <p>Upload a photo of this place to unlock the gallery${others ? ` of the <b>${others}</b> other ${others === 1 ? "student" : "students"}` : ""}.</p>
          <button class="btn btn-primary btn-block" id="uploadBtn">${ic("camera")} Upload photo</button>
          <div class="gps-state" id="gpsState"></div>
        </div>`;
    } else {
      const my = state.ratings[id] || 0;
      action = `<div class="done-card">
          <div class="done-check">${ic("check")}</div>
          <div><b>Visited!</b><small>${visit.verified ? ic("pin", "ic-sm") + " Verified on site" : "Photo uploaded"} · ${new Date(visit.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</small></div>
          ${visit.photo ? `<div class="done-thumb"><img src="${visit.photo}" alt=""></div>` : ""}
        </div>
        <div class="rate-box">
          <p>${my ? "Your rating" : "How was it?"}</p>
          <div class="rate-stars" id="rateStars">${[1, 2, 3, 4, 5].map((i) => `<button data-v="${i}" class="${i <= my ? "on" : ""}" aria-label="${i} stars">★</button>`).join("")}</div>
          <small>${my ? "Tap to change your rating" : `Be honest – it helps everyone (+${CONFIG.points.rating} point)`}</small>
        </div>`;
    }

    const lockedCells = [1, 2, 3, 4, 5, 6].map((i) => `<div class="ph">${placeArt(p, i)}</div>`).join("");
    const nPhotos = galleryItems(p).length;

    $("#view-place").innerHTML = `
      <div class="place-top">
        <button class="icon-btn" id="backBtn" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <h1>${esc(p.name)}</h1>
        <button class="icon-btn fav-btn ${fav ? "on" : ""}" id="favBtn" aria-label="Save">${ic("star", fav ? "ic-fill" : "")}</button>
      </div>
      ${!unlocked ? `<div class="locked-banner"><span class="lb-ic">${ic("lock")}</span><div><b>Level ${p.level} – still locked</b>${plural(missing, "more place", "more places")} from Level 1 and it's yours.</div></div>` : ""}
      <div class="gallery-hero" id="heroWrap">${heroHTML(p)}</div>
      <div class="place-body">
        <div class="place-head">
          <div>
            <div class="place-cat">${c.label} · ${esc(p.area)} · Level ${p.level}</div>
            <div class="place-rating">${count ? `<b>${avg.toFixed(1)}</b>${starsHTML(avg)}<small>(${count})</small>` : `<small>No ratings yet</small>`}</div>
          </div>
          <div class="place-dist"><b id="distVal">${fmtDist(d)}</b><small id="distSub">${walkMin(d) || "Distance"}</small></div>
        </div>
        <p class="place-desc">${esc(p.desc)}</p>
        <div class="info-row">
          <div class="info-box"><b>${ic("bulb", "ic-sm")} Tip</b>${esc(p.tip)}</div>
          <div class="info-box"><b>${ic("clock", "ic-sm")} Open</b>${esc(p.hours)}</div>
        </div>
        ${v.length
          ? `<div class="social-proof">${avatarsHTML(v, 4)}<span><b>${plural(v.length, "student", "students")}</b> from your group ${v.length === 1 ? "has" : "have"} been here</span></div>`
          : `<div class="social-proof">${ic("sprout")}<span>Nobody has been here yet – <b>be the first</b> to discover it!</span></div>`}
        <a class="btn btn-ghost btn-block" href="${routeURL(p)}" target="_blank" rel="noopener" style="margin-bottom:18px">${ic("nav")} Directions in Google Maps</a>

        ${action}

        <div class="section-title">Group gallery <small id="photoCount">${visit ? plural(nPhotos, "photo", "photos") : ""}</small></div>
        <div id="galleryWrap">${visit
          ? galleryHTML(p)
          : `<div class="gallery-grid locked">${lockedCells}<div class="lock-overlay"><div class="lock-ic">${ic("lock")}</div><b>Upload a photo to see the gallery</b></div></div>`}</div>
      </div>`;

    $("#backBtn").onclick = () => { if (prevRoute) history.back(); else location.hash = "#/map"; };
    $("#favBtn").onclick = () => {
      const i = state.favorites.indexOf(id);
      if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(id);
      save(); keepScroll("#view-place", () => renderPlace(id, true)); toast(i >= 0 ? "Removed from saved" : "Saved");
    };
    const ub = $("#uploadBtn");
    if (ub) ub.onclick = () => { pendingUpload = id; const fi = $("#fileInput"); fi.value = ""; fi.click(); };
    const rs = $("#rateStars");
    if (rs) rs.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const first = !state.ratings[id];
      state.ratings[id] = +b.dataset.v;
      save(); pushRating(id); refreshMarkers(); updateScore();
      keepScroll("#view-place", () => renderPlace(id, true));
      toast(first ? `Thanks! +${CONFIG.points.rating} point` : "Rating updated");
    };
    updateGpsState(p);

    // Live mode: load the group's real photos once the gallery is unlocked
    if (LIVE && visit && !fromRefresh) {
      fetchPhotos(id).then(() => {
        if (location.hash !== `#/place/${id}`) return;
        $("#galleryWrap").innerHTML = galleryHTML(p);
        $("#heroWrap").innerHTML = heroHTML(p);
        $("#photoCount").textContent = plural(galleryItems(p).length, "photo", "photos");
      }).catch((e) => console.warn("photos", e));
    }
  }

  // ---------- Upload flow ----------
  function compressImage(file, max, q) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL("image/jpeg", q));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
      img.src = url;
    });
  }

  async function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    const id = pendingUpload; pendingUpload = null;
    if (!file || !id) return;
    if (!/^image\//.test(file.type || "image/")) { toast("Please choose a photo."); return; }
    if (file.size > 25 * 1024 * 1024) { toast("That photo is too large (max 25 MB)."); return; }
    let data;
    try { data = await compressImage(file, LIVE ? 800 : 1000, LIVE ? 0.68 : 0.72); } catch (err) { toast(err.message); return; }
    const p = byId(id);
    let fix = null;
    if (state.geoAsked) { toast("Checking your location…"); fix = await freshFix(); }
    const check = onSiteCheck(p, fix, file), verified = check.ok;
    const pts = CONFIG.points.visit;
    openModal(`
      <img class="preview" src="${data}" alt="Preview">
      <h2>${esc(p.name)}</h2>
      <p>${esc(check.reason)}</p>
      <label class="field"><input id="capInput" maxlength="40" placeholder="Add a caption (optional)"></label>
      <label style="display:flex;gap:10px;align-items:center;justify-content:center;margin-bottom:16px;font-size:14px;font-weight:600">
        <input type="checkbox" id="shareChk" checked style="width:20px;height:20px;accent-color:var(--orange)"> Share in the group gallery
      </label>
      <div class="btns">
        <button class="btn btn-primary btn-block" id="confirmUp">Upload · +${pts} points</button>
        <button class="btn btn-outline btn-block" id="cancelUp">Cancel</button>
      </div>`);
    $("#cancelUp").onclick = closeModal;
    $("#confirmUp").onclick = async () => {
      const btn = $("#confirmUp"); btn.disabled = true; btn.textContent = "Uploading…";
      const shared = $("#shareChk").checked, caption = $("#capInput").value.trim();
      const wasL2Locked = CONFIG.lockLevels && level1Done() < CONFIG.level2Unlock;
      const streakBefore = streak();
      state.visits[id] = { photo: data, ts: Date.now(), verified, shared, caption };
      if (!save()) { state.visits[id].photo = null; save(); }
      if (LIVE) {
        try { await pushVisit(id, data); }
        catch (err) { console.warn(err); toast("Saved on your phone – sharing failed. We'll retry next time you open the app."); }
      }
      closeModal(); confetti(); refreshMarkers(); updateScore();
      renderPlace(id);
      if (wasL2Locked && level1Done() >= CONFIG.level2Unlock) {
        setTimeout(() => {
          openModal(`<div class="m-ic">${ic("unlock")}</div><h2>Level 2 unlocked!</h2><p>Nice! You visited ${CONFIG.level2Unlock} Level 1 places. ${PLACES.filter((x) => x.level === 2).length} new places are waiting for you.</p><div class="btns"><a class="btn btn-primary btn-block" href="#/quests" id="toQuests">Go to quests</a></div>`);
          $("#toQuests").onclick = closeModal;
        }, 900);
      } else {
        const st = streak();
        toast(!streakBefore.thisWeek && st.n > 1 ? `Streak: ${st.n} weeks in a row! +${pts} points` : `Gallery unlocked! +${pts} points`);
      }
    };
  }

  // ---------- Quests page ----------
  function renderQuests() {
    const total = PLACES.length, visited = PLACES.filter((p) => isVisited(p.id)).length;
    const st = streak(), wk = weekVisits(), l1 = level1Done();
    const levelBlock = (lvl) => {
      const list = PLACES.filter((p) => p.level === lvl);
      const done = list.filter((p) => isVisited(p.id)).length;
      const locked = CONFIG.lockLevels && lvl > 1 && l1 < CONFIG.level2Unlock;
      return `<div class="level ${locked ? "locked" : ""}">
        <div class="level-head"><h2><span class="level-badge">${locked ? ic("lock", "ic-sm") : lvl}</span>Level ${lvl}</h2><small>${done}/${list.length}</small></div>
        ${locked
          ? `<div class="level-lock">${ic("lock")}<span><b>${plural(CONFIG.level2Unlock - l1, "more place", "more places")}</b> from Level 1 to unlock</span></div>`
          : `<div class="progress dark" style="margin-bottom:12px"><i style="width:${(done / list.length) * 100}%"></i></div>`}
        <div class="place-list">${list.map((p) => {
          const { avg, count } = avgRating(p.id), c = CATEGORIES[p.cat], n = visitorsOf(p.id).length, vis = state.visits[p.id];
          return `<a class="place-row" href="#/place/${p.id}">
            <div class="pr-thumb ph" data-thumb="${p.id}">${thumbHTML(p)}</div>
            <div class="pr-body"><b>${esc(p.name)}</b>
              <small>${c.label} · ${count ? `★ ${avg.toFixed(1)}` : "new"} · ${n ? `${n} visited` : "nobody yet"}${userPos ? ` · ${fmtDist(distTo(p))}` : ""}</small></div>
            <div class="pr-state ${vis ? "done" : ""}">${vis ? ic("check") : "+" + CONFIG.points.visit}</div>
          </a>`;
        }).join("")}</div></div>`;
    };
    $("#view-quests").innerHTML = `
      <div class="page-head"><h1>Your quests</h1><p>Visit places, collect points, keep your weekly streak.</p></div>
      <div class="page-pad">
        <div class="hero-card">
          <div class="hc-label">Places discovered</div>
          <div class="hc-big">${visited}<small> / ${total}</small></div>
          <div class="progress"><i style="width:${(visited / total) * 100}%"></i></div>
          <div class="hc-row"><span>${myPoints()} points</span><span>${visited === total ? "All discovered!" : `${total - visited} to go`}</span></div>
        </div>
        <div class="mini-cards">
          <div class="mini-card ${st.n && !st.thisWeek ? "warn" : ""}">
            <div class="mc-ic">${tile("flame", "#E5746A")}</div><b>${plural(st.n, "week", "weeks")}</b>
            <small>${st.n && !st.thisWeek ? "Visit a place this week or you'll lose your streak!" : st.thisWeek ? "Streak secured for this week" : "Start your streak this week"}</small>
          </div>
          <div class="mini-card">
            <div class="mc-ic">${tile("pin", "var(--orange)")}</div><b>${PLACES.filter((p) => isVisited(p.id) && state.visits[p.id].verified).length}</b>
            <small>visits verified on site</small>
          </div>
        </div>
        <div class="challenge">
          <div class="ch-ic">${tile("timer", "#E7A417", "lg")}</div>
          <div><b>Weekly streak</b><small>${st.thisWeek ? `This week is done · ${plural(wk, "place", "places")} visited` : st.n ? `1 place before Sunday keeps your ${st.n}-week streak` : "Visit 1 place a week to build a streak"}</small></div>
          <div class="timer">${st.thisWeek ? "Done" : countdown(endOfWeek())}<small>${st.thisWeek ? "" : "left"}</small></div>
        </div>
        ${levelBlock(1)}
        ${levelBlock(2)}
      </div>`;
  }

  // ---------- Profile page ----------
  function renderProfile() {
    const u = state.user, visited = PLACES.filter((p) => isVisited(p.id));
    const rated = Object.keys(state.ratings).length;
    const board = community.users.map((x) => ({ ...x })).concat([{ name: u.name, color: u.color, flag: "", points: myPoints(), me: true }])
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)); // ranked by points
    const myRank = board.findIndex((b) => b.me) + 1;
    const above = board[myRank - 2];
    const photos = visited.filter((p) => state.visits[p.id].photo);
    const shown = board.slice(0, 15);
    if (!shown.some((b) => b.me)) shown.push(board[myRank - 1]);

    $("#view-profile").innerHTML = `
      <div class="page-head"><h1>Profile</h1><p>Your Erasmus adventures in Funchal</p></div>
      <div class="page-pad">
        <div class="profile-card">
          ${avatarHTML(u.name, u.color, "lg")}
          <div><h2>${esc(u.name)}</h2><small>Rank ${myRank} of ${board.length} in your group</small></div>
        </div>
        <div class="stats">
          <div class="stat"><b>${myPoints()}</b><small>Points</small></div>
          <div class="stat"><b>${visited.length}</b><small>Places</small></div>
          <div class="stat"><b>${rated}</b><small>Ratings</small></div>
        </div>

        <div class="section-title">Leaderboard <small>${LIVE ? `<span class="live-dot"></span>live` : "demo"}</small></div>
        ${board.length < 2
          ? `<div class="social-proof">${ic("users")}<span>You're the first one here – <b>share the link</b> with your Erasmus group!</span></div>`
          : above
            ? `<div class="social-proof">${ic("target")}<span>Only <b>${plural(above.points - myPoints() + 1, "point", "points")}</b> until you overtake ${esc(above.name)}!</span></div>`
            : `<div class="social-proof">${ic("award")}<span><b>You're #1!</b> Keep going to stay on top.</span></div>`}
        <div class="leader">${shown.map((b) => { const i = board.indexOf(b); return `<div class="leader-row ${b.me ? "me" : ""}"><span class="rank">${i + 1}</span>${avatarHTML(b.name, b.color)}<span class="who">${esc(b.name)} ${esc(b.flag || "")}${b.me ? " (you)" : ""}</span><span class="pts">${Number(b.points) || 0}</span></div>`; }).join("")}</div>


        <div class="section-title">My photos <small>${photos.length}</small></div>
        ${photos.length ? `<div class="my-photos">${photos.map((p) => `<a class="ph" href="#/place/${p.id}"><img src="${state.visits[p.id].photo}" alt="${esc(p.name)}"></a>`).join("")}</div>` : `<div class="empty">No photos yet. Pick a place on the map!</div>`}

        ${state.favorites.length ? `<div class="section-title">Saved <small>${state.favorites.length}</small></div><div class="place-list">${state.favorites.map(byId).filter(Boolean).map((p) => `<a class="place-row" href="#/place/${p.id}"><div class="pr-thumb ph" data-thumb="${p.id}">${thumbHTML(p)}</div><div class="pr-body"><b>${esc(p.name)}</b><small>${CATEGORIES[p.cat].label}</small></div><div class="pr-state ${isVisited(p.id) ? "done" : ""}">${ic(isVisited(p.id) ? "check" : "arrow")}</div></a>`).join("")}</div>` : ""}

        <div class="section-title">Appearance</div>
        <div class="seg" id="themeSeg">${[["auto", "auto", "Auto"], ["light", "sun", "Light"], ["dark", "moon", "Dark"]].map(([k, i, l]) => `<button data-theme-opt="${k}" class="${(state.theme || "auto") === k ? "on" : ""}">${ic(i)}${l}</button>`).join("")}</div>

        <div class="section-title">Settings</div>
        <div class="settings">
          <button id="geoSet"><span>${ic("pin")} Location ${userPos ? "on" : "– turn on"}</span><span>${ic(userPos ? "check" : "arrow")}</span></button>
          <button id="renameSet"><span>${ic("pencil")} Change name</span><span>${ic("arrow")}</span></button>
          <button id="resetSet" class="danger"><span>${ic("trash")} Reset progress</span><span>${ic("arrow")}</span></button>
        </div>
        <p class="note">Fair &amp; honest: you can only rate a place after uploading a photo there. Your location is only used on your phone to show distances and verify visits – it's never uploaded.${LIVE ? "" : " (Prototype: the other students are example data.)"}</p>
      </div>`;
    $("#geoSet").onclick = () => startGeo(true);
    $("#themeSeg").onclick = (e) => {
      const b = e.target.closest("[data-theme-opt]"); if (!b) return;
      state.theme = b.dataset.themeOpt; save(); applyTheme();
      keepScroll("#view-profile", renderProfile);
    };
    $("#renameSet").onclick = () => {
      openModal(`<div class="m-ic">${ic("pencil")}</div><h2>New name</h2><label class="field"><input id="newName" maxlength="20" value="${esc(u.name)}"></label><div class="btns"><button class="btn btn-primary btn-block" id="saveName">Save</button></div>`);
      $("#saveName").onclick = () => { const n = $("#newName").value.trim(); if (n) { state.user.name = n; save(); syncUser(); } closeModal(); renderProfile(); };
    };
    $("#resetSet").onclick = () => {
      openModal(`<div class="m-ic danger">${ic("alert")}</div><h2>Reset everything?</h2><p>All your visits, photos and points will be deleted${LIVE ? " – also from the group gallery" : ""}.</p><div class="btns"><button class="btn btn-primary btn-block" id="doReset" style="background:#D33;box-shadow:none">Yes, delete everything</button><button class="btn btn-outline btn-block" id="noReset">Cancel</button></div>`);
      $("#noReset").onclick = closeModal;
      $("#doReset").onclick = async () => {
        $("#doReset").disabled = true;
        await deleteMyData();
        localStorage.removeItem(STORE_KEY); location.hash = ""; location.reload();
      };
    };
  }

  // ---------- Router ----------
  function updateScore() { $("#scorePill").innerHTML = `${ic("star", "ic-fill")}${myPoints()}`; }
  function show(viewId) { ["view-map", "view-place", "view-quests", "view-profile"].forEach((v) => ($("#" + v).hidden = v !== viewId)); }
  function route() {
    if (!state.user) return;
    const h = location.hash || "#/map";
    const [, page, arg] = h.split("/");
    document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (page || "map")));
    if (page === "place") { show("view-place"); renderPlace(arg); $("#view-place").scrollTop = 0; }
    else if (page === "quests") { show("view-quests"); renderQuests(); $("#view-quests").scrollTop = 0; }
    else if (page === "profile") { show("view-profile"); renderProfile(); $("#view-profile").scrollTop = 0; }
    else { show("view-map"); if (mapApi) setTimeout(() => mapApi.resize(), 0); }
    prevRoute = lastRoute; lastRoute = h;
  }

  // ---------- Boot ----------
  function startApp() {
    $("#onboarding").hidden = true;
    $("#tabbar").hidden = false;
    $("#brandSmall").innerHTML = `${LOGO}<div>Madeira <span>Quest</span></div>`;
    show("view-map"); // map container must be visible before Leaflet measures it
    if (!mapInited) { mapInited = true; initMap(); }
    updateScore();
    route();
    syncUser();
    if (state.geoAsked && navigator.permissions) {
      navigator.permissions.query({ name: "geolocation" }).then((r) => { if (r.state === "granted") startGeo(false); }).catch(() => {});
    }
  }

  function boot() {
    applyTheme();
    // broken images (e.g. a missing photo file) simply disappear – no inline handlers needed (CSP)
    document.addEventListener("error", (e) => { const t = e.target; if (t && t.matches && t.matches("img[data-fallback]")) t.remove(); }, true);
    $("#obLogo").innerHTML = LOGO;
    document.querySelectorAll("[data-ic]").forEach((el) => (el.innerHTML = ic(el.dataset.ic)));
    document.querySelectorAll("[data-tile]").forEach((el) => (el.outerHTML = tile(el.dataset.tile, el.dataset.color || (el.classList.contains("nav-t") ? null : "var(--orange)"), el.className)));
    $("#fileInput").addEventListener("change", onFileChosen);
    window.addEventListener("hashchange", route);

    if (LIVE) {
      initFirebase().catch((e) => { console.error(e); toast("Offline – couldn't connect to the group. Your progress is saved on your phone."); });
    } else {
      buildDemoCommunity();
    }

    if (state.user) { startApp(); return; }

    $("#onboarding").hidden = false;
    const go = () => {
      const name = $("#obName").value.trim();
      if (!name) { $("#obName").focus(); toast("What should the others call you?"); return; }
      const colors = ["#1D6FE8", "#1E7FA8", "#5E7B3A", "#8E2C48", "#E5746A", "#0E2A47", "#C8642E", "#3D8C8C"];
      state.user = { name, color: colors[Math.floor(Math.random() * colors.length)] };
      save();
      location.hash = "#/map";
      startApp();
      setTimeout(() => {
        openModal(`<div class="m-ic">${ic("pin")}</div><h2>Allow location?</h2><p>We'll show how far away each place is, and we can mark your visits as <b>verified on site</b>.</p><div class="btns"><button class="btn btn-primary btn-block" id="geoYes">Allow location</button><button class="btn btn-outline btn-block" id="geoNo">Later</button></div>`);
        $("#geoYes").onclick = () => { closeModal(); startGeo(true); };
        $("#geoNo").onclick = () => { closeModal(); state.geoAsked = true; save(); };
      }, 500);
    };
    $("#obStart").onclick = go;
    $("#obName").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
