// Gamma draconis "pick the jar": your to-read fics from the fanfic database.
// GET  /api/jar?key=...  -> fics waiting to be read (title, author, length, tags...)
// POST /api/jar?key=...  -> { id, date } marks that fic "currently reading" (and sets date started if empty)
// Your secret token stays here on the server (an environment variable), never in the web page.

const FICS_DB = () => process.env.NOTION_FICS_DB || '335ef276b3c280a0a264000b5ea183e3';
const STATUS = 'reading status';
const TO_READ = ['want to read', 'not started', 'reread', 'restart'];
const READING = 'currently reading';

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
let ds;
async function sourceId(id) {
  if (ds) return ds;
  let clean = id.replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0] || id;
  try {
    const db = await notion('/databases/' + clean);
    if (db.data_sources && db.data_sources[0]) clean = db.data_sources[0].id;
  } catch (e) { /* already a data source ID */ }
  return (ds = clean);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const prop = (pr, name) => pr[name] || pr[Object.keys(pr).find((k) => norm(k) === norm(name))];
const titleOf = (pg) => {
  const t = Object.values(pg.properties).find((p) => p.type === 'title');
  return t ? t.title.map((x) => x.plain_text).join('').trim() : '';
};
const sel = (p) => (p && p.type === 'select' && p.select ? p.select.name : p && p.type === 'status' && p.status ? p.status.name : null);
const multi = (p) => (p && p.type === 'multi_select' ? p.multi_select.map((x) => x.name) : []);
const num = (p) => (p && p.type === 'number' ? p.number : null);
const url = (p) => (p && p.type === 'url' ? p.url : null);

async function list(res) {
  const source = await sourceId(FICS_DB());
  let rows = [], cursor;
  do {
    const j = await notion('/data_sources/' + source + '/query', {
      method: 'POST',
      body: JSON.stringify({
        page_size: 100, start_cursor: cursor,
        filter: { or: TO_READ.map((name) => ({ property: STATUS, status: { equals: name } })) },
      }),
    });
    rows.push(...j.results);
    cursor = j.has_more && rows.length < 1500 ? j.next_cursor : undefined;
  } while (cursor);

  const fics = rows.map((pg) => {
    const pr = pg.properties;
    return {
      id: pg.id,
      t: titleOf(pg) || 'Untitled fic',
      a: sel(prop(pr, 'author')),
      len: sel(prop(pr, 'length')),
      ch: num(prop(pr, 'chapters')),
      pair: sel(prop(pr, 'pairing')),
      mat: sel(prop(pr, 'maturity')),
      ws: sel(prop(pr, 'writing status')),
      status: sel(prop(pr, STATUS)),
      rec: sel(prop(pr, 'rec')),
      tags: multi(prop(pr, 'tags')),
      era: multi(prop(pr, 'era')),
      kindle: (() => { const k = prop(pr, 'downloaded on kindle?'); return !!(k && k.type === 'checkbox' && k.checkbox); })(),
      url: url(prop(pr, 'source?')),
    };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ fics });
}

async function start(req, res) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = String(body.id || '');
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) return res.status(400).json({ error: 'Pick a fic first.' });
  const page = await notion('/pages/' + id);
  // only fics from your fanfic database can be changed here
  const bare = (s) => String(s || '').replace(/-/g, '');
  const p = page.parent || {};
  const inFics = bare(p.data_source_id) === bare(await sourceId(FICS_DB())) || bare(p.database_id) === bare(FICS_DB());
  if (!inFics) return res.status(400).json({ error: 'That page is not in your fanfic list.' });
  const properties = { [STATUS]: { status: { name: READING } } };
  const started = prop(page.properties, 'date started');
  if (started && started.type === 'date' && !started.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date || ''))
    properties[Object.keys(page.properties).find((k) => norm(k) === norm('date started'))] = { date: { start: body.date } };
  await notion('/pages/' + id, { method: 'PATCH', body: JSON.stringify({ properties }) });
  res.status(200).json({ ok: true });
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
