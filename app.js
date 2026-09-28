/* =========================================================
   Core site script: i18n, navigation, services, location, reveal, analytics hooks
   Exposes window.App for booking.js and service pages.
   ========================================================= */
(function () {
  "use strict";
  const CFG = window.CLINIC_CONFIG;
  const DICT = window.I18N;
  const SERVICES = window.CLINIC_SERVICES || [];
  const CATS = window.CLINIC_CATEGORIES || [];
  const LANG_KEY = "alz_lang";
  const listeners = [];
  document.documentElement.classList.remove("no-js");

  /* ---------- Language ---------- */
  function initialLang() {
    const qp = new URLSearchParams(location.search).get("lang");
    if (qp === "ar" || qp === "en") return qp;
    try { const s = localStorage.getItem(LANG_KEY); if (s === "ar" || s === "en") return s; } catch (e) { /* storage blocked */ }
    return "ar";
  }
  let lang = initialLang();

  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) ?? (DICT.ar[key] ?? key);
    if (vars) Object.keys(vars).forEach(k => { s = s.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]); });
    return s;
  }
  function field(obj, base) { return obj[base + "_" + lang] ?? obj[base + "_ar"]; }

  function applyI18n(root) {
    (root || document).querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    (root || document).querySelectorAll("[data-i18n-attr]").forEach(el => {
      el.dataset.i18nAttr.split(";").forEach(pair => {
        const [attr, key] = pair.split(":").map(s => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
  }

  function setLang(next, persist) {
    lang = next;
    const html = document.documentElement;
    html.lang = lang;
    html.dir = lang === "ar" ? "rtl" : "ltr";
    if (persist) { try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ } }
    // Page-level meta (service pages override via data attributes on <body>)
    const b = document.body;
    const titleKey = b.dataset.titleKey || "meta.title";
    const descKey = b.dataset.descKey || "meta.description";
    document.title = b.dataset["title" + (lang === "ar" ? "Ar" : "En")] || t(titleKey);
    const md = document.querySelector('meta[name="description"]');
    if (md) md.setAttribute("content", b.dataset["desc" + (lang === "ar" ? "Ar" : "En")] || t(descKey));
    const langBtn = document.getElementById("lang-toggle");
    if (langBtn) langBtn.setAttribute("lang", lang === "ar" ? "en" : "ar");
    applyI18n();
    renderDynamic();
    listeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
  }

  /* ---------- Helpers ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function waLink(text) {
    const base = "https://wa.me/" + CFG.clinic.whatsapp_digits;
    return text ? base + "?text=" + encodeURIComponent(text) : base;
  }
  function directionsLink() { return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(CFG.clinic.maps_query); }
  function mapEmbed() { return CFG.clinic.map_embed_url || ("https://maps.google.com/maps?q=" + encodeURIComponent(CFG.clinic.maps_query) + "&z=15&output=embed&hl=" + lang); }
  function formatTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const h12 = ((h + 11) % 12) + 1;
    return h12 + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? t("am") : t("pm"));
  }
  /** Format a clinic-local YYYY-MM-DD for display without shifting through the browser timezone. */
  function formatDate(ymd, opts) {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat(lang === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", Object.assign({ timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }, opts || {})).format(dt);
  }

  /* ---------- Analytics hook (privacy-safe: no PII ever) ---------- */
  function track(event, props) {
    const safe = {};
    Object.keys(props || {}).forEach(k => { if (["service", "step", "lang", "source"].includes(k)) safe[k] = props[k]; });
    safe.lang = lang;
    if (window.dataLayer && Array.isArray(window.dataLayer)) window.dataLayer.push(Object.assign({ event }, safe));
    // No analytics provider is configured by default. Add one here if needed (never send PII).
  }
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-track]");
    if (el) track(el.dataset.track, { source: el.closest("section,header,nav,footer")?.id || "page" });
  });

  /* ---------- Dynamic sections ---------- */
  let activeFilter = "all";
  function renderServices() {
    const grid = document.getElementById("service-grid");
    const filters = document.getElementById("service-filters");
    if (!grid) return;
    if (filters) {
      const chips = [{ id: "all", label: t("services.all") }].concat(CATS.map(c => ({ id: c.id, label: field(c, "name") })));
      filters.innerHTML = chips.map(c => `<button type="button" class="filter-chip" data-filter="${c.id}" aria-pressed="${c.id === activeFilter}">${esc(c.label)}</button>`).join("");
    }
    const list = SERVICES.filter(s => activeFilter === "all" || s.category === activeFilter);
    const other = lang === "ar" ? "en" : "ar";
    grid.innerHTML = list.map(s => `
      <article class="service-card">
        <div class="service-icon" aria-hidden="true"><i class="fa-solid ${s.icon}"></i></div>
        <p class="service-cat">${esc(t("cat." + s.category))}</p>
        <h3>${esc(field(s, "name"))}</h3>
        <p class="service-alt" lang="${other}" dir="${other === "ar" ? "rtl" : "ltr"}">${esc(s["name_" + other])}</p>
        <p>${esc(field(s, "short"))}</p>
        <div class="service-actions">
          <a class="btn btn-ghost" href="services/${s.slug}.html" data-track="service_view">${esc(t("cta.learn"))}</a>
          <a class="btn btn-primary" href="#booking" data-book-service="${s.slug}" data-track="cta_book">${esc(t("cta.book"))}</a>
        </div>
      </article>`).join("");
  }

  function renderHours() {
    const table = document.getElementById("hours-table");
    if (!table) return;
    const hours = (App.remoteHours || CFG.clinic.hours_fallback);
    const order = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const todayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][baghdadNow().dow];
    table.querySelector("tbody").innerHTML = order.map(k => {
      const v = hours[k];
      let cell;
      if (v && v.length && typeof v[0] === "string") cell = `<span dir="ltr">${formatTime(v[0])} – ${formatTime(v[1])}</span>`;
      else if (v && v.length && Array.isArray(v[0])) cell = v.map(r => `<span dir="ltr">${formatTime(r[0])} – ${formatTime(r[1])}</span>`).join("<br>");
      else cell = `<span class="muted">${esc(App.remoteHours ? t("hours.closed") : t("hours.unconfirmed"))}</span>`;
      return `<tr class="${k === todayKey ? "today" : ""}"><th scope="row">${esc(t("hours." + k))}</th><td>${cell}</td></tr>`;
    }).join("");
  }

  function renderLocation() {
    const addr = lang === "ar" ? CFG.clinic.address_ar : CFG.clinic.address_en;
    const a = document.getElementById("address-text"); if (a) a.textContent = addr;
    const f = document.getElementById("footer-address"); if (f) f.textContent = addr;
    const d = document.getElementById("directions-link"); if (d) d.href = directionsLink();
    const map = document.getElementById("map-frame");
    if (map) {
      const src = mapEmbed();
      if (map.dataset.src !== src) { map.dataset.src = src; map.src = src; }
    }
    const greeting = lang === "ar" ? "مرحباً، أود الاستفسار عن موعد في عيادة الدكتور علي الزبيدي." : "Hello, I'd like to ask about an appointment at Dr. Ali Al-Zubaidi Dental Clinic.";
    document.querySelectorAll(".wa-link").forEach(el => { el.href = waLink(greeting); });
    const y = document.getElementById("year"); if (y) y.textContent = String(baghdadNow().year);
  }

  function renderDynamic() {
    renderServices();
    renderHours();
    renderLocation();
  }

  /** Current wall-clock in Asia/Baghdad (display only; server is authoritative). */
  function baghdadNow() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: CFG.clinic.timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const g = type => parts.find(p => p.type === type)?.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { year: +g("year"), month: +g("month"), day: +g("day"), dow: dowMap[g("weekday")], ymd: `${g("year")}-${g("month")}-${g("day")}` };
  }

  /* ---------- Header / nav ---------- */
  function initNav() {
    const header = document.getElementById("site-header");
    const nav = document.getElementById("main-nav");
    const toggle = document.getElementById("menu-toggle");
    const onScroll = () => header && header.classList.toggle("scrolled", window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

    function closeMenu() {
      if (!nav) return;
      nav.classList.remove("open"); document.body.classList.remove("menu-open");
      if (toggle) { toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", t("nav.menu")); }
    }
    if (toggle && nav) {
      toggle.addEventListener("click", () => {
        const open = !nav.classList.contains("open");
        nav.classList.toggle("open", open); document.body.classList.toggle("menu-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? t("nav.close") : t("nav.menu"));
        if (open) nav.querySelector("a")?.focus();
      });
      nav.addEventListener("click", e => { if (e.target.closest("a")) closeMenu(); });
      document.addEventListener("keydown", e => { if (e.key === "Escape" && nav.classList.contains("open")) { closeMenu(); toggle.focus(); } });
      window.addEventListener("resize", () => { if (window.innerWidth > 960) closeMenu(); });
    }
    const lt = document.getElementById("lang-toggle");
    if (lt) lt.addEventListener("click", () => setLang(lang === "ar" ? "en" : "ar", true));

    // Active section highlight
    const links = Array.from(document.querySelectorAll('.main-nav a[href^="#"]'));
    if ("IntersectionObserver" in window && links.length) {
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (en.isIntersecting) links.forEach(l => l.classList.toggle("active", l.getAttribute("href") === "#" + en.target.id));
        });
      }, { rootMargin: "-45% 0px -50% 0px" });
      links.forEach(l => { const s = document.querySelector(l.getAttribute("href")); if (s) io.observe(s); });
    }

    document.addEventListener("click", e => {
      const chip = e.target.closest(".filter-chip");
      if (chip) { activeFilter = chip.dataset.filter; renderServices(); }
    });
  }

  function initReveal() {
    const els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els.forEach(el => el.classList.add("visible")); return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("visible"); io.unobserve(en.target); } });
    }, { threshold: 0.08 });
    els.forEach(el => io.observe(el));
  }

  /* ---------- Public API ---------- */
  const App = window.App = {
    get lang() { return lang; },
    t, field, esc, formatTime, formatDate, baghdadNow, track, waLink, applyI18n,
    services: SERVICES,
    remoteHours: null,
    onLangChange(fn) { listeners.push(fn); },
    setRemoteHours(h) { App.remoteHours = h; renderHours(); },
    apiUrl(path) { return (CFG.API_BASE || "").replace(/\/$/, "") + path; }
  };

  document.addEventListener("DOMContentLoaded", () => {
    initNav();
    setLang(lang, false);
    initReveal();
  });
})();
