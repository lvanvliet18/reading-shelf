// TBR jar <-> Notion. Every slip is a book or fanfic you still want to read.
// GET  /api/tbr?key=...                 -> { slips: [...] }
// POST /api/tbr?key=...  {id, kind}     -> marks that book/fic as currently reading (and sets date started)
// Your secret token stays here on the server (an environment variable), never in the web page.

const HUBS = {
  book: { db: () => process.env.NOTION_BOOKS_DB, status: 'status', tbr: ['to read'], start: 'reading',
          pages: 'pages', author: '[author]', genre: '[genre]', tropes: 'tropes' },
  fic:  { db: () => process.env.NOTION_FICS_DB || '335ef276b3c280a0a264000b5ea183e3', status: 'reading status',
          tbr: ['want to read', 'not started'], start: 'currently reading',
          chapters: 'chapters', author: 'author', tags: 'tags', length: 'length', pairing: 'pairing', url: 'source?' },
};

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
async function query(dbId, body, max = 400) {
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
const statusFilter = (H) => ({ or: H.tbr.map((name) => ({ property: H.status, status: { equals: name } })) });

async function list(res) {
  const [books, fics] = await Promise.all([
    HUBS.book.db() ? query(HUBS.book.db(), { filter: statusFilter(HUBS.book) }) : [],
    query(HUBS.fic.db(), { filter: statusFilter(HUBS.fic) }),
  ]);
  const B = HUBS.book;
  const names = await namesFor(books.flatMap((pg) => [
    ...relIds(prop(pg.properties, B.author)).slice(0, 1),
    ...relIds(prop(pg.properties, B.genre)).slice(0, 1),
    ...relIds(prop(pg.properties, B.tropes)).slice(0, 3),
  ]));
  const slips = [];
  books.forEach((pg) => {
    const pr = pg.properties, t = titleOf(pg);
    if (!t) return;
    slips.push({
      id: pg.id, k: 'book', t,
      a: names[relIds(prop(pr, B.author))[0]] || '',
      g: (names[relIds(prop(pr, B.genre))[0]] || '').toLowerCase(),
      p: num(prop(pr, B.pages)),
      tags: relIds(prop(pr, B.tropes)).slice(0, 3).map((id) => names[id]).filter(Boolean),
    });
  });
  const F = HUBS.fic;
  fics.forEach((pg) => {
    const pr = pg.properties, t = titleOf(pg);
    if (!t) return;
    const u = prop(pr, F.url);
    slips.push({
      id: pg.id, k: 'fic', t,
      a: sel(prop(pr, F.author)),
      g: 'fanfic',
      ch: num(prop(pr, F.chapters)),
      len: sel(prop(pr, F.length)),
      pair: sel(prop(pr, F.pairing)),
      tags: multi(prop(pr, F.tags)).slice(0, 6),
      url: u && u.url ? u.url : null,
    });
  });
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  res.status(200).json({ slips });
}

async function start(req, res) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const H = HUBS[body.kind === 'fic' ? 'fic' : 'book'];
  if (!/^[0-9a-f-]{32,36}$/i.test(body.id || '')) return res.status(400).json({ error: 'Missing book id.' });
  const today = new Date().toISOString().slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : today;
  await notion('/pages/' + body.id, {
    method: 'PATCH',
    body: JSON.stringify({ properties: {
      [H.status]: { status: { name: H.start } },
      'date started': { date: { start: day } },
    } }),
  });
  res.status(200).json({ ok: true, status: H.start });
}

module.exports = async (req, res) => {
  try {
    if (process.env.SHELF_KEY && req.query.key !== process.env.SHELF_KEY)
      return res.status(401).json({ error: 'This page is private.' });
    if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'Set NOTION_TOKEN in Vercel.' });
    if (req.method === 'POST') return await start(req, res);
    if (req.method === 'GET') return await list(res);
    res.status(405).json({ error: 'Use GET or POST.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
