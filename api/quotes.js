// Quotes deck <-> Notion "[all quotes]". Lines from books (pink) and fanfic (green).
// GET  /api/quotes?key=...                         -> { quotes: [...], sources: [...], topics: [...], fields: {...} }
// POST /api/quotes?key=...  {q, kind, page, bookId, ficId, topics}   -> saves a new line
// POST /api/quotes?key=...  {id, fav}                                -> sets the favourite checkbox
// Optional properties are used only if they exist on the database: "kind" (select: quote/note),
// "page" (number), "favourite" (checkbox) and "fanfic" (relation to the fanfic database).
// Your secret token stays here on the server (an environment variable), never in the web page.

const QUOTES = () => process.env.NOTION_QUOTES_DB || '48cef276b3c2827990860792a386ce58';
const BOOKS = () => process.env.NOTION_BOOKS_DB;
const FICS = () => process.env.NOTION_FICS_DB || '335ef276b3c280a0a264000b5ea183e3';
const P = { title: 'quote', book: '[all books]', topic: 'topic', kind: 'kind', page: 'page', fav: 'favourite', fic: 'fanfic' };

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

// which optional properties exist, and the topic options
async function schema() {
  const ds = await sourceId(QUOTES());
  const j = await notion('/data_sources/' + ds);
  const props = j.properties || {};
  const has = (n) => Object.keys(props).find((k) => norm(k) === norm(n));
  const topicKey = has(P.topic);
  return {
    ds,
    names: { kind: has(P.kind), page: has(P.page), fav: has(P.fav), fic: has(P.fic), book: has(P.book), topic: topicKey },
    topics: topicKey && props[topicKey].multi_select ? props[topicKey].multi_select.options.map((o) => o.name) : [],
  };
}

async function list(res) {
  const S = await schema();
  const [rows, books, fics] = await Promise.all([
    query(QUOTES(), { sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, 1000),
    BOOKS() ? query(BOOKS(), {}, 1000) : [],
    query(FICS(), { filter: { or: ['read', 'reread', 'currently reading', 'paused', 'restart'].map((n) => ({ property: 'reading status', status: { equals: n } })) } }, 1000),
  ]);
  // book titles + authors, fic titles + authors
  const bookInfo = {};
  const authorIds = [];
  books.forEach((pg) => {
    const a = relIds(prop(pg.properties, '[author]'))[0];
    bookInfo[pg.id] = { t: titleOf(pg), aid: a };
    if (a) authorIds.push(a);
  });
  const authors = await namesFor(authorIds);
  const ficInfo = {};
  fics.forEach((pg) => { ficInfo[pg.id] = { t: titleOf(pg), a: sel(prop(pg.properties, 'author')) }; });
  const missingFics = [];
  rows.forEach((pg) => { if (S.names.fic) relIds(pg.properties[S.names.fic]).forEach((id) => { if (!ficInfo[id]) missingFics.push(id); }); });
  const extra = await namesFor(missingFics);
  Object.entries(extra).forEach(([id, t]) => { ficInfo[id] = { t, a: '' }; });

  const quotes = rows.map((pg) => {
    const pr = pg.properties;
    const bid = S.names.book ? relIds(pr[S.names.book])[0] : null;
    const fid = S.names.fic ? relIds(pr[S.names.fic])[0] : null;
    const b = bid && bookInfo[bid], f = fid && ficInfo[fid];
    const kindName = S.names.kind ? sel(pr[S.names.kind]).toLowerCase() : '';
    return {
      id: pg.id,
      q: titleOf(pg),
      k: f ? 'fic' : 'book',
      src: f ? f.t : b ? b.t : '',
      a: f ? f.a : b ? (authors[b.aid] || '') : '',
      tags: S.names.topic ? multi(pr[S.names.topic]) : [],
      kind: kindName === 'note' ? 'note' : 'quote',
      page: S.names.page ? num(pr[S.names.page]) : null,
      fav: S.names.fav && pr[S.names.fav] ? !!pr[S.names.fav].checkbox : false,
      d: pg.created_time ? pg.created_time.slice(0, 10) : null,
    };
  }).filter((x) => x.q);
  const sources = [
    ...books.map((pg) => ({ id: pg.id, k: 'book', t: bookInfo[pg.id].t, a: authors[bookInfo[pg.id].aid] || '' })),
    ...(S.names.fic ? fics.map((pg) => ({ id: pg.id, k: 'fic', t: ficInfo[pg.id].t, a: ficInfo[pg.id].a })) : []),
  ].filter((x) => x.t).sort((x, y) => x.t.localeCompare(y.t));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ quotes, sources, topics: S.topics, fields: { kind: !!S.names.kind, page: !!S.names.page, fav: !!S.names.fav, fic: !!S.names.fic } });
}

async function save(req, res) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const S = await schema();
  const okId = (x) => /^[0-9a-f-]{32,36}$/i.test(x || '');
  // favourite toggle
  if (okId(body.id) && typeof body.fav === 'boolean') {
    if (!S.names.fav) return res.status(400).json({ error: 'Add a "favourite" checkbox to your quotes database first.' });
    await notion('/pages/' + body.id, { method: 'PATCH', body: JSON.stringify({ properties: { [S.names.fav]: { checkbox: body.fav } } }) });
    return res.status(200).json({ ok: true });
  }
  const q = String(body.q || '').trim().slice(0, 1900);
  if (!q) return res.status(400).json({ error: 'Write the line first.' });
  const properties = { [P.title]: { title: [{ text: { content: q } }] } };
  if (okId(body.bookId) && S.names.book) properties[S.names.book] = { relation: [{ id: body.bookId }] };
  if (okId(body.ficId) && S.names.fic) properties[S.names.fic] = { relation: [{ id: body.ficId }] };
  const tags = Array.isArray(body.topics) ? body.topics.filter((t) => S.topics.includes(t)) : [];
  if (tags.length && S.names.topic) properties[S.names.topic] = { multi_select: tags.map((name) => ({ name })) };
  if (S.names.kind) properties[S.names.kind] = { select: { name: body.kind === 'note' ? 'note' : 'quote' } };
  const pg = Number(body.page);
  if (S.names.page && Number.isFinite(pg) && pg > 0) properties[S.names.page] = { number: Math.round(pg) };
  const page = await notion('/pages', { method: 'POST', body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: S.ds }, properties }) });
  res.status(200).json({ ok: true, id: page.id, d: page.created_time ? page.created_time.slice(0, 10) : null });
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
