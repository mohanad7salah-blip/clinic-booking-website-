/* =========================================================
   Booking wizard — talks ONLY to the backend booking API.
   - Availability is always fetched from the server (Asia/Baghdad, authoritative).
   - Every submission carries an Idempotency-Key; the key is persisted in
     sessionStorage so a refresh / retry re-sends the SAME key and the server
     returns the original booking instead of creating a new one.
   - No booking is ever "confirmed" client-side. If the API is unreachable the
     patient is told so and offered call / WhatsApp instead.
   ========================================================= */
(function () {
  "use strict";
  const PENDING_KEY = "alz_pending_booking";
  const App = window.App;
  let els = {};
  const state = {
    step: 1,
    service: null,       // slug
    date: null,          // YYYY-MM-DD (clinic-local)
    time: null,          // HH:MM (clinic-local)
    config: null,        // /api/public-config response
    calendar: null,      // [{date, open, available}]
    slots: null,
    submitting: false,
    result: null
  };

  /* ---------------- API client ---------------- */
  class ApiError extends Error {
    constructor(code, status, data) { super(code); this.code = code; this.status = status; this.data = data || {}; }
  }
  async function api(path, opts) {
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await fetch(App.apiUrl(path), Object.assign({ headers: { "Accept": "application/json" }, credentials: "omit", signal: ctrl.signal }, opts || {}));
    } catch (e) {
      throw new ApiError("NETWORK", 0);
    } finally { clearTimeout(timer); }
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) { try { data = await res.json(); } catch (e) { data = null; } }
    if (!data && !res.ok) throw new ApiError(res.status === 404 ? "API_UNAVAILABLE" : "SERVER", res.status);
    if (!data) throw new ApiError("API_UNAVAILABLE", res.status); // e.g. static host returned HTML
    if (!res.ok) throw new ApiError(data.error || "SERVER", res.status, data);
    return data;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return [...b].map((x, i) => ([4, 6, 8, 10].includes(i) ? "-" : "") + x.toString(16).padStart(2, "0")).join("");
  }

  /* ---------------- Helpers ---------------- */
  const t = (k) => App.t(k);
  const esc = App.esc;
  function serviceBySlug(slug) {
    const local = App.services.find(s => s.slug === slug);
    const remote = state.config?.services?.find(s => s.slug === slug);
    if (!local && !remote) return null;
    return Object.assign({}, local || {}, remote || {});
  }
  function serviceName(slug) { const s = serviceBySlug(slug); return s ? App.field(s, "name") : slug; }

  /** Iraqi mobile normalisation (mirror of server rule; server re-validates). */
  function normalizeIraqiPhone(raw) {
    let d = String(raw || "").replace(/[\u0660-\u0669]/g, c => c.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, c => c.charCodeAt(0) - 0x06F0);
    d = d.replace(/[\s\-().]/g, "");
    if (d.startsWith("+")) d = d.slice(1);
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("964")) d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
    if (!/^7\d{9}$/.test(d)) return null;
    return "+964" + d;
  }

  function showAlert(kind, msg, withContact, retryFn) {
    const a = els.alert;
    a.className = "booking-alert " + kind;
    let html = `<i class="fa-solid ${kind === "error" ? "fa-circle-exclamation" : "fa-triangle-exclamation"}" aria-hidden="true"></i><span>${esc(msg)}</span>`;
    const actions = [];
    if (retryFn) actions.push(`<button type="button" class="btn btn-outline" data-alert-retry>${esc(t("err.retry"))}</button>`);
    if (withContact) {
      actions.push(`<a class="btn btn-outline" href="tel:${window.CLINIC_CONFIG.clinic.phone_e164}">${esc(t("cta.call"))}</a>`);
      actions.push(`<a class="btn btn-outline" target="_blank" rel="noopener" href="${App.waLink()}">${esc(t("cta.whatsapp"))}</a>`);
    }
    if (actions.length) html += `<span class="alert-actions">${actions.join("")}</span>`;
    a.innerHTML = html;
    a.hidden = false;
    if (retryFn) a.querySelector("[data-alert-retry]").addEventListener("click", () => { hideAlert(); retryFn(); });
  }
  function hideAlert() { els.alert.hidden = true; els.alert.innerHTML = ""; }
  function errorMessage(err) {
    switch (err.code) {
      case "SLOT_UNAVAILABLE": return t("err.slotTaken");
      case "INVALID_SLOT": return t("err.invalidSlot");
      case "RATE_LIMITED": return t("err.rate");
      case "NETWORK": case "API_UNAVAILABLE": return t("err.offline");
      default: return t("err.generic");
    }
  }
  function setFieldError(id, key) {
    const p = document.getElementById("err-" + id);
    const input = document.getElementById("bk-" + id);
    if (!p) return;
    if (key) { p.textContent = t(key); p.hidden = false; if (input) input.setAttribute("aria-invalid", "true"); }
    else { p.hidden = true; p.textContent = ""; if (input) input.removeAttribute("aria-invalid"); }
  }

  /* ---------------- Rendering ---------------- */
  function renderStepper() {
    els.stepper.querySelectorAll("li").forEach(li => {
      const n = +li.dataset.step;
      li.classList.toggle("done", n < state.step);
      li.classList.toggle("current", n === state.step);
      if (n === state.step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }

  function renderServiceOptions() {
    const list = App.services.filter(s => {
      const remote = state.config?.services?.find(r => r.slug === s.slug);
      return !state.config || (remote && remote.active);
    });
    els.serviceOptions.innerHTML = list.map(s => `
      <label class="opt-card">
        <input type="radio" name="service" value="${s.slug}" ${state.service === s.slug ? "checked" : ""}>
        <i class="fa-solid ${s.icon}" aria-hidden="true"></i>
        <span class="opt-label">${esc(App.field(s, "name"))}</span>
      </label>`).join("");
  }

  function renderCalendar() {
    const strip = els.dateStrip;
    if (!state.calendar) {
      strip.innerHTML = Array.from({ length: 8 }, () => `<div class="skeleton" style="height:76px"></div>`).join("");
      return;
    }
    const locale = App.lang === "ar" ? "ar-IQ-u-nu-latn" : "en-GB";
    strip.innerHTML = state.calendar.map(d => {
      const [y, m, dd] = d.date.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, dd, 12));
      const dow = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(dt);
      const mon = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" }).format(dt);
      const disabled = !d.open || d.available === 0;
      const full = App.formatDate(d.date);
      return `<label class="date-chip ${disabled ? "closed" : ""}" title="${esc(full)}">
        <input type="radio" name="date" value="${d.date}" ${state.date === d.date ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${esc(full)}${disabled ? " — " + esc(d.open ? t("booking.noSlots") : t("booking.closed")) : ""}">
        <span class="dc-dow">${esc(dow)}</span><span class="dc-day">${dd}</span><span class="dc-mon">${esc(mon)}</span>
        ${disabled ? `<span class="dc-closed">${esc(d.open ? "—" : t("hours.closed"))}</span>` : ""}
      </label>`;
    }).join("");
  }

  function renderSlots(loading) {
    const g = els.slotGrid;
    els.timeContext.textContent = state.date ? serviceName(state.service) + " · " + App.formatDate(state.date) : "";
    if (loading) {
      g.setAttribute("aria-busy", "true");
      g.innerHTML = `<p class="slot-state"><span class="spinner" style="border-color:#cfd8d6;border-top-color:var(--c-primary)"></span>${esc(t("booking.loadingSlots"))}</p>` + Array.from({ length: 6 }, () => `<div class="skeleton"></div>`).join("");
      return;
    }
    g.removeAttribute("aria-busy");
    if (!state.date) { g.innerHTML = `<p class="slot-state">${esc(t("booking.pickDateFirst"))}</p>`; return; }
    if (!state.slots) { g.innerHTML = ""; return; }
    if (!state.slots.length) { g.innerHTML = `<p class="slot-state"><i class="fa-regular fa-calendar-xmark" aria-hidden="true"></i>${esc(t("booking.noSlots"))}</p>`; return; }
    g.innerHTML = state.slots.map(s => `<label class="slot"><input type="radio" name="time" value="${s}" ${state.time === s ? "checked" : ""}><span dir="ltr">${esc(App.formatTime(s))}</span></label>`).join("");
  }

  function reviewRows(extra) {
    const f = formValues();
    const c = window.CLINIC_CONFIG.clinic;
    const rows = [
      ["booking.rv.name", esc(f.name)],
      ["booking.rv.phone", `<span dir="ltr">${esc(normalizeIraqiPhone(f.phone) || f.phone)}</span>`],
      ["booking.rv.service", esc(serviceName(state.service))],
      ["booking.rv.date", esc(App.formatDate(state.date))],
      ["booking.rv.time", `<span dir="ltr">${esc(App.formatTime(state.time))}</span> <small style="font-weight:400;color:var(--c-muted)">(Asia/Baghdad)</small>`],
      ["booking.rv.clinic", esc(App.lang === "ar" ? c.name_ar : c.name_en) + "<br><small style=\"font-weight:400;color:var(--c-muted)\">" + esc(App.lang === "ar" ? c.address_ar : c.address_en) + " · <span dir=\"ltr\">" + esc(c.phone_display) + "</span></small>"]
    ];
    return (extra || rows).map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`).join("");
  }
  function renderReview() { els.reviewList.innerHTML = reviewRows(); }

  function renderStep() {
    els.form.querySelectorAll(".booking-step").forEach(fs => { fs.hidden = +fs.dataset.step !== state.step; });
    els.back.hidden = state.step === 1;
    els.next.hidden = state.step === 5;
    els.confirm.hidden = state.step !== 5;
    renderStepper();
    if (state.step === 5) renderReview();
  }

  function renderSuccess() {
    const r = state.result;
    els.form.hidden = true; els.stepper.hidden = true; hideAlert();
    els.success.hidden = false;
    els.successRef.textContent = r.reference;
    els.successTest.hidden = r.environment !== "test";
    const rows = [
      ["booking.rv.service", esc(serviceName(r.service))],
      ["booking.rv.date", esc(App.formatDate(r.date))],
      ["booking.rv.time", `<span dir="ltr">${esc(App.formatTime(r.start_time))}</span> <small style="font-weight:400;color:var(--c-muted)">(Asia/Baghdad)</small>`],
      ["location.address", esc(App.lang === "ar" ? window.CLINIC_CONFIG.clinic.address_ar : window.CLINIC_CONFIG.clinic.address_en)]
    ];
    els.successList.innerHTML = reviewRows(rows) + `<dt>${esc(t("booking.rv.clinic"))}</dt><dd>${esc(t("booking.statusPending"))}</dd>`;
    const configured = r.notification && r.notification.whatsapp_configured;
    els.successWa.innerHTML = configured
      ? `<i class="fa-brands fa-whatsapp" aria-hidden="true"></i> ${esc(t("booking.waProcessing"))}`
      : `<i class="fa-regular fa-circle-check" aria-hidden="true"></i> ${esc(t("booking.waNotConfigured"))}`;
  }

  /* ---------------- Data loading ---------------- */
  async function loadConfig() {
    try {
      state.config = await api("/api/public-config");
      if (state.config.hours) App.setRemoteHours(state.config.hours);
      renderServiceOptions();
      return true;
    } catch (e) {
      state.config = null;
      return false;
    }
  }

  async function loadCalendar() {
    state.calendar = null; renderCalendar();
    try {
      const data = await api(`/api/availability/calendar?service=${encodeURIComponent(state.service)}`);
      state.calendar = data.days;
      if (state.date && !state.calendar.some(d => d.date === state.date && d.open && d.available > 0)) state.date = null;
      renderCalendar();
    } catch (e) {
      els.dateStrip.innerHTML = "";
      showAlert("error", errorMessage(e), true, () => loadCalendar());
      throw e;
    }
  }

  async function loadSlots() {
    state.slots = null; renderSlots(true);
    try {
      const data = await api(`/api/availability?service=${encodeURIComponent(state.service)}&date=${state.date}`);
      state.slots = data.slots || [];
      if (state.time && !state.slots.includes(state.time)) state.time = null;
      renderSlots(false);
    } catch (e) {
      state.slots = []; renderSlots(false);
      showAlert("error", errorMessage(e), true, () => loadSlots());
    }
  }

  /* ---------------- Validation ---------------- */
  function formValues() {
    return {
      name: els.form.name.value.trim(),
      phone: els.form.phone.value.trim(),
      email: els.form.email.value.trim(),
      notes: els.form.notes.value.trim(),
      company: els.form.company.value
    };
  }
  function validateDetails() {
    const f = formValues();
    let firstBad = null;
    const nameOk = f.name.replace(/\s+/g, " ").length >= 2 && f.name.length <= 80;
    setFieldError("name", nameOk ? null : (f.name ? "err.name" : "err.required"));
    if (!nameOk) firstBad = firstBad || "bk-name";
    const phoneOk = !!normalizeIraqiPhone(f.phone);
    setFieldError("phone", phoneOk ? null : (f.phone ? "err.phone" : "err.required"));
    if (!phoneOk) firstBad = firstBad || "bk-phone";
    const emailOk = !f.email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email);
    setFieldError("email", emailOk ? null : "err.email");
    if (!emailOk) firstBad = firstBad || "bk-email";
    if (firstBad) document.getElementById(firstBad).focus();
    return !firstBad;
  }

  /* ---------------- Navigation ---------------- */
  async function goNext() {
    hideAlert();
    if (state.step === 1) {
      if (!state.service) { setFieldError("service", "err.service"); return; }
      setFieldError("service", null);
      App.track("booking_started", { service: state.service });
      state.step = 2; renderStep();
      if (!state.config) await loadConfig();
      loadCalendar().catch(() => {});
    } else if (state.step === 2) {
      if (!state.date) { setFieldError("date", "err.date"); return; }
      setFieldError("date", null);
      state.step = 3; renderStep(); loadSlots();
    } else if (state.step === 3) {
      if (!state.time) { setFieldError("time", "err.time"); return; }
      setFieldError("time", null);
      state.step = 4; renderStep();
      setTimeout(() => els.form.name.focus(), 50);
    } else if (state.step === 4) {
      if (!validateDetails()) return;
      state.step = 5; renderStep();
    }
    scrollToCard();
  }
  function goBack() {
    hideAlert();
    if (state.step > 1) { state.step--; renderStep(); scrollToCard(); }
  }
  function scrollToCard() {
    const top = els.card.getBoundingClientRect().top + window.scrollY - 80;
    if (Math.abs(window.scrollY - top) > 120) window.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /* ---------------- Submission (idempotent) ---------------- */
  function buildPayload() {
    const f = formValues();
    return {
      service: state.service, date: state.date, time: state.time,
      name: f.name, phone: f.phone, email: f.email || null, notes: f.notes || null,
      lang: App.lang, company: f.company
    };
  }
  function payloadFingerprint(p) { return [p.service, p.date, p.time, normalizeIraqiPhone(p.phone), p.name].join("|"); }

  function getIdempotencyKey(payload) {
    const fp = payloadFingerprint(payload);
    try {
      const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
      if (saved && saved.fp === fp && saved.key) return saved.key;
    } catch (e) { /* ignore */ }
    const key = uuid();
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ key, fp, payload, at: Date.now() })); } catch (e) { /* ignore */ }
    return key;
  }

  function setSubmitting(on) {
    state.submitting = on;
    els.confirm.disabled = on; els.back.disabled = on;
    els.confirm.setAttribute("aria-busy", on ? "true" : "false");
    els.confirm.innerHTML = on
      ? `<span class="spinner" aria-hidden="true"></span><span class="btn-label">${esc(t("booking.submitting"))}</span>`
      : `<span class="btn-label">${esc(t("booking.confirm"))}</span>`;
  }

  async function submit(payload, key) {
    if (state.submitting) return;
    setSubmitting(true); hideAlert();
    try {
      const data = await api("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(payload)
      });
      try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
      state.result = data.booking;
      App.track("booking_completed", { service: payload.service });
      renderSuccess();
      els.success.focus();
      scrollToCard();
    } catch (e) {
      if (e.code === "SLOT_UNAVAILABLE" || e.code === "INVALID_SLOT") {
        try { sessionStorage.removeItem(PENDING_KEY); } catch (x) { /* ignore */ }
        state.time = null;
        state.step = 3; renderStep();
        showAlert("error", errorMessage(e));
        loadSlots();
      } else if (e.code === "VALIDATION" && e.data.fields) {
        try { sessionStorage.removeItem(PENDING_KEY); } catch (x) { /* ignore */ }
        state.step = 4; renderStep();
        Object.keys(e.data.fields).forEach(k => setFieldError(k, "err." + (e.data.fields[k] || "required")));
        showAlert("error", t("err.generic"));
      } else {
        // Temporary failure: keep ALL entered data and the SAME idempotency key → safe retry.
        showAlert("error", errorMessage(e), e.code === "NETWORK" || e.code === "API_UNAVAILABLE", () => submit(payload, key));
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** On page load: if a submission was in-flight when the page was refreshed, re-send it with the same key. */
  async function resumePending() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch (e) { /* ignore */ }
    if (!saved || !saved.payload || Date.now() - saved.at > 30 * 60 * 1000) { try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ } return; }
    const p = saved.payload;
    state.service = p.service; state.date = p.date; state.time = p.time;
    els.form.name.value = p.name || ""; els.form.phone.value = p.phone || "";
    els.form.email.value = p.email || ""; els.form.notes.value = p.notes || "";
    renderServiceOptions();
    state.step = 5; renderStep();
    await submit(p, saved.key);
  }

  function reset() {
    state.step = 1; state.service = null; state.date = null; state.time = null; state.slots = null; state.calendar = null; state.result = null;
    els.form.reset();
    els.form.hidden = false; els.stepper.hidden = false; els.success.hidden = true;
    renderServiceOptions(); renderStep(); scrollToCard();
  }

  /* ---------------- Init ---------------- */
  function init() {
    els = {
      card: document.getElementById("booking-app"),
      form: document.getElementById("booking-form"),
      stepper: document.getElementById("booking-stepper"),
      alert: document.getElementById("booking-alert"),
      serviceOptions: document.getElementById("service-options"),
      dateStrip: document.getElementById("date-strip"),
      slotGrid: document.getElementById("slot-grid"),
      timeContext: document.getElementById("time-context"),
      reviewList: document.getElementById("review-list"),
      back: document.getElementById("bk-back"),
      next: document.getElementById("bk-next"),
      confirm: document.getElementById("bk-confirm"),
      success: document.getElementById("booking-success"),
      successRef: document.getElementById("success-ref"),
      successList: document.getElementById("success-list"),
      successWa: document.getElementById("success-wa"),
      successTest: document.getElementById("success-test-badge")
    };
    if (!els.form) return;

    // Preselect service via ?service=slug (service detail pages) or card buttons
    const qs = new URLSearchParams(location.search).get("service");
    if (qs && App.services.some(s => s.slug === qs)) state.service = qs;

    renderServiceOptions(); renderStep(); setSubmitting(false);
    loadConfig();

    els.form.addEventListener("change", e => {
      const n = e.target.name;
      if (n === "service") {
        if (state.service !== e.target.value) { state.date = null; state.time = null; state.calendar = null; }
        state.service = e.target.value; setFieldError("service", null);
      }
      if (n === "date") { if (state.date !== e.target.value) state.time = null; state.date = e.target.value; setFieldError("date", null); }
      if (n === "time") { state.time = e.target.value; setFieldError("time", null); }
    });
    // Auto-advance on click for date/time (keyboard users still use Next)
    els.dateStrip.addEventListener("click", e => { if (e.target.matches("input[name=date]") && e.detail !== 0) setTimeout(goNext, 120); });
    els.slotGrid.addEventListener("click", e => { if (e.target.matches("input[name=time]") && e.detail !== 0) setTimeout(goNext, 120); });

    els.next.addEventListener("click", goNext);
    els.back.addEventListener("click", goBack);
    els.form.addEventListener("submit", e => {
      e.preventDefault();
      if (state.step !== 5 || state.submitting) return;
      const payload = buildPayload();
      submit(payload, getIdempotencyKey(payload));
    });
    document.getElementById("bk-new").addEventListener("click", reset);
    ["name", "phone", "email"].forEach(id => els.form[id].addEventListener("blur", () => {
      if (els.form[id].value) validateField(id);
    }));

    document.addEventListener("click", e => {
      const b = e.target.closest("[data-book-service]");
      if (!b) return;
      state.service = b.dataset.bookService; state.date = null; state.time = null; state.calendar = null;
      if (!els.success.hidden) { els.form.hidden = false; els.stepper.hidden = false; els.success.hidden = true; els.form.reset(); }
      state.step = 1; renderServiceOptions(); renderStep();
    });

    App.onLangChange(() => {
      renderServiceOptions();
      if (state.calendar) renderCalendar();
      if (state.step === 3) renderSlots(false);
      renderStep();
      if (!state.submitting) setSubmitting(false);
      if (state.result) renderSuccess();
    });

    resumePending();
  }
  function validateField(id) {
    const f = formValues();
    if (id === "name") setFieldError("name", f.name.length >= 2 ? null : "err.name");
    if (id === "phone") setFieldError("phone", normalizeIraqiPhone(f.phone) ? null : "err.phone");
    if (id === "email") setFieldError("email", !f.email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email) ? null : "err.email");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
