// Yearly report <-> Notion. Books you finished (pink) and fanfics you finished (green) in a year.
// GET /api/year?key=...[&year=2026] -> { year, books: [...], fics: [...] }
// Your secret token stays here on the server (an environment variable), never in the web page.

const BOOKS = () => process.env.NOTION_BOOKS_DB;
const FICS = () => process.env.NOTION_FICS_DB || '335ef276b3c280a0a264000b5ea183e3';

const API = 'https://api.notion.com/v1';
const headers = () => ({
  Authorization: 'Bearer ' + process.env.NOTION_TOKEN,
  'Notion-Version': '2025-09-03',
  'Content-Type': 'application/json',
});
async function notion(path, opts) {
  const r = await fetch(API + path, { headers: headers(), ...opts });
  if (!r.ok) throw new Error('Notion ' + r.status + ': ' + (await r.text()).slice(0, 300));
  return r.json();
}
const sources = {};
async function sourceId(id) {
  if (sources[id]) return sources[id];
  let clean = id.replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0] || id;
  try {
    const db = await notion('/databases/' + clean);
    if (db.data_sources && db.data_sources[0]) clean = db.data_sources[0].id;
  } catch (e) { /* already a data source ID */ }
  return (sources[id] = clean);
}
async function query(dbId, body, max = 2000) {
  const ds = await sourceId(dbId);
  let out = [], cursor;
  do {
    const j = await notion('/data_sources/' + ds + '/query', {
      method: 'POST', body: JSON.stringify({ page_size: 100, ...body, start_cursor: cursor }),
    });
    out.push(...j.results);
    cursor = j.has_more && out.length < max ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}
const titleOf = (page) => {
  const t = Object.values(page.properties).find((p) => p.type === 'title');
  return t ? t.title.map((x) => x.plain_text).join('').trim() : '';
};
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const prop = (pr, name) => pr[name] || pr[Object.keys(pr).find((k) => norm(k) === norm(name))];
const relIds = (p) => (p && p.type === 'relation' ? p.relation.map((x) => x.id) : []);
const num = (p) => (p && typeof p.number === 'number' ? p.number : null);
const sel = (p) => (p && p.select ? p.select.name : '');
const multi = (p) => (p && p.multi_select ? p.multi_select.map((x) => x.name) : []);

async function namesFor(ids) {
  const names = {}, list = [...new Set(ids)].slice(0, 120);
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async (id) => {
      try { names[id] = titleOf(await notion('/pages/' + id)); } catch (e) { names[id] = ''; }
    }));
  }
  return names;
}
const dateOf = (p) => (p && p.date && p.date.start ? p.date.start.slice(0, 10) : null);
function stars(p) {
  if (!p) return 0;
  if (typeof p.number === 'number') return Math.max(0, Math.min(5, Math.round(p.number)));
  if (p.select) return (p.select.name.match(/[⭐★]/g) || []).length || parseFloat(p.select.name) || 0;
  return 0;
}
const inYear = (y) => ({ and: [
  { property: 'date finished', date: { on_or_after: y + '-01-01' } },
  { property: 'date finished', date: { on_or_before: y + '-12-31' } },
] });

module.exports = async (req, res) => {
  try {
    if (process.env.SHELF_KEY && req.query.key !== process.env.SHELF_KEY)
      return res.status(401).json({ error: 'This page is private.' });
    if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'Set NOTION_TOKEN in Vercel.' });
    const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
    const [bp, fp] = await Promise.all([
      BOOKS() ? query(BOOKS(), { filter: inYear(y) }) : [],
      query(FICS(), { filter: inYear(y) }),
    ]);
    const names = await namesFor(bp.flatMap((pg) => [
      ...relIds(prop(pg.properties, '[author]')).slice(0, 1),
      ...relIds(prop(pg.properties, '[genre]')).slice(0, 1),
    ]));
    const books = bp.map((pg) => {
      const pr = pg.properties, st = prop(pr, 'status');
      const status = st && (st.status || st.select) ? (st.status || st.select).name.toLowerCase() : '';
      const ty = prop(pr, 'type');
      return {
        k: 'book', t: titleOf(pg),
        a: names[relIds(prop(pr, '[author]'))[0]] || '',
        g: (names[relIds(prop(pr, '[genre]'))[0]] || '').toLowerCase(),
        p: num(prop(pr, 'pages')), r: stars(prop(pr, 'rating')),
        d: dateOf(prop(pr, 'date finished')), s: dateOf(prop(pr, 'date started')),
        type: ty && ty.select ? ty.select.name.toLowerCase() : '',
        status,
      };
    }).filter((b) => b.t && b.d && b.status !== 'stopped');
    const fics = fp.map((pg) => {
      const pr = pg.properties;
      return {
        k: 'fic', t: titleOf(pg),
        a: sel(prop(pr, 'author')),
        ch: num(prop(pr, 'chapters')), len: sel(prop(pr, 'length')),
        pair: sel(prop(pr, 'pairing')), era: multi(prop(pr, 'era')),
        tags: multi(prop(pr, 'tags')), mat: sel(prop(pr, 'maturity')),
        ws: sel(prop(pr, 'writing status')), r: stars(prop(pr, 'my rating')),
        d: dateOf(prop(pr, 'date finished')), s: dateOf(prop(pr, 'date started')),
      };
    }).filter((f) => f.t && f.d);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ year: y, books, fics });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
