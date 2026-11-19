// Reading candle <-> Notion "reading session tracker".
// GET  /api/sessions?key=...  -> recent sessions + the books you're currently reading
// POST /api/sessions?key=...  -> logs one sitting as a new row in the tracker
// Your secret token stays here on the server (an environment variable), never in the web page.

// ---- Edit these if your property names ever change ----
const PROPS = {
  title: 'name',
  date: 'date', // a sitting is saved as a time range (start -> end), which gives its minutes
  pages: 'pages completed',
  unit: 'reading unit',
  book: 'book',
};
const BOOK_STATUS = 'status';
const READING = 'reading';
const DAYS_BACK = 120;

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

async function readingBooks() {
  if (!process.env.NOTION_BOOKS_DB) return [];
  const pages = await query(process.env.NOTION_BOOKS_DB, {
    filter: { property: BOOK_STATUS, status: { equals: READING } },
  }, 100);
  return pages.map((p) => ({ id: p.id, t: titleOf(p) })).filter((b) => b.t);
}

async function findBook(title) {
  if (!process.env.NOTION_BOOKS_DB || !title) return null;
  const pages = await query(process.env.NOTION_BOOKS_DB, {
    filter: { property: 'title', title: { equals: title } }, page_size: 5,
  }, 5);
  return pages[0] ? pages[0].id : null;
}

async function list(res) {
  const since = new Date(Date.now() - DAYS_BACK * 864e5).toISOString().slice(0, 10);
  const [rows, reading] = await Promise.all([
    query(process.env.NOTION_READINGTRACKER_DB, {
      filter: { property: PROPS.date, date: { on_or_after: since } },
      sorts: [{ property: PROPS.date, direction: 'descending' }],
    }),
    readingBooks(),
  ]);
  const known = Object.fromEntries(reading.map((b) => [b.id, b.t]));
  const names = await namesFor(rows.flatMap((pg) => relIds(prop(pg.properties, PROPS.book)).slice(0, 1)), known);

  const sessions = rows.map((pg) => {
    const pr = pg.properties;
    const dt = prop(pr, PROPS.date);
    const start = dt && dt.date ? dt.date.start : null;
    const end = dt && dt.date ? dt.date.end : null;
    const m = start && end && start.includes('T') ? Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000)) : 0;
    const pages = prop(pr, PROPS.pages);
    return {
      d: start ? start.slice(0, 10) : null,
      b: names[relIds(prop(pr, PROPS.book))[0]] || titleOf(pg) || 'Reading',
      m,
      p: pages && pages.number ? pages.number : 0,
    };
  }).filter((s) => s.d).reverse();

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ sessions, reading });
}

async function add(req, res) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const book = String(body.book || '').trim().slice(0, 200);
  const start = String(body.start || ''), end = String(body.end || '');
  const pages = Math.max(0, Math.round(Number(body.pages) || 0));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(start) || !/^\d{4}-\d{2}-\d{2}T/.test(end))
    return res.status(400).json({ error: 'A sitting needs a start and end time.' });

  let bookId = /^[0-9a-f-]{32,36}$/i.test(body.bookId || '') ? body.bookId : null;
  if (!bookId) bookId = await findBook(book);

  const properties = {
    [PROPS.title]: { title: [{ text: { content: book || 'reading session' } }] },
    [PROPS.date]: { date: { start, end } },
    [PROPS.pages]: { number: pages },
    [PROPS.unit]: { select: { name: 'pages' } },
  };
  if (bookId) properties[PROPS.book] = { relation: [{ id: bookId }] };

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
    if (req.method === 'POST') return await add(req, res);
    if (req.method === 'GET') return await list(res);
    res.status(405).json({ error: 'Use GET or POST.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
