#!/usr/bin/env node
// Phase 1 spike: pull a real week from all planned sources, normalize,
// dedupe, resolve links, and report stats. Zero deps, like v1's fetcher.
//
// Sources:
//   Deezer editorial releases  — spine (16 = Asian Music, 132 = Pop)
//   iTunes Search              — Apple Music link + K-Pop genre filter
//   Apple most-played charts   — charting badge (KR for kpop, US for pop)
//   YouTube channel Atom feeds — MV/song link fallback (sample: SM, HYBE, JYP)
//
// Usage: node scripts/spike.mjs   (writes data/spike.json, prints a report)

const UA = 'new-music-radar/0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.random() * 1500;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// ---------- normalization / canonical key ----------

const EDITION_RE =
  /\s*[-–(\[]\s*(the\s+\d+\w*\s+(mini\s+)?album|ep|single|deluxe( edition| version)?|standard( edition)?|explicit|extended|remaster(ed)?( \d{4})?)\s*[)\]]?\s*$/i;
const NOISE_RE = /\b(instrumental|sped[ -]?up|slowed( \+ reverb)?|inst\.)\b/i;

function normTitle(raw) {
  let t = raw.toLowerCase();
  let prev;
  do {
    prev = t;
    t = t.replace(EDITION_RE, '');
  } while (t !== prev && t.length > 2);
  return t.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
}

const normArtist = (raw) =>
  raw.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

const keyOf = (r) => `${normArtist(r.artist)}|${normTitle(r.title)}|${r.type}`;

// Deezer record_type: album | ep | single. Ours: album | ep | song.
const TYPE_MAP = { album: 'album', ep: 'ep', single: 'song' };

// ---------- 1. Deezer editorial spine ----------

async function fetchDeezerReleases(genreId, scene) {
  const out = [];
  let url = `https://api.deezer.com/editorial/${genreId}/releases?limit=50`;
  while (url) {
    const page = await getJSON(url);
    for (const a of page.data ?? []) out.push(a);
    url = page.next ?? null;
    await sleep(jitter(800));
  }
  // record_type isn't in the editorial listing; fetch per-album detail for it
  const detailed = [];
  for (const a of out) {
    try {
      const d = await getJSON(`https://api.deezer.com/album/${a.id}`);
      detailed.push({
        scene,
        deezer_id: a.id,
        title: d.title,
        artist: d.artist?.name ?? '?',
        type: TYPE_MAP[d.record_type] ?? 'album',
        release_date: d.release_date,
        artwork: d.cover_medium,
        nb_tracks: d.nb_tracks,
      });
    } catch (e) {
      console.error(`  ! album detail failed for ${a.id} (${a.title}): ${e.message}`);
    }
    await sleep(jitter(700));
  }
  return detailed;
}

// ---------- 2. iTunes Search: Apple Music link + genre ----------

async function itunesLookup(release, country) {
  const term = encodeURIComponent(`${release.artist} ${normTitle(release.title)}`);
  const entity = release.type === 'song' ? 'album,song' : 'album';
  const url = `https://itunes.apple.com/search?term=${term}&entity=${entity}&country=${country}&limit=5`;
  const data = await getJSON(url);
  const wantArtist = normArtist(release.artist);
  const wantTitle = normTitle(release.title);
  for (const r of data.results ?? []) {
    const name = r.collectionName ?? r.trackName ?? '';
    if (
      normArtist(r.artistName ?? '') === wantArtist &&
      (normTitle(name) === wantTitle || normTitle(name).startsWith(wantTitle))
    ) {
      return {
        apple_url: r.collectionViewUrl ?? r.trackViewUrl ?? null,
        itunes_genre: r.primaryGenreName ?? null,
      };
    }
  }
  return { apple_url: null, itunes_genre: null };
}

// ---------- 3. Apple most-played charts (badge) ----------

async function fetchAppleChart(storefront) {
  const url = `https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/50/albums.json`;
  const data = await getJSON(url);
  return (data.feed?.results ?? []).map((e, i) => ({
    rank: i + 1,
    artist: normArtist(e.artistName),
    title: normTitle(e.name),
  }));
}

function chartRank(release, chart) {
  const a = normArtist(release.artist);
  const t = normTitle(release.title);
  const hit = chart.find((c) => c.artist === a && (c.title === t || c.title.startsWith(t) || t.startsWith(c.title)));
  return hit ? hit.rank : null;
}

// ---------- 4. YouTube label-channel feeds (link fallback sample) ----------

const SAMPLE_CHANNELS = {
  SMTOWN: 'UCEf_Bc-KVd7onSeifS3py9g',
  HYBE: 'UC3IZKseVpdzPSBaWxBxundA',
  JYP: 'UCaO6TYtlC8U5ttz62hTrZgg',
};

async function fetchChannelVideos(channelId) {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((m) => {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '';
    const id = (block.match(/<yt:videoId>(.*?)<\/yt:videoId>/) ?? [])[1] ?? '';
    return { title, url: `https://www.youtube.com/watch?v=${id}` };
  });
}

function matchVideo(release, videos) {
  const t = normTitle(release.title);
  const a = normArtist(release.artist);
  // MV first, then any video mentioning the title (audio/lyric video)
  const mv = videos.find((v) => {
    const vt = v.title.toLowerCase();
    return vt.includes(t) && /\bmv\b|music video/i.test(v.title);
  });
  if (mv) return mv.url;
  const any = videos.find((v) => {
    const vt = normTitle(v.title);
    return vt.includes(t) && (vt.includes(a) || t.length > 6);
  });
  return any ? any.url : null;
}

