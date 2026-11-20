// Review letters <-> Notion. Every envelope is a book marked "read" with no linked review yet.
// GET  /api/review?key=...                               -> { books: [{id,t,a,fin,p,r}] }
// POST /api/review?key=...  {id, rating, feelings, text}  -> creates a review in [book notes & reviews],
//                                                            links it to the book and updates the book's rating
// Your secret token stays here on the server (an environment variable), never in the web page.

const BOOKS = () => process.env.NOTION_BOOKS_DB;
const REVIEWS = () => process.env.NOTION_REVIEWS_DB || '09cef276b3c2824780f881b1a3ba93a8';
const B = { status: 'status', done: 'read', reviews: 'notes & reviews', finished: 'date finished',
            pages: 'pages', author: '[author]', rating: 'rating', type: 'type' };
const R = { title: 'name', book: '[all books]', type: 'type', status: 'status', date: 'date' };

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
const stars = (s) => (s.match(/⭐/g) || []).length;
const starName = (n) => '⭐️'.repeat(n);

async function namesFor(ids) {
  const names = {}, list = [...new Set(ids)].slice(0, 120);
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async (id) => {
      try { names[id] = titleOf(await notion('/pages/' + id)); } catch (e) { names[id] = ''; }
    }));
  }
  return names;
}

async function list(res) {
  if (!BOOKS()) return res.status(500).json({ error: 'Set NOTION_BOOKS_DB in Vercel.' });
  const rows = await query(BOOKS(), {
    filter: { and: [
      { property: B.status, status: { equals: B.done } },
      { property: B.reviews, relation: { is_empty: true } },
    ] },
    sorts: [{ property: B.finished, direction: 'descending' }],
  });
  const keep = rows.filter((pg) => titleOf(pg) && sel(prop(pg.properties, B.type)) !== 'fanfiction');
  const names = await namesFor(keep.flatMap((pg) => relIds(prop(pg.properties, B.author)).slice(0, 1)));
  const books = keep.map((pg) => {
    const pr = pg.properties, f = prop(pr, B.finished);
    return {
      id: pg.id, t: titleOf(pg),
      a: names[relIds(prop(pr, B.author))[0]] || '',
      fin: (f && f.date && f.date.start ? f.date.start : pg.last_edited_time).slice(0, 10),
      p: num(prop(pr, B.pages)),
      r: stars(sel(prop(pr, B.rating))),
    };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ books });
}

const para = (text, extra = {}) => ({ type: 'text', text: { content: text.slice(0, 1900) }, annotations: extra });
async function save(req, res) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!/^[0-9a-f-]{32,36}$/i.test(body.id || '')) return res.status(400).json({ error: 'Missing book id.' });
  const text = String(body.text || '').trim().slice(0, 8000);
  const feelings = (Array.isArray(body.feelings) ? body.feelings : []).map(String).slice(0, 8);
  const rating = Math.max(0, Math.min(5, parseInt(body.rating, 10) || 0));
  if (!text && !feelings.length) return res.status(400).json({ error: 'Write a line or pick a feeling first.' });

  const book = await notion('/pages/' + body.id);
  const title = titleOf(book) || 'book';
  const today = new Date().toISOString().slice(0, 10);

  const children = [];
  if (feelings.length) children.push({ type: 'quote', quote: { rich_text: [para('I ' + feelings.join(' · '), { italic: true })] } });
  text.split(/\n{2,}/).filter(Boolean).forEach((chunk) =>
    children.push({ type: 'paragraph', paragraph: { rich_text: [para(chunk)] } }));
  const review = {
    type: 'callout',
    callout: { rich_text: [para('review.', { bold: true })], icon: { type: 'emoji', emoji: '♡' }, color: 'default', children },
  };

  const ds = await sourceId(REVIEWS());
  const page = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: ds },
      properties: {
        [R.title]: { title: [{ text: { content: title + ' ♡' } }] },
        [R.book]: { relation: [{ id: body.id }] },
        [R.type]: { select: { name: 'review' } },
        [R.status]: { status: { name: 'done' } },
        [R.date]: { date: { start: today } },
      },
      children: [review],
    }),
  });
  if (rating && rating !== stars(sel(prop(book.properties, B.rating)))) {
    await notion('/pages/' + body.id, {
      method: 'PATCH', body: JSON.stringify({ properties: { [B.rating]: { select: { name: starName(rating) } } } }),
    });
  }
  res.status(200).json({ ok: true, url: page.url });
}

module.exports = async (req, res) => {
  try {
    if (process.env.SHELF_KEY && req.query.key !== process.env.SHELF_KEY)
      return res.status(401).json({ error: 'This page is private.' });
    if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'Set NOTION_TOKEN in Vercel.' });
    if (req.method === 'POST') return await save(req, res);
    if (req.method === 'GET') return await list(res);
    res.status(405).json({ error: 'Use GET or POST.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
