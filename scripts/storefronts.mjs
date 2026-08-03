// Apple Music storefront codes for "Additional countries": discovery.countries
// entries must come from this map, and the editor uses it for display names
// and its picker. Covers the P1–P3 tiers plus same-language storefronts.
//
// cn, uy and mo are deliberately absent: the first two have no purchase store and
// almost nothing recent, and mo's recent releases are all carried by hk.

import { PURCHASE_FEED_TYPES } from './shared.mjs'

export const STOREFRONTS = {
  ar: 'Argentina',
  bo: 'Bolivia',
  br: 'Brazil',
  cl: 'Chile',
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
  ve: 'Venezuela',
  vn: 'Vietnam',
  za: 'South Africa',
}

// Apple runs no iTunes purchase store here, so topalbums/topsongs are permanently
// empty — kr returns 0 and 4 entries, the newest released 2008-10-21. Skipping
// those two feeds is a capability fact, not a dormancy guess: kr's most-played
// streaming chart is one of the healthiest in the map and is still scanned.
export const STREAMING_ONLY = new Set(['kr'])

// Which purchase charts a storefront can contribute. A fact about the storefront,
// so the fetcher and the audit ask rather than each testing STREAMING_ONLY.
export const purchaseFeedsOf = (sf) => (STREAMING_ONLY.has(sf) ? [] : PURCHASE_FEED_TYPES)
