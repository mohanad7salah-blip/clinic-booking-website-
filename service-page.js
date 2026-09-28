/* Renders a service detail page from window.CLINIC_SERVICES using <body data-slug="...">.
   The static HTML already contains SEO-friendly Arabic content; this script localises
   and enriches it and re-renders on language change. */
(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", () => {
    const App = window.App;
    const slug = document.body.dataset.slug;
    const s = App.services.find(x => x.slug === slug);
    const root = document.getElementById("service-detail");
    if (!s || !root) return;
    const esc = App.esc, t = App.t;
    const c = window.CLINIC_CONFIG.clinic;

    function render() {
      const L = App.lang;
      document.body.dataset.titleAr = `${s.name_ar} في بغداد زيونة | عيادة الدكتور علي الزبيدي`;
      document.body.dataset.titleEn = `${s.name_en} in Zayouna, Baghdad | Dr. Ali Al-Zubaidi Dental Clinic`;
      document.title = L === "ar" ? document.body.dataset.titleAr : document.body.dataset.titleEn;
      const md = document.querySelector('meta[name="description"]');
      if (md) md.setAttribute("content", App.field(s, "short") + (L === "ar" ? " — عيادة الدكتور علي الزبيدي، زيونة، بغداد." : " — Dr. Ali Al-Zubaidi Dental Clinic, Zayouna, Baghdad."));
      const related = App.services.filter(x => x.category === s.category && x.slug !== s.slug);
      root.innerHTML = `
        <nav aria-label="Breadcrumb"><ol class="breadcrumb">
          <li><a href="../index.html">${esc(t("brand.name"))}</a></li>
          <li><a href="../index.html#services">${esc(t("nav.services"))}</a></li>
          <li aria-current="page">${esc(App.field(s, "name"))}</li>
        </ol></nav>
        <div class="detail-grid">
          <article class="detail-body">
            <p class="eyebrow">${esc(t("cat." + s.category))}</p>
            <h1>${esc(App.field(s, "name"))}</h1>
            <p class="detail-lead">${esc(App.field(s, "short"))}</p>
            <h2>${esc(t("detail.about"))}</h2>
            <p>${esc(App.field(s, "long"))}</p>
            <h2>${esc(t("detail.what"))}</h2>
            <ul class="detail-points">${s["points_" + L].map(p => `<li><i class="fa-solid fa-circle-check" aria-hidden="true"></i>${esc(p)}</li>`).join("")}</ul>
            <p class="disclaimer small"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> <span>${esc(t("disclaimer"))}</span></p>
            ${related.length ? `<h2>${esc(t("nav.services"))} — ${esc(t("cat." + s.category))}</h2>
            <div class="related-grid">${related.map(r => `<a href="${r.slug}.html"><i class="fa-solid ${r.icon}" aria-hidden="true"></i>${esc(App.field(r, "name"))}</a>`).join("")}</div>` : ""}
          </article>
          <aside class="detail-aside">
            <div class="aside-card">
              <h2>${esc(t("cta.bookService"))}</h2>
              <p class="hint">${esc(t("booking.lead"))}</p>
              <a class="btn btn-primary" href="../index.html?service=${s.slug}#booking" data-track="cta_book"><i class="fa-regular fa-calendar-check" aria-hidden="true"></i> ${esc(t("cta.book"))}</a>
            </div>
            <div class="aside-card">
              <h2>${esc(t("detail.questions"))}</h2>
              <p class="hint">${esc(t("detail.questionsSub"))}</p>
              <a class="btn btn-outline" href="tel:${c.phone_e164}" data-track="phone_click"><i class="fa-solid fa-phone" aria-hidden="true"></i> <span dir="ltr">${esc(c.phone_display)}</span></a>
              <a class="btn btn-outline wa-link" target="_blank" rel="noopener" href="${App.waLink(L === "ar" ? "مرحباً، أود الاستفسار عن خدمة: " + s.name_ar : "Hello, I'd like to ask about: " + s.name_en)}" data-track="whatsapp_click"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> ${esc(t("cta.whatsapp"))}</a>
            </div>
          </aside>
        </div>`;
    }
    render();
    App.onLangChange(render);
    App.track("service_viewed", { service: slug });
  });
})();
