/* Brand constants for the worker: the one place to edit when porting this CRM
 * to a different site. Business-facing copy (price note, auto-reply text, Cal
 * link) lives in the D1 settings table and is editable in Admin > Settings;
 * these are only the defaults and the strings used in system emails. */

export const BRAND = {
  businessName: "Collective by Sus",
  ownerName: "Susi",
  ownerFirstName: "Susi",
  contactEmail: "contact@collectivebysus.com",
  instagram: "collectivebysus",
  city: "Dallas, Texas",
  timeZone: "America/Chicago", // Central time. Also set TZ in admin/lib.js.
  fileSlug: "collectivebysus",        // prefix for CSV export filenames
  calLinkDefault: "",
};
