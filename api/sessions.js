// Reading candle <-> Notion "reading session tracker".
// GET  /api/sessions?key=...[&hub=fic]  -> recent sittings + what you're currently reading
// POST /api/sessions?key=...  -> logs one sitting as a new row in the tracker
// Your secret token stays here on the server (an environment variable), never in the web page.

// ---- Edit these if your property names ever change ----
const PROPS = {
  title: 'name',
  date: 'date', // a sitting is saved as a time range (start -> end), which gives its minutes
  pages: 'pages completed',
  unit: 'reading unit',
};
const DAYS_BACK = 120;

// Two hubs share the tracker: books (the pink candle) and fanfics (gamma draconis, ?hub=fic).
const HUBS = {
  book: { relation: 'book', other: 'fanfics', db: () => process.env.NOTION_BOOKS_DB, title: 'title',
          status: 'status', reading: ['reading'], unit: 'pages', total: 'pages', author: '[author]' },
  fic:  { relation: 'fanfics', other: null, db: () => process.env.NOTION_FICS_DB || '335ef276b3c280a0a264000b5ea183e3',
          title: 'fic', status: 'reading status', reading: ['currently reading'], unit: 'chapters', total: 'chapters', author: 'author' },
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

// Notion queries a database through its "data source". Accept either kind of ID (or a full URL).
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

async function query(dbId, body, max = 300) {
  const ds = await sourceId(dbId);
  let out = [], cursor;
  do {
    const j = await notion('/data_sources/' + ds + '/query', {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, ...body, start_cursor: cursor }),
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

async function namesFor(ids, known) {
  const names = { ...known };
  const list = [...new Set(ids)].filter((id) => !(id in names)).slice(0, 40);
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (id) => {
      try { names[id] = titleOf(await notion('/pages/' + id)); } catch (e) { names[id] = ''; }
    }));
  }
  return names;
}

async function readingBooks(H) {
  if (!H.db()) return [];
  const pages = await query(H.db(), {
    filter: { or: H.reading.map((name) => ({ property: H.status, status: { equals: name } })) },
  }, 100);
  return pages.map((p) => {
    const pr = p.properties, tot = prop(pr, H.total), au = prop(pr, H.author);
    let a = '', aIds = [];
    if (au && au.type === 'select' && au.select) a = au.select.name;
    else if (au && au.type === 'rich_text') a = au.rich_text.map((x) => x.plain_text).join('');
    else aIds = relIds(au).slice(0, 1);
    return { id: p.id, t: titleOf(p), a, aIds, p: tot && typeof tot.number === 'number' ? tot.number : null };
  }).filter((b) => b.t);
}

// How far into each current read: the sum of every logged sitting linked to it (all time).
async function progressFor(H, reading) {
  if (!reading.length) return {};
  const rows = await query(process.env.NOTION_READINGTRACKER_DB, {
    filter: { or: reading.slice(0, 50).map((b) => ({ property: H.relation, relation: { contains: b.id } })) },
  }, 1000);
  const done = {};
  rows.forEach((pg) => {
    const n = prop(pg.properties, PROPS.pages), id = relIds(prop(pg.properties, H.relation))[0];
    if (id && n && n.number) done[id] = (done[id] || 0) + n.number;
  });
  return done;
}

async function findBook(H, title) {
  if (!H.db() || !title) return null;
  const pages = await query(H.db(), {
    filter: { property: H.title, title: { equals: title } }, page_size: 5,
  }, 5);
  return pages[0] ? pages[0].id : null;
}

async function list(res, H) {
  const since = new Date(Date.now() - DAYS_BACK * 864e5).toISOString().slice(0, 10);
  const filters = [{ property: PROPS.date, date: { on_or_after: since } }];
  if (H.other) filters.push({ property: H.other, relation: { is_empty: true } }); // book log skips fic sittings
  else filters.push({ property: H.relation, relation: { is_not_empty: true } }); // fic log shows only fic sittings
  const [rows, reading] = await Promise.all([
    query(process.env.NOTION_READINGTRACKER_DB, {
      filter: { and: filters },
      sorts: [{ property: PROPS.date, direction: 'descending' }],
    }),
    readingBooks(H),
  ]);
  const known = Object.fromEntries(reading.map((b) => [b.id, b.t]));
  const [done, authors] = await Promise.all([progressFor(H, reading), namesFor(reading.flatMap((b) => b.aIds), {})]);
  reading.forEach((b) => { b.c = done[b.id] || 0; if (!b.a && b.aIds[0]) b.a = authors[b.aIds[0]] || ''; delete b.aIds; });
  const names = await namesFor(rows.flatMap((pg) => relIds(prop(pg.properties, H.relation)).slice(0, 1)), known);

  const sessions = rows.map((pg) => {
    const pr = pg.properties;
    const dt = prop(pr, PROPS.date);
    const start = dt && dt.date ? dt.date.start : null;
    const end = dt && dt.date ? dt.date.end : null;
    const m = start && end && start.includes('T') ? Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000)) : 0;
    const pages = prop(pr, PROPS.pages);
    return {
      d: start ? start.slice(0, 10) : null,
      b: names[relIds(prop(pr, H.relation))[0]] || titleOf(pg) || 'Reading',
      m,
      p: pages && pages.number ? pages.number : 0,
    };
  }).filter((s) => s.d).reverse();

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ sessions, reading, unit: H.unit });
}

async function add(req, res, H) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const book = String(body.book || '').trim().slice(0, 200);
  const start = String(body.start || ''), end = String(body.end || '');
  const pages = Math.max(0, Math.round(Number(body.pages) || 0));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(start) || !/^\d{4}-\d{2}-\d{2}T/.test(end))
    return res.status(400).json({ error: 'A sitting needs a start and end time.' });

  let bookId = /^[0-9a-f-]{32,36}$/i.test(body.bookId || '') ? body.bookId : null;
  if (!bookId) bookId = await findBook(H, book);

  const properties = {
    [PROPS.title]: { title: [{ text: { content: book || 'reading session' } }] },
    [PROPS.date]: { date: { start, end } },
    [PROPS.pages]: { number: pages },
    [PROPS.unit]: { select: { name: H.unit } },
  };
  if (bookId) properties[H.relation] = { relation: [{ id: bookId }] };

  const ds = await sourceId(process.env.NOTION_READINGTRACKER_DB);
  const page = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: ds }, properties }),
  });
  res.status(200).json({ ok: true, id: page.id, linkedBook: !!bookId });
}

module.exports = async (req, res) => {
  try {
    // Private: only answer when the link carries your key (?key=...). Same SHELF_KEY as the shelf.
    if (process.env.SHELF_KEY && req.query.key !== process.env.SHELF_KEY)
      return res.status(401).json({ error: 'This page is private.' });
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_READINGTRACKER_DB)
      return res.status(500).json({ error: 'Set NOTION_TOKEN and NOTION_READINGTRACKER_DB in Vercel.' });
    const H = HUBS[req.query.hub === 'fic' ? 'fic' : 'book'];
    if (req.method === 'POST') return await add(req, res, H);
    if (req.method === 'GET') return await list(res, H);
    res.status(405).json({ error: 'Use GET or POST.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
