/**
 * PUBLIC front-end configuration.
 *
 * ⚠️ NEVER put secrets here (API tokens, WhatsApp credentials, test recipient numbers,
 * admin passwords). Everything in this file is readable by any visitor.
 * All secrets live server-side in the Cloudflare Worker (see backend/ and README.md).
 */
window.CLINIC_CONFIG = Object.freeze({
  /**
   * Base URL of the booking API (Cloudflare Worker in backend/).
   * - ""  → same origin (recommended: the Worker serves this site AND /api/*)
   * - "https://alz-booking.<account>.workers.dev" → separate API origin (CORS must allow this site)
   */
  API_BASE: "",

  /** Public clinic facts — ONLY information supplied by the clinic. */
  clinic: {
    name_en: "Dr. Ali Al-Zubaidi Dental Clinic",
    name_ar: "عيادة الدكتور علي الزبيدي",
    phone_display: "0770 626 6800",
    phone_e164: "+9647706266800",
    whatsapp_digits: "9647706266800", // used ONLY for patient-initiated "Chat on WhatsApp" links
    address_en: "Al-Rubaie Street, Zayouna, Baghdad, Baghdad Governorate, Iraq",
    address_ar: "شارع الربيعي، زيونة، بغداد، محافظة بغداد، العراق",
    maps_query: "Al-Rubaie Street, Zayouna, Baghdad, Iraq",
    // Optional: paste the exact Google Maps "Embed a map" URL for the clinic pin here.
    map_embed_url: "",
    google_rating: 4.3,
    google_review_count: 12,
    timezone: "Asia/Baghdad",
    // Publicly supplied hours (display fallback when the API is unreachable).
    // Authoritative hours for booking always come from the backend settings.
    hours_fallback: { sat: ["15:00", "20:00"], sun: ["15:00", "20:00"], mon: ["15:00", "20:00"], tue: ["15:00", "20:00"], wed: ["15:00", "20:00"], thu: ["15:00", "20:00"], fri: null }
  }
});
