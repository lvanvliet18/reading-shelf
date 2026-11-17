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
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
});

async function notion(path, opts) {
  const r = await fetch(API + path, { headers: headers(), ...opts });
  if (!r.ok) throw new Error('Notion ' + r.status + ': ' + (await r.text()).slice(0, 300));
  return r.json();
}

async function queryAll(dbId) {
  let out = [], cursor;
  do {
    const j = await notion('/databases/' + dbId + '/query', {
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
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_BOOKS_DB)
      return res.status(500).json({ error: 'Set NOTION_TOKEN and NOTION_BOOKS_DB in Vercel.' });

    const year = String(req.query.year || new Date().getFullYear());
    const pages = await queryAll(process.env.NOTION_BOOKS_DB);

    // keep finished books whose finish (or start) date falls in the chosen year
    const mine = pages.filter((pg) => {
      const st = pg.properties[PROPS.status];
      const name = st && (st.status || st.select) ? (st.status || st.select).name.toLowerCase() : '';
      if (name !== READ_STATUS) return false;
      if (year === 'all') return true;
      const d = dateOf(pg.properties[PROPS.finished]) || dateOf(pg.properties[PROPS.started]);
      return d && d.startsWith(year);
    });

    const names = await namesFor(mine.flatMap((pg) => [
      ...relIds(pg.properties[PROPS.author]).slice(0, 1),
      ...relIds(pg.properties[PROPS.genre]).slice(0, 1),
    ]));

    const books = mine.map((pg) => {
      const pr = pg.properties;
      const fin = dateOf(pr[PROPS.finished]);
      const start = dateOf(pr[PROPS.started]);
      const n = fin && start ? Math.max(1, Math.round((new Date(fin) - new Date(start)) / 864e5)) : null;
      const r = ratingOf(pr[PROPS.rating]);
      const favBox = pr[PROPS.favourite];
      return {
        t: titleOf(pg) || 'Untitled',
        a: names[relIds(pr[PROPS.author])[0]] || 'Unknown',
        g: (names[relIds(pr[PROPS.genre])[0]] || 'other').toLowerCase(),
        p: pr[PROPS.pages] && pr[PROPS.pages].number ? pr[PROPS.pages].number : null,
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
