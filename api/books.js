// Reads your Notion books database and returns clean JSON for the shelf widget.
// Your secret token stays here on the server (an environment variable), never in the web page.

// ---- Edit these if your property names ever change ----
const PROPS = {
  pages: 'pages',
  status: 'status',
  started: 'date started',
  finished: 'date finished',
  rating: 'rating',
  author: '[author]',
  genre: '[genre]',
  favourite: 'favourite', // optional checkbox. If you don't have one, 5-star books count as favourites.
};
const READ_STATUS = (process.env.STATUS_READ || 'read').toLowerCase();

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

// Notion now queries a database through its "data source". Accept either kind of ID.
async function sourceId(id) {
  id = id.replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0] || id; // also accepts a full Notion URL
  try {
    const db = await notion('/databases/' + id);
    if (db.data_sources && db.data_sources[0]) return db.data_sources[0].id;
  } catch (e) { /* not a database ID: assume it is already a data source ID */ }
  return id;
}

async function queryAll(dbId) {
  const ds = await sourceId(dbId);
  let out = [], cursor;
  do {
    const j = await notion('/data_sources/' + ds + '/query', {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

const titleOf = (page) => {
  const t = Object.values(page.properties).find((p) => p.type === 'title');
  return t ? t.title.map((x) => x.plain_text).join('').trim() : '';
};

// Relations only give IDs, so look up each linked page's title (in small batches).
async function namesFor(ids) {
  const names = {};
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (id) => {
      try { names[id] = titleOf(await notion('/pages/' + id)); } catch (e) { names[id] = ''; }
    }));
  }
  return names;
}

// Find a property by name, ignoring capitals, spaces and brackets ("Date Finished" = "date finished").
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const prop = (pr, name) => pr[name] || pr[Object.keys(pr).find((k) => norm(k) === norm(name))];

const relIds = (p) => (p && p.type === 'relation' ? p.relation.map((x) => x.id) : []);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const dateOf = (p) => (p && p.type === 'date' && p.date ? p.date.start.slice(0, 10) : null);

function ratingOf(p) {
  if (!p) return 0;
  let v = 0;
  if (p.type === 'number') v = p.number || 0;
  else if (p.type === 'select' && p.select) v = (p.select.name.match(/[⭐★]/g) || []).length || parseFloat(p.select.name) || 0;
  else if (p.type === 'formula' && p.formula.type === 'number') v = p.formula.number || 0;
  return Math.max(0, Math.min(5, Math.round(v)));
}

module.exports = async (req, res) => {
  try {
    // Private shelf: only answer when the link carries your key (?key=...). Set SHELF_KEY in Vercel.
    if (process.env.SHELF_KEY && req.query.key !== process.env.SHELF_KEY)
      return res.status(401).json({ error: 'This shelf is private.' });
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_BOOKS_DB)
      return res.status(500).json({ error: 'Set NOTION_TOKEN and NOTION_BOOKS_DB in Vercel.' });

    const year = String(req.query.year || new Date().getFullYear());
    const pages = await queryAll(process.env.NOTION_BOOKS_DB);

    // ?fields=1 lists your property names, their types, and how many books have each filled in (no values).
    if (req.query.fields) {
      const out = {};
      for (const pg of pages) for (const [k, v] of Object.entries(pg.properties)) {
        out[k] = out[k] || { type: v.type, filled: 0 };
        const val = v[v.type];
        if (val !== null && val !== false && !(Array.isArray(val) && !val.length)) out[k].filled++;
      }
      return res.status(200).json({ books: pages.length, fields: out });
    }

    // keep finished books whose finish (or start) date falls in the chosen year
    const mine = pages.filter((pg) => {
      const st = prop(pg.properties, PROPS.status);
      const name = st && (st.status || st.select) ? (st.status || st.select).name.toLowerCase() : '';
      if (name !== READ_STATUS) return false;
      if (year === 'all') return true;
      const d = dateOf(prop(pg.properties, PROPS.finished)) || dateOf(prop(pg.properties, PROPS.started));
      return d && d.startsWith(year);
    });

    const names = await namesFor(mine.flatMap((pg) => [
      ...relIds(prop(pg.properties, PROPS.author)).slice(0, 1),
      ...relIds(prop(pg.properties, PROPS.genre)).slice(0, 1),
    ]));

    const books = mine.map((pg) => {
      const pr = pg.properties;
      const fin = dateOf(prop(pr, PROPS.finished));
      const start = dateOf(prop(pr, PROPS.started));
      const n = fin && start ? Math.max(1, Math.round((new Date(fin) - new Date(start)) / 864e5)) : null;
      const r = ratingOf(prop(pr, PROPS.rating));
      const favBox = prop(pr, PROPS.favourite);
      return {
        t: titleOf(pg) || 'Untitled',
        a: names[relIds(prop(pr, PROPS.author))[0]] || 'Unknown',
        g: (names[relIds(prop(pr, PROPS.genre))[0]] || 'other').toLowerCase(),
        p: prop(pr, PROPS.pages) && prop(pr, PROPS.pages).number ? prop(pr, PROPS.pages).number : null,
        r,
        d: fin,
        n,
        f: favBox && favBox.type === 'checkbox' ? favBox.checkbox : r >= 5,
      };
    });

    // optional: your full genre list (with each genre's emoji icon) so the widget matches your Notion
    let genres;
    if (process.env.NOTION_GENRES_DB) {
      const gp = await queryAll(process.env.NOTION_GENRES_DB);
      genres = gp
        .map((x) => ({ name: titleOf(x).toLowerCase(), icon: x.icon && x.icon.type === 'emoji' ? x.icon.emoji : null }))
        .filter((x) => x.name);
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ year, books, genres });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
