// What /advertise shows advertisers (safe in the browser; reading and saving is lib/advertise-store.ts). The numbers are edited on /admin/advertise (from your own analytics:
// Vercel Analytics, the Facebook page's insights) and kept in site_settings; never counted from the database.

export type AdNumber = {
  value: string; // as it should read, e.g. "48,200" or "6M+"
  label: string; // e.g. "visitors in the last 30 days"
};

export type AdStats = {
  site: AdNumber[]; // gitmanual.com
  social: AdNumber[]; // the Facebook page
  updated: string | null; // when they were last checked, e.g. "November 2026"
  nextOpen: string | null; // the first month a new campaign can start, e.g. "January 2027"
};

export const AD_LIMITS = { numbers: 4, value: 16, label: 60, text: 40 };

// Until someone saves them on /admin/advertise.
export const AD_DEFAULTS: AdStats = {
  site: [],
  social: [
    { value: "6M+", label: "views in the last 28 days" },
    { value: "400K+", label: "engagements in the last 28 days" },
  ],
  updated: "November 2026",
  nextOpen: null,
};

// US dollars for 30 days, paid once before launch.
export const AD_PRICES = { shared: 599, exclusive: 2499 };

// The Facebook page, when FINDS_URL isn't set.
export const SOCIAL_URL = process.env.FINDS_URL || "https://facebook.com/zainfinds";