// ---------- main ----------

const report = { fetched: {}, dropped_noise: [], collisions: [], unlinked: [] };

console.error('1/4 Deezer editorial releases…');
const asian = await fetchDeezerReleases(16, 'kpop');
const pop = await fetchDeezerReleases(132, 'pop');
report.fetched.deezer_asian = asian.length;
report.fetched.deezer_pop = pop.length;

let releases = [...asian, ...pop].filter((r) => {
  if (NOISE_RE.test(r.title)) {
    report.dropped_noise.push(`${r.artist} — ${r.title}`);
    return false;
  }
  return true;
});

// canonical-key dedup (scoped by type via keyOf)
const byKey = new Map();
for (const r of releases) {
  const k = keyOf(r);
  if (byKey.has(k)) {
    const prev = byKey.get(k);
    report.collisions.push(`${k}  [${prev.title} || ${r.title}]`);
    if (r.release_date < prev.release_date) byKey.set(k, { ...r, scene: prev.scene });
  } else {
    byKey.set(k, r);
  }
}
releases = [...byKey.values()];

console.error(`2/4 iTunes lookups for ${releases.length} releases (rate-limited, ~${Math.round(releases.length * 3.5 / 60)} min)…`);
for (const r of releases) {
  try {
    const { apple_url, itunes_genre } = await itunesLookup(r, r.scene === 'kpop' ? 'KR' : 'US');
    r.apple_url = apple_url;
    r.itunes_genre = itunes_genre;
  } catch (e) {
    console.error(`  ! itunes failed for ${r.artist} — ${r.title}: ${e.message}`);
    r.apple_url = null;
    r.itunes_genre = null;
  }
  await sleep(jitter(3000));
}

// kpop scene filter: Asian editorial minus non-K-Pop (per iTunes genre when known)
const before = releases.length;
releases = releases.filter(
  (r) => r.scene !== 'kpop' || !r.itunes_genre || /k-?pop|korean/i.test(r.itunes_genre)
);
report.fetched.kpop_genre_filtered_out = before - releases.length;

console.error('3/4 Apple charts…');
const chartKR = await fetchAppleChart('kr');
const chartUS = await fetchAppleChart('us');
for (const r of releases) {
  const rank = chartRank(r, r.scene === 'kpop' ? chartKR : chartUS);
  if (rank) r.charting = { storefront: r.scene === 'kpop' ? 'KR' : 'US', rank };
}

console.error('4/4 YouTube feeds (sample channels) + link resolution…');
let videos = [];
for (const [name, id] of Object.entries(SAMPLE_CHANNELS)) {
  try {
    const v = await fetchChannelVideos(id);
    report.fetched[`yt_${name}`] = v.length;
    videos.push(...v);
  } catch (e) {
    console.error(`  ! feed ${name}: ${e.message}`);
  }
  await sleep(jitter(1000));
}

for (const r of releases) {
  // link priority: Apple Music → YouTube (MV first for songs) → none
  if (r.apple_url) r.link = { service: 'apple', url: r.apple_url };
  else {
    const yt = matchVideo(r, videos);
    if (yt) r.link = { service: 'youtube', url: yt };
    else report.unlinked.push(`${r.scene}: ${r.artist} — ${r.title} (${r.type})`);
  }
}

releases.sort((a, b) => b.release_date.localeCompare(a.release_date) || a.artist.localeCompare(b.artist));

const { writeFileSync } = await import('node:fs');
writeFileSync(
  new URL('../data/spike.json', import.meta.url),
  JSON.stringify({ fetched_at: new Date().toISOString(), releases }, null, 2)
);

// ---------- report ----------
const pct = (n) => `${Math.round((n / releases.length) * 100)}%`;
console.log('\n=== SPIKE REPORT ===');
console.log('fetched:', JSON.stringify(report.fetched));
console.log(`total releases after dedup/filter: ${releases.length}`);
console.log(`  kpop: ${releases.filter((r) => r.scene === 'kpop').length}, pop: ${releases.filter((r) => r.scene === 'pop').length}`);
console.log(`  albums/EPs: ${releases.filter((r) => r.type !== 'song').length}, songs: ${releases.filter((r) => r.type === 'song').length}`);
console.log(`key collisions (dedup hits): ${report.collisions.length}`);
report.collisions.forEach((c) => console.log(`  · ${c}`));
console.log(`noise dropped: ${report.dropped_noise.length}`);
report.dropped_noise.forEach((c) => console.log(`  · ${c}`));
console.log(`apple links: ${pct(releases.filter((r) => r.link?.service === 'apple').length)}, youtube: ${pct(releases.filter((r) => r.link?.service === 'youtube').length)}, unlinked: ${pct(report.unlinked.length)}`);
report.unlinked.forEach((c) => console.log(`  · ${c}`));
console.log(`charting: ${releases.filter((r) => r.charting).length}`);
console.log('\nnewest 15:');
releases.slice(0, 15).forEach((r) =>
  console.log(`  ${r.release_date} [${r.scene}/${r.type}] ${r.artist} — ${r.title}${r.charting ? ` (chart #${r.charting.rank})` : ''} ${r.link ? `→ ${r.link.service}` : '(no link)'}`)
);
