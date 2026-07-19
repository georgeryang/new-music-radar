// Apple Music storefront codes selectable as "Additional countries" —
// config discovery.countries entries must come from this map, and the prefs
// editor uses it for display names and its country picker. Shared module for
// the same reason as genre-options.mjs.
//
// Every code verified live 2026-07-19: both the marketingtools most-played
// feed and the legacy purchase RSS respond (kr/cn purchase feeds exist but
// are nearly empty — fetched uniformly anyway, they just contribute ~0 ids).
// The set is the P1–P3 country tiers plus every same-language storefront
// (Spanish-speaking Latin America, Brazil, Chinese-speaking hubs).
export const STOREFRONTS = {
  ar: 'Argentina',
  bo: 'Bolivia',
  br: 'Brazil',
  cl: 'Chile',
  cn: 'China',
  co: 'Colombia',
  cr: 'Costa Rica',
  do: 'Dominican Republic',
  ec: 'Ecuador',
  es: 'Spain',
  gt: 'Guatemala',
  hk: 'Hong Kong',
  hn: 'Honduras',
  id: 'Indonesia',
  in: 'India',
  jp: 'Japan',
  kr: 'Korea',
  mo: 'Macau',
  mx: 'Mexico',
  my: 'Malaysia',
  ng: 'Nigeria',
  ni: 'Nicaragua',
  pa: 'Panama',
  pe: 'Peru',
  ph: 'Philippines',
  py: 'Paraguay',
  sg: 'Singapore',
  sv: 'El Salvador',
  th: 'Thailand',
  tw: 'Taiwan',
  uy: 'Uruguay',
  ve: 'Venezuela',
  vn: 'Vietnam',
  za: 'South Africa',
}
