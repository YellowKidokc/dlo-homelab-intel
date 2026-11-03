// ============================================================
// DLO HOMELAB INTEL — Prophecy Intelligence Platform
// Single-file Cloudflare Worker: RSS ingest + Coherence Scorer v2.0
// (JS port) + community ratings (1-10, multi-axis above threshold)
// Storage: D1 (binding: DB). Cron: batch ingest on schedule (rotating
// through the stalest feeds each run). No AI per item — scoring is
// lexical, free, instant, at ingest.
// Memory: rolling 90-day archive per source; anything scoring >= 8.0
// relevance is auto-saved and kept forever.
// Also serves the legacy prophecy-platform SPA contract
// (/api/live-feeds, /api/live-feed/:id) from the same DB, and passes
// all other traffic through to the static site (binding: ASSETS).
// ============================================================

// ------------------------------------------------------------
// SCORER — Prophecy Coherence Scorer v2.0 (JS port of POF 2828)
// ------------------------------------------------------------

const COHERENCE_TERMS = {
  logos:3, coherent:3, coherence:3, constraint:3, constrain:3,
  quantum:3, decoherence:3, wavefunction:3,
  bound:2, limit:2, restrict:2, order:2, structure:2, framework:2,
  principle:2, unified:2, unity:2, integrated:2, truth:2, justice:2,
  purpose:2, fundamental:2, essential:2, creator:2, divine:2,
  necessary:2, conservation:2, entropy:2, observer:2, collapse:2,
  grace:2, atonement:2, resurrection:2, isomorphism:2, axiom:2,
  theorem:2, measurement:2, superposition:2, photon:2, spacetime:2,
  information:2, correction:2, encode:2, covenant:2, sovereignty:2,
  righteous:2, holiness:2,
  system:1.5, law:1.5, rule:1.5, true:1.5, just:1.5, wave:1.5,
  field:1.5, error:1.5, prophecy:1.5, fulfillment:1.5, tribulation:1.5,
  revelation:1.5, judgment:1.5, kingdom:1.5, temple:1.5,
  antichrist:1.5, beast:1.5,
};

const ENTROPY_TERMS = {
  synergy:-2, leverage:-1.5, stakeholder:-1.5, paradigm:-1,
  arbitrary:-2, basically:-1, "kind of":-1, "sort of":-1, maybe:-0.5,
  random:-1.5, narrative:-1, optics:-1.5, "moving forward":-1.5,
  "at the end of the day":-1, "reaching across the aisle":-1.5,
  "thoughts and prayers":-2, "historic moment":-1, unprecedented:-1,
  "game changer":-1.5, pivot:-1, robust:-0.5, streamline:-1,
};

const STRUCTURAL_PATTERNS = [
  [/\b(whereas|therefore|hence|thus|accordingly)\b/g, 2],
  [/\b(first|second|third|fourth)\b/g, 1],
  [/\b(shall|must|will)\b/g, 1],
  [/\b(if|then|when|unless)\b/g, 0.5],
];

const WISDOM_TERMS = [
  "wisdom","discernment","eternal","transcend","revelation","mystery",
  "grace","covenant","truth","logos","spirit","divine","sacred","holy",
  "virtue","righteousness","soul","prayer","faith","love","hope",
  "redemption","atonement","resurrection","kingdom","repentance",
  "sanctification","glorification","salvation","mercy","forgiveness",
];

const KNOWLEDGE_TERMS = [
  "data","evidence","experiment","measure","calculate","equation",
  "formula","theorem","proof","derive","quantum","physics","entropy",
  "probability","statistical","empirical","observation","hypothesis",
  "analysis","laboratory","sigma","decoherence","wavefunction",
  "superposition","photon","spacetime","information","variable",
  "parameter",
];

const FRUITS = {
  love:["love","care","sacrifice","relational","agape","charity"],
  joy:["joy","delight","flourish","rejoice","gladness"],
  peace:["peace","harmony","noncontradiction","rest","shalom","reconciliation"],
  patience:["patience","wait","endure","persist","long-suffering","forbearance"],
  kindness:["kind","tender","compassion","mercy","benevolence"],
  goodness:["good","righteous","integrity","upright","virtue"],
  faithfulness:["faithful","reliable","consistent","steadfast","covenant","loyal"],
  gentleness:["gentle","meek","humble","lowly","mild"],
  self_control:["self-control","discipline","restrain","temperance","govern"],
  grace:["grace","unmerited","freely","gift"],
  hope:["hope","future","promise","expectation"],
  humility:["humble","humility","servant","lowliness"],
};

const PERFORMANCE_TERMS = [
  "committed to","deeply concerned","stand with","fight for",
  "the american people","our values","bipartisan","coalition",
  "moving forward","historic","unprecedented","bold action",
  "common ground","bridge the divide","the right thing",
  "make no mistake","let me be clear","comprehensive plan",
  "holistic approach","inclusive","equitable","sustainable",
  "resilient","transformative","game-changing","world-class",
  "best practices","going forward","at this juncture","in terms of",
  "with respect to","double down","lean in","circle back","unpack",
  "drill down","take a hard look","on the table","off the table",
  "boots on the ground","skin in the game",
];

const SCRIPTURE_RE = /\b\d+:\d+\b|\b(genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\b/g;
const CROSS_DOMAIN_RE = /\b(isomorphism|maps to|maps onto|analogous|parallel|mirror|dual|correspond)\b/g;
const AXIOM_RE = /\b(axiom|law \d|principle \d|theorem|law of)\b/g;

function countOccurrences(haystack, term) {
  // substring count, matching the Python str.count semantics
  let n = 0, i = 0;
  while ((i = haystack.indexOf(term, i)) !== -1) { n++; i += term.length; }
  return n;
}
function reCount(re, text) {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}
const clamp10 = (v) => Math.min(10, Math.max(0, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function scoreText(text) {
  const tl = (text || "").toLowerCase();
  const wc = tl.split(/\s+/).filter(Boolean).length;
  if (!wc) return null;
  const norm = 1000 / wc;

  let cs = 0; for (const [t, w] of Object.entries(COHERENCE_TERMS)) cs += countOccurrences(tl, t) * w * norm;
  let es = 0; for (const [t, w] of Object.entries(ENTROPY_TERMS)) es += countOccurrences(tl, t) * w * norm;
  let ss = 0; for (const [re, w] of STRUCTURAL_PATTERNS) ss += reCount(re, tl) * w * norm;
  const chi = r2(clamp10((cs + es + ss) / 10));

  const wsCnt = WISDOM_TERMS.reduce((a, t) => a + countOccurrences(tl, t), 0);
  const ksCnt = KNOWLEDGE_TERMS.reduce((a, t) => a + countOccurrences(tl, t), 0);
  const wkRatio = r3(wsCnt / Math.max(ksCnt, 1));
  const wkStatus = wkRatio >= 1.5 ? "WISDOM-LED" : wkRatio >= 1.0 ? "BALANCED" : wkRatio >= 0.5 ? "KNOWLEDGE-DOMINANT" : "KNOWLEDGE-ONLY";

  const fruitsDetail = {};
  let fruitsTotal = 0;
  for (const [f, kws] of Object.entries(FRUITS)) {
    fruitsDetail[f] = kws.reduce((a, t) => a + countOccurrences(tl, t), 0);
    fruitsTotal += fruitsDetail[f];
  }
  const fruitsNorm = r2(clamp10(fruitsTotal * norm / 5));

  const axioms = reCount(AXIOM_RE, tl);
  const scriptureRefs = reCount(SCRIPTURE_RE, tl);
  const crossDomain = reCount(CROSS_DOMAIN_RE, tl);

  const perfCount = PERFORMANCE_TERMS.reduce((a, t) => a + countOccurrences(tl, t), 0);
  const perfDensity = r2(perfCount * norm);

  let benford = 0; const flags = [];
  if (chi >= 5 && fruitsNorm < 2.0) { benford += 2.0; flags.push("HIGH_CHI_LOW_FRUITS"); }
  if (chi >= 5 && wkRatio < 0.5) { benford += 2.0; flags.push("HIGH_CHI_LOW_WISDOM"); }
  if (perfDensity > 5.0) { benford += 3.0; flags.push("HEAVY_PERFORMANCE_LANGUAGE"); }
  else if (perfDensity > 2.0) { benford += 1.5; flags.push("MODERATE_PERFORMANCE_LANGUAGE"); }
  if (fruitsNorm < 1.0 && perfDensity > 3.0) { benford += 2.0; flags.push("HOLLOW_SIGNAL"); }
  const entropyRatio = cs > 0 ? r3(Math.abs(es) / Math.max(cs, 1)) : 0;
  if (entropyRatio > 0.15) { benford += 1.0; flags.push("HIGH_ENTROPY_RATIO"); }
  benford = r2(clamp10(benford));

  const benfordVerdict = benford >= 7 ? "FALSE SIGNAL — TRAINED PERFORMER"
    : benford >= 4 ? "SUSPICIOUS — HOLLOW COHERENCE"
    : benford >= 2 ? "MIXED — SOME PERFORMANCE LANGUAGE" : "CLEAN";

  const chiStatus = chi >= 8 ? "HIGH COHERENCE" : chi >= 6 ? "STRONG" : chi >= 4 ? "MODERATE" : "WEAK";

  let relevance = r2(
    chi * 0.30 +
    (Math.min(wkRatio, 3.0) / 3.0) * 10 * 0.20 +
    fruitsNorm * 0.20 +
    Math.min(scriptureRefs * norm, 10) * 0.15 +
    Math.min(crossDomain * norm * 2, 10) * 0.15 -
    benford * 0.30
  );
  relevance = r2(clamp10(relevance));

  return {
    word_count: wc, chi, chiStatus, wkRatio, wkStatus,
    fruits: fruitsNorm, fruitsDetail, axioms, scriptureRefs, crossDomain,
    perfDensity, benford, benfordFlags: flags, benfordVerdict,
    entropyRatio, relevance,
  };
}

// ------------------------------------------------------------
// WATCHLIST — the 12 live triggers (from the About page)
// ------------------------------------------------------------
const WATCHLIST = [
  "Abrahamic Land Covenant", "Israel's Inheritance",
  "Regathering & Repentance", "Rapture / Church",
  "Mark of the Beast", "Antichrist's Covenant",
  "Third Temple Readiness", "Abomination of Desolation",
  "World Church", "Babylon Economic System",
  "Paradise Restored", "Gog & Magog Coalition",
];

// Seed registry — recovered from the original prophecy-platform worker
const SEED_FEEDS = [
  ["444 Prophecy News", "https://444prophecynews.com/feed/", 0],
  ["Prophecy Tracker", "https://prophecytracker.org/feed/", 0],
  ["Bible and Tech", "http://bibleandtech.blogspot.com/feeds/posts/default", 4],
  ["Blue Star Prophecy", "http://www.bluestarprophecy.com/feed", 0],
  ["Lamb & Lion Ministries", "http://www.lamblion.com/llmfeed.xml", 0],
  ["Christ in Prophecy Blog (comments)", "https://christinprophecyblog.org/comments/feed/", 0],
  ["Endtime Bible Prophecy", "https://endtimebibleprophecy.wordpress.com/feed/", 0],
  ["Experimental Theology", "https://experimentaltheology.blogspot.com/feeds/posts/default", 0],
  ["Learn Bible Prophecy", "http://learnbibleprophecy.blogspot.com/feeds/posts/default", 0],
  ["Logos Bible Software Blog", "https://feeds.feedburner.com/LogosBibleSoftwareBlog", 0],
  ["CYB Detective", "https://cybdetective.substack.com/feed", 4],
  ["David D Friedman", "https://daviddfriedman.substack.com/feed", 0],
  ["Joe Carlsmith", "https://joecarlsmith.substack.com/feed", 0],
  ["Eric Capuano", "https://blog.ecapuano.com/feed", 4],
  ["Google Apps Status", "https://www.google.com/appsstatus/rss/en", 0],
  ["YouTube Watch Channel", "https://www.youtube.com/feeds/videos.xml?channel_id=UCk-F2o6_WOoW0KDkbGyeV9A", 0],
  ["Google Alert — Temple", "https://www.google.com/alerts/feeds/15176332495880826276/12594745804474927453", 6],
  ["Google Alert — Israel", "https://www.google.com/alerts/feeds/15176332495880826276/12594745804474928163", 1],
  ["Google Alert — Prophecy", "https://www.google.com/alerts/feeds/15176332495880826276/11257478638094503467", 0],
  ["Google Alert — Antichrist", "https://www.google.com/alerts/feeds/15176332495880826276/14618399849164233376", 5],
  ["Google Alert — Watch 2", "https://www.google.com/alerts/feeds/14897380747082316286/3705796879920382624", 0],
  ["Google Alert — Watch 3", "https://www.google.com/alerts/feeds/15176332495880826276/2666398180537349301", 0],
  ["Google Alert — Watch 4", "https://www.google.com/alerts/feeds/15176332495880826276/12489299453569208230", 0],
  ["Google Alert — Watch 5", "https://www.google.com/alerts/feeds/15176332495880826276/14618399849164234029", 5],
  ["Google Alert — Watch 6", "https://www.google.com/alerts/feeds/15176332495880826276/14618399849164232008", 5],
  ["Google Alert — Watch 7", "https://www.google.com/alerts/feeds/15176332495880826276/9855882865667556840", 9],
  ["Google Alert — Watch 8", "https://www.google.com/alerts/feeds/15176332495880826276/14618399849164231578", 5],
  ["Google Alert — Watch 9", "https://www.google.com/alerts/feeds/15176332495880826276/11257478638094502658", 0],
  ["Google Alert — Watch 10", "https://www.google.com/alerts/feeds/15176332495880826276/2851766286909613721", 11],
  ["Google Alert — Watch 11", "https://www.google.com/alerts/feeds/15176332495880826276/9855882865667555403", 9],
  ["Google Alert — Watch 12", "https://www.google.com/alerts/feeds/15176332495880826276/9855882865667558188", 9],
  ["Google Alert — Watch 13", "https://www.google.com/alerts/feeds/15176332495880826276/4607734209744357125", 4],
  ["Google Alert — Watch 14", "https://www.google.com/alerts/feeds/15176332495880826276/2666398180537349444", 0],
  ["Google Alert — Watch 15", "https://www.google.com/alerts/feeds/15176332495880826276/11257478638094503118", 0],
  ["Google Alert — Watch 16", "https://www.google.com/alerts/feeds/15176332495880826276/12489299453569206757", 6],
  ["Google Alert — Watch 17", "https://www.google.com/alerts/feeds/15176332495880826276/12489299453569206674", 6],
  ["Google Alert — Watch 18", "https://www.google.com/alerts/feeds/15176332495880826276/2666398180537351514", 10],
  ["Google Alert — Watch 19", "https://www.google.com/alerts/feeds/15176332495880826276/2666398180537349797", 0],
  ["Google Alert — Watch 20", "https://www.google.com/alerts/feeds/15176332495880826276/12594745804474926979", 0],
  ["Google Alert — Watch 21", "https://www.google.com/alerts/feeds/15176332495880826276/2666398180537351495", 0],
];

// ------------------------------------------------------------
// D1 SCHEMA
// ------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  watchlist INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_ok TEXT, last_error TEXT, last_status INTEGER, last_try TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_aliases (
  alias TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id)
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id),
  title TEXT NOT NULL,
  link TEXT,
  summary TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  words INTEGER DEFAULT 0,
  chi REAL, chi_status TEXT,
  wk_ratio REAL, wk_status TEXT,
  fruits REAL, scripture_refs INTEGER, cross_domain INTEGER,
  benford REAL, benford_verdict TEXT, benford_flags TEXT,
  relevance REAL,
  saved INTEGER NOT NULL DEFAULT 0,
  rated_avg REAL, rated_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_rel ON items(relevance DESC);
CREATE INDEX IF NOT EXISTS idx_items_feed ON items(feed_id);
CREATE INDEX IF NOT EXISTS idx_items_saved ON items(saved);
CREATE TABLE IF NOT EXISTS ratings (
  item_id TEXT NOT NULL REFERENCES items(id),
  rater TEXT NOT NULL,
  score INTEGER NOT NULL,
  axes TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, rater)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL, kind TEXT NOT NULL,
  feeds_ok INTEGER, feeds_fail INTEGER, items_new INTEGER, ms INTEGER
);
`;

// Anything scoring this or better is auto-saved and kept forever.
const SAVE_THRESHOLD = 8.0;
// Rolling archive window for everything else.
const RETENTION_DAYS = 90;

async function ensureSchema(db) {
  const flag = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feeds'").first();
  if (!flag) {
    for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT OR IGNORE INTO feeds (id, name, url, watchlist, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const batch = SEED_FEEDS.map(([name, url, w]) =>
      ins.bind(feedId(url), name, url, w,
        url.includes("google.com/alerts") ? "Google Alert" : "RSS", now));
    for (let i = 0; i < batch.length; i += 50) {
      await db.batch(batch.slice(i, i + 50));
    }
  }
  // ---- idempotent migrations for existing databases ----
  const { results: itemCols } = await db.prepare("PRAGMA table_info(items)").all();
  if (!itemCols.map(c => c.name).includes("saved")) {
    await db.prepare("ALTER TABLE items ADD COLUMN saved INTEGER NOT NULL DEFAULT 0").run();
    // backfill: everything already at 8+ is saved forever
    await db.prepare("UPDATE items SET saved = 1 WHERE relevance >= ?").bind(SAVE_THRESHOLD).run();
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_items_saved ON items(saved)").run();
  const { results: feedCols } = await db.prepare("PRAGMA table_info(feeds)").all();
  const fc = feedCols.map(c => c.name);
  if (!fc.includes("kind")) {
    await db.prepare("ALTER TABLE feeds ADD COLUMN kind TEXT").run();
    await db.prepare("UPDATE feeds SET kind = CASE WHEN url LIKE '%google.com/alerts%' THEN 'Google Alert' ELSE 'RSS' END WHERE kind IS NULL").run();
  }
  if (!fc.includes("last_try")) {
    await db.prepare("ALTER TABLE feeds ADD COLUMN last_try TEXT").run();
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS feed_aliases (
    alias TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL REFERENCES feeds(id)
  )`).run();
}

function feedId(url) {
  // stable 16-hex id (FNV-1a x2)
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
async function sha1hex(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------
// RSS / ATOM PARSER (dependency-free, streaming-free, compact)
// ------------------------------------------------------------
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
}
function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(xml, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, "i");
    const m = xml.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return "";
}
function linkOf(entryXml) {
  // atom: <link href="..."/> ; rss: <link>...</link>
  const atomLinks = [...entryXml.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  for (const l of atomLinks) {
    const rel = l.match(/rel=["']([^"']*)["']/i);
    const href = l.match(/href=["']([^"']*)["']/i);
    if (href && (!rel || rel[1] === "alternate")) return href[1];
  }
  const t = tag(entryXml, ["link"]);
  return t || "";
}

function parseFeed(xml) {
  xml = xml.replace(/^\uFEFF/, "").trim();
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000));
  const entryRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const entries = xml.match(entryRe) || [];
  for (const e of entries.slice(0, 100)) {
    const title = stripHtml(tag(e, ["title"]));
    if (!title) continue;
    const link = linkOf(e);
    const summary = stripHtml(tag(e, ["content:encoded", "content", "description", "summary"])).slice(0, 4000);
    const guid = tag(e, ["guid", "id"]) || link || title;
    const dateRaw = tag(e, ["pubDate", "published", "updated", "dc:date", "date"]);
    let published = null;
    if (dateRaw) { const d = new Date(dateRaw); if (!isNaN(d)) published = d.toISOString(); }
    items.push({ title, link, summary, guid, published });
  }
  return items;
}

// ------------------------------------------------------------
// INGEST — fetch all active feeds, score every new item
// ------------------------------------------------------------
async function ingestAll(db, { onlyFeedId = null } = {}) {
  const t0 = Date.now();
  await ensureSchema(db);
  const q = onlyFeedId
    ? db.prepare("SELECT * FROM feeds WHERE id = ?").bind(onlyFeedId)
    // rotating window: each run takes the stalest active feeds, so a large
    // registry cycles through fully every few hours instead of every run
    : db.prepare("SELECT * FROM feeds WHERE active = 1 ORDER BY COALESCE(last_try, last_ok, '1970-01-01') ASC LIMIT 45");
  const { results: feeds } = await q.all();
  let ok = 0, fail = 0, added = 0;

  const CONCURRENCY = 6;
  const insertStmt = `INSERT OR IGNORE INTO items
    (id, feed_id, title, link, summary, published_at, fetched_at, words,
     chi, chi_status, wk_ratio, wk_status, fruits, scripture_refs,
     cross_domain, benford, benford_verdict, benford_flags, relevance, saved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  for (let i = 0; i < feeds.length; i += CONCURRENCY) {
    const group = feeds.slice(i, i + CONCURRENCY);
    await Promise.all(group.map(async (feed) => {
      const now = new Date().toISOString();
      try {
        const res = await fetch(feed.url, {
          signal: AbortSignal.timeout(12000),
          headers: {
            "User-Agent": "DLO-HomeLab-Intel/1.0 (+prophecy watch)",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          },
          redirect: "follow",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const xml = await res.text();
        const parsed = parseFeed(xml);
        const stmts = [];
        for (const it of parsed) {
          const id = await sha1hex(feed.id + "|" + it.guid);
          const s = scoreText(it.title + "\n\n" + it.summary);
          stmts.push(db.prepare(insertStmt).bind(
            id, feed.id, it.title.slice(0, 500), (it.link || "").slice(0, 1000),
            it.summary, it.published, now,
            s ? s.word_count : 0,
            s ? s.chi : 0, s ? s.chiStatus : "WEAK",
            s ? s.wkRatio : 0, s ? s.wkStatus : "KNOWLEDGE-ONLY",
            s ? s.fruits : 0, s ? s.scriptureRefs : 0, s ? s.crossDomain : 0,
            s ? s.benford : 0, s ? s.benfordVerdict : "CLEAN",
            s ? JSON.stringify(s.benfordFlags) : "[]",
            s ? s.relevance : 0,
            s && s.relevance >= SAVE_THRESHOLD ? 1 : 0
          ));
        }
        for (let j = 0; j < stmts.length; j += 50) {
          const r = await db.batch(stmts.slice(j, j + 50));
          added += r.reduce((a, x) => a + (x.meta?.changes || 0), 0);
        }
        await db.prepare(
          "UPDATE feeds SET last_ok = ?, last_error = NULL, last_status = 200, last_try = ?, item_count = (SELECT COUNT(*) FROM items WHERE feed_id = ?) WHERE id = ?"
        ).bind(now, now, feed.id, feed.id).run();
        ok++;
      } catch (err) {
        await db.prepare(
          "UPDATE feeds SET last_error = ?, last_status = 0, last_try = ? WHERE id = ?"
        ).bind(String(err).slice(0, 300), new Date().toISOString(), feed.id).run();
        fail++;
      }
    }));
  }

  // retention: rolling 90-day archive — but saved items (8+ relevance)
  // are kept forever, so the strongest signals are never purged
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  await db.prepare("DELETE FROM items WHERE saved = 0 AND COALESCE(published_at, fetched_at) < ?").bind(cutoff).run();
  // safety valve so an unsaved flood can never grow the archive unbounded
  await db.prepare(`DELETE FROM items WHERE saved = 0 AND id NOT IN (
    SELECT id FROM items WHERE saved = 0 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 100000)`).run();
  await db.prepare("INSERT INTO runs (ran_at, kind, feeds_ok, feeds_fail, items_new, ms) VALUES (?,?,?,?,?,?)")
    .bind(new Date().toISOString(), onlyFeedId ? "single" : "batch", ok, fail, added, Date.now() - t0).run();
  return { feeds: feeds.length, ok, fail, added, ms: Date.now() - t0 };
}

// ------------------------------------------------------------
// HTTP API
// ------------------------------------------------------------
const RATING_AXES = ["reliability", "relevance", "significance", "urgency"];
const AXIS_UNLOCK_AVG = 7.0;      // multi-axis unlocks at community avg >= 7/10
const AXIS_UNLOCK_COUNT = 3;      // ...and at least 3 ratings

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
function raterId(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)dlo_rater=([a-zA-Z0-9\-]+)/);
  return m ? m[1] : null;
}

async function handleApi(request, env, url) {
  const db = env.DB;
  const path = url.pathname;

  if (path === "/api/state") {
    await ensureSchema(db);
    const [stats] = (await db.prepare(`SELECT
        (SELECT COUNT(*) FROM feeds WHERE active=1) AS feeds_active,
        (SELECT COUNT(*) FROM feeds) AS feeds_total,
        (SELECT COUNT(*) FROM items) AS items_total,
        (SELECT COUNT(*) FROM items WHERE saved=1) AS saved_total,
        (SELECT COUNT(*) FROM ratings) AS ratings_total,
        (SELECT COUNT(*) FROM items WHERE benford >= 4) AS false_signals
      `).all()).results;
    const lastRun = await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
    return json({ stats, lastRun, watchlist: WATCHLIST, axisUnlock: { avg: AXIS_UNLOCK_AVG, count: AXIS_UNLOCK_COUNT } });
  }

  // ---- legacy prophecy-platform SPA contract (DB-backed, 90-day depth) ----
  if (path === "/api/live-feeds") {
    await ensureSchema(db);
    const { results } = await db.prepare(
      "SELECT id, name, url, kind FROM feeds WHERE active = 1 ORDER BY name"
    ).all();
    return json(results.map(f => ({
      id: f.id, name: f.name,
      kind: f.kind || (f.url.includes("google.com/alerts") ? "Google Alert" : "RSS"),
    })));
  }

  if (path.startsWith("/api/live-feed/")) {
    await ensureSchema(db);
    const reqId = decodeURIComponent(path.split("/").pop());
    // resolve by primary id, or by the original site's feed id (alias)
    let feed = await db.prepare("SELECT * FROM feeds WHERE id = ?").bind(reqId).first();
    if (!feed) {
      const alias = await db.prepare("SELECT feed_id FROM feed_aliases WHERE alias = ?").bind(reqId).first();
      if (alias) feed = await db.prepare("SELECT * FROM feeds WHERE id = ?").bind(alias.feed_id).first();
    }
    if (!feed) return json({ error: "Unknown feed" }, 404);
    const itemsQ = `SELECT id, title, link, summary, published_at, fetched_at
                    FROM items WHERE feed_id = ?
                    ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 300`;
    let { results: items } = await db.prepare(itemsQ).bind(feed.id).all();
    if (!items.length) {
      // nothing stored yet — pull it live so the page is never empty
      try { await ingestAll(db, { onlyFeedId: feed.id }); } catch { /* fall through */ }
      ({ results: items } = await db.prepare(itemsQ).bind(feed.id).all());
      feed = await db.prepare("SELECT * FROM feeds WHERE id = ?").bind(feed.id).first();
    }
    return json({
      id: reqId,
      name: feed.name,
      status: feed.last_error ? "Error" : "Connected",
      error: feed.last_error || undefined,
      checkedAt: feed.last_ok || feed.last_try || new Date().toISOString(),
      articles: items.map((it, i) => ({
        id: reqId + "-" + i,
        title: it.title,
        url: it.link,
        link: it.link,
        source: feed.name,
        date: it.published_at || it.fetched_at,
        summary: (it.summary || "").slice(0, 500),
      })),
    });
  }

  if (path === "/api/items") {
    await ensureSchema(db);
    const w = url.searchParams.get("watchlist");
    const feedF = url.searchParams.get("feed");
    const savedF = url.searchParams.get("saved");
    const sort = url.searchParams.get("sort") || "new";
    const q = (url.searchParams.get("q") || "").trim();
    const minRel = parseFloat(url.searchParams.get("min_rel") || "0");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 300);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const order = {
      new: "COALESCE(i.published_at, i.fetched_at) DESC",
      relevance: "i.relevance DESC",
      chi: "i.chi DESC",
      rated: "i.rated_avg DESC, i.rated_count DESC",
      benford: "i.benford DESC",
    }[sort] || "COALESCE(i.published_at, i.fetched_at) DESC";
    let where = "WHERE i.relevance >= ?";
    const binds = [minRel];
    if (savedF === "1") where += " AND i.saved = 1";
    if (feedF) { where += " AND i.feed_id = ?"; binds.push(feedF); }
    if (w !== null && w !== "" && w !== "all") { where += " AND f.watchlist = ?"; binds.push(parseInt(w)); }
    if (q) { where += " AND (i.title LIKE ? OR i.summary LIKE ?)"; binds.push(`%${q}%`, `%${q}%`); }
    const { results } = await db.prepare(
      `SELECT i.id, i.title, i.link, i.summary, i.published_at, i.fetched_at,
              i.chi, i.chi_status, i.wk_ratio, i.wk_status, i.fruits,
              i.scripture_refs, i.cross_domain, i.benford, i.benford_verdict,
              i.relevance, i.saved, i.rated_avg, i.rated_count,
              f.name AS feed_name, f.watchlist
       FROM items i JOIN feeds f ON f.id = i.feed_id
       ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all();
    // attach this rater's own ratings
    const rid = raterId(request);
    let mine = {};
    if (rid && results.length) {
      const ids = results.map(r => r.id);
      const ph = ids.map(() => "?").join(",");
      const { results: myRows } = await db.prepare(
        `SELECT item_id, score, axes FROM ratings WHERE rater = ? AND item_id IN (${ph})`
      ).bind(rid, ...ids).all();
      for (const r of myRows) mine[r.item_id] = { score: r.score, axes: safeParse(r.axes) };
    }
    return json({ items: results.map(r => ({ ...r, my: mine[r.id] || null })) });
  }

  if (path === "/api/item") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const item = await db.prepare(
      `SELECT i.*, f.name AS feed_name, f.watchlist FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?`
    ).bind(id).first();
    if (!item) return json({ error: "not found" }, 404);
    const { results: dist } = await db.prepare(
      "SELECT score, COUNT(*) AS n FROM ratings WHERE item_id = ? GROUP BY score ORDER BY score"
    ).bind(id).all();
    const { results: axesRows } = await db.prepare(
      "SELECT axes FROM ratings WHERE item_id = ? AND axes IS NOT NULL"
    ).bind(id).all();
    const axisAgg = {};
    for (const a of RATING_AXES) axisAgg[a] = { sum: 0, n: 0 };
    for (const r of axesRows) {
      const ax = safeParse(r.axes);
      if (!ax) continue;
      for (const a of RATING_AXES) if (typeof ax[a] === "number") { axisAgg[a].sum += ax[a]; axisAgg[a].n++; }
    }
    const axes = {};
    for (const a of RATING_AXES) axes[a] = axisAgg[a].n ? r2(axisAgg[a].sum / axisAgg[a].n) : null;
    const rid = raterId(request);
    const my = rid ? await db.prepare("SELECT score, axes FROM ratings WHERE item_id = ? AND rater = ?").bind(id, rid).first() : null;
    return json({ item, dist, axes, my: my ? { score: my.score, axes: safeParse(my.axes) } : null,
      unlocked: (item.rated_avg || 0) >= AXIS_UNLOCK_AVG && (item.rated_count || 0) >= AXIS_UNLOCK_COUNT });
  }

  if (path === "/api/rate" && request.method === "POST") {
    let rid = raterId(request);
    const setCookie = !rid;
    if (!rid) rid = crypto.randomUUID();
    const body = await request.json().catch(() => null);
    if (!body || !body.item_id) return json({ error: "item_id required" }, 400);
    const score = parseInt(body.score);
    if (!(score >= 1 && score <= 10)) return json({ error: "score must be 1-10" }, 400);
    const item = await db.prepare("SELECT id, rated_avg, rated_count FROM items WHERE id = ?").bind(body.item_id).first();
    if (!item) return json({ error: "unknown item" }, 404);

    let axes = null;
    const unlocked = (item.rated_avg || 0) >= AXIS_UNLOCK_AVG && (item.rated_count || 0) >= AXIS_UNLOCK_COUNT;
    if (unlocked && body.axes && typeof body.axes === "object") {
      axes = {};
      for (const a of RATING_AXES) {
        const v = parseInt(body.axes[a]);
        if (v >= 1 && v <= 10) axes[a] = v;
      }
      if (!Object.keys(axes).length) axes = null;
    }

    await db.prepare(
      `INSERT INTO ratings (item_id, rater, score, axes, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(item_id, rater) DO UPDATE SET score = excluded.score, axes = excluded.axes, created_at = excluded.created_at`
    ).bind(body.item_id, rid, score, axes ? JSON.stringify(axes) : null, new Date().toISOString()).run();

    const agg = await db.prepare("SELECT AVG(score) AS avg, COUNT(*) AS n FROM ratings WHERE item_id = ?").bind(body.item_id).first();
    await db.prepare("UPDATE items SET rated_avg = ?, rated_count = ? WHERE id = ?")
      .bind(r2(agg.avg), agg.n, body.item_id).run();

    return json({ ok: true, rated_avg: r2(agg.avg), rated_count: agg.n, unlocked: r2(agg.avg) >= AXIS_UNLOCK_AVG && agg.n >= AXIS_UNLOCK_COUNT },
      200, setCookie ? { "Set-Cookie": `dlo_rater=${rid}; Path=/; Max-Age=31536000; SameSite=Lax` } : {});
  }

  if (path === "/api/feeds") {
    await ensureSchema(db);
    if (request.method === "GET") {
      const { results } = await db.prepare(
        "SELECT * FROM feeds ORDER BY watchlist, name"
      ).all();
      return json({ feeds: results, watchlist: WATCHLIST });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.url) return json({ error: "url required" }, 400);
      const feedUrl = String(body.url).trim();
      let name = String(body.name || "").trim();
      const watch = Math.max(0, Math.min(11, parseInt(body.watchlist ?? 0) || 0));
      const id = feedId(feedUrl);
      if (!name) {
        // probe the feed for its title
        try {
          const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10000),
            headers: { "User-Agent": "DLO-HomeLab-Intel/1.0" } });
          const xml = await res.text();
          name = stripHtml(tag(xml.slice(0, 20000), ["title"])) || new URL(feedUrl).hostname;
        } catch { name = new URL(feedUrl).hostname; }
      }
      await db.prepare(
        "INSERT OR IGNORE INTO feeds (id, name, url, watchlist, created_at) VALUES (?,?,?,?,?)"
      ).bind(id, name.slice(0, 200), feedUrl, watch, new Date().toISOString()).run();
      const result = await ingestAll(db, { onlyFeedId: id });
      return json({ ok: true, id, name, ingest: result });
    }
  }

  if (path.startsWith("/api/feeds/")) {
    const id = path.split("/").pop();
    if (request.method === "DELETE") {
      await db.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (request.method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      if (typeof body.active !== "undefined")
        await db.prepare("UPDATE feeds SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
      if (typeof body.watchlist !== "undefined")
        await db.prepare("UPDATE feeds SET watchlist = ? WHERE id = ?").bind(Math.max(0, Math.min(11, parseInt(body.watchlist) || 0)), id).run();
      if (typeof body.name === "string" && body.name.trim())
        await db.prepare("UPDATE feeds SET name = ? WHERE id = ?").bind(body.name.trim().slice(0, 200), id).run();
      return json({ ok: true });
    }
  }

  if (path === "/api/sync" && request.method === "POST") {
    const result = await ingestAll(db);
    return json({ ok: true, ...result });
  }

  if (path === "/api/leaderboard") {
    await ensureSchema(db);
    const { results: topRated } = await db.prepare(
      `SELECT i.id, i.title, i.link, i.rated_avg, i.rated_count, i.relevance, f.name AS feed_name, f.watchlist
       FROM items i JOIN feeds f ON f.id = i.feed_id
       WHERE i.rated_count > 0 ORDER BY i.rated_avg DESC, i.rated_count DESC LIMIT 50`
    ).all();
    const { results: topRelevance } = await db.prepare(
      `SELECT i.id, i.title, i.link, i.relevance, i.chi, i.benford_verdict, f.name AS feed_name, f.watchlist
       FROM items i JOIN feeds f ON f.id = i.feed_id
       ORDER BY i.relevance DESC LIMIT 50`
    ).all();
    const { results: feedRank } = await db.prepare(
      `SELECT f.id, f.name, f.item_count, f.watchlist, f.last_ok, f.last_error,
              AVG(i.relevance) AS avg_rel, AVG(i.chi) AS avg_chi,
              COUNT(i.id) AS scored_items
       FROM feeds f LEFT JOIN items i ON i.feed_id = f.id
       WHERE f.active = 1
       GROUP BY f.id ORDER BY avg_rel DESC NULLS LAST`
    ).all();
    const { results: benfordAlerts } = await db.prepare(
      `SELECT i.id, i.title, i.benford, i.benford_verdict, f.name AS feed_name
       FROM items i JOIN feeds f ON f.id = i.feed_id
       WHERE i.benford >= 4 ORDER BY i.benford DESC LIMIT 25`
    ).all();
    return json({ topRated, topRelevance, feedRank: feedRank.map(f => ({ ...f, avg_rel: r2(f.avg_rel || 0), avg_chi: r2(f.avg_chi || 0) })), benfordAlerts });
  }

  if (path === "/api/runs") {
    const { results } = await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 20").all();
    return json({ runs: results });
  }

  return json({ error: "Not Found" }, 404);
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// ------------------------------------------------------------
// UI — single embedded page (dark intel console)
// ------------------------------------------------------------
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DLO HomeLab Intel — Prophecy Intelligence Platform</title>
<style>
:root{
  --bg:#0a0a0c; --panel:#101014; --panel2:#16161c; --line:#232329;
  --gold:#e8b64c; --gold-dim:#8a6f35; --text:#e8e6df; --muted:#9b978c;
  --red:#e05252; --green:#4caf7d; --amber:#e8a04c;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman',serif;min-height:100dvh;font-size:16px;line-height:1.6}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit;cursor:pointer}
header{border-bottom:1px solid var(--line);padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:linear-gradient(180deg,#0d0d10,#0a0a0c);position:sticky;top:0;z-index:10}
.brand{font-family:var(--mono);letter-spacing:.18em;font-size:13px;color:var(--gold);text-transform:uppercase}
.brand b{color:var(--text)}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav button{background:none;border:1px solid transparent;color:var(--muted);padding:8px 14px;font-size:14px;border-radius:3px;min-height:44px}
nav button:hover{color:var(--text)}
nav button.on{color:var(--gold);border-color:var(--gold-dim);background:#181510}
.stat{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted);text-align:right}
main{max-width:1100px;margin:0 auto;padding:24px 20px 80px}
.view{display:none}.view.on{display:block}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px;align-items:center}
select,input[type=text],input[type=url]{background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:9px 12px;border-radius:3px;font-size:14px;min-height:44px;font-family:inherit}
select:focus,input:focus{outline:1px solid var(--gold-dim)}
.btn{background:#1d190f;border:1px solid var(--gold-dim);color:var(--gold);padding:9px 16px;border-radius:3px;font-size:14px;min-height:44px}
.btn:hover{background:#26200f}
.btn.ghost{border-color:var(--line);color:var(--muted);background:none}
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:16px 18px;margin-bottom:12px}
.card .t{font-size:17px;line-height:1.45}
.card .t a{color:var(--text)}
.card .t a:hover{color:var(--gold)}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-family:var(--mono);font-size:11px;color:var(--muted)}
.tag{border:1px solid var(--line);padding:1px 8px;border-radius:99px;white-space:nowrap}
.tag.gold{color:var(--gold);border-color:var(--gold-dim)}
.tag.red{color:var(--red);border-color:#5a2626}
.tag.green{color:var(--green);border-color:#1e4634}
.rating{display:flex;align-items:center;gap:6px;margin-top:12px;flex-wrap:wrap}
.rating .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;margin-right:4px}
.rbtn{width:34px;height:34px;border-radius:3px;border:1px solid var(--line);background:var(--panel2);color:var(--muted);font-family:var(--mono);font-size:12px}
.rbtn:hover{border-color:var(--gold-dim);color:var(--text)}
.rbtn.sel{background:var(--gold);color:#0a0a0c;border-color:var(--gold);font-weight:bold}
.avg{font-family:var(--mono);font-size:12px;color:var(--gold);margin-left:8px}
.axes{margin-top:12px;border-top:1px dashed var(--line);padding-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.ax{font-family:var(--mono);font-size:11px;color:var(--muted)}
.ax .row{display:flex;gap:4px;margin-top:6px}
.ax .abtn{flex:1;height:30px;border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:2px;font-size:11px}
.ax .abtn.sel{background:var(--gold-dim);color:var(--text);border-color:var(--gold)}
.locked{margin-top:12px;font-family:var(--mono);font-size:11px;color:var(--muted);border-top:1px dashed var(--line);padding-top:10px}
.scorebar{height:4px;background:var(--panel2);border-radius:2px;margin-top:10px;overflow:hidden}
.scorebar i{display:block;height:100%;background:linear-gradient(90deg,var(--gold-dim),var(--gold))}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:left;padding:8px;border-bottom:1px solid var(--line)}
td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:var(--panel2)}
.h2{font-size:22px;margin:26px 0 14px;font-weight:normal}
.h-sub{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
.grid2{display:grid;grid-template-columns:1fr;gap:18px}
@media(min-width:900px){.grid2{grid-template-columns:1fr 1fr}}
.empty{color:var(--muted);text-align:center;padding:60px 20px;font-style:italic}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--gold-dim);color:var(--gold);padding:10px 18px;border-radius:4px;font-family:var(--mono);font-size:12px;display:none;z-index:50}
.about p{margin-bottom:14px;max-width:70ch}
.about .verse{border-left:2px solid var(--gold-dim);padding-left:16px;font-style:italic;color:var(--muted);margin:20px 0}
.wl{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin:16px 0}
.wl div{border:1px solid var(--line);border-radius:3px;padding:10px 12px;font-size:14px;background:var(--panel)}
.wl span{font-family:var(--mono);color:var(--gold);margin-right:8px;font-size:12px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--gold-dim);border-top-color:var(--gold);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
</head>
<body>
<header>
  <div class="brand">DLO HOMELAB <b>INTEL</b></div>
  <nav id="nav">
    <button data-v="feed" class="on">Live Feed</button>
    <button data-v="saved">Saved ★</button>
    <button data-v="leaders">Leaderboard</button>
    <button data-v="feeds">Sources</button>
    <button data-v="about">About</button>
  </nav>
  <div class="stat" id="hstats">connecting…</div>
</header>
<main>
  <section id="v-feed" class="view on">
    <div class="toolbar">
      <select id="f-watch"><option value="all">All 12 watchlists</option></select>
      <select id="f-sort">
        <option value="new">Newest first</option>
        <option value="relevance">Prophecy relevance</option>
        <option value="chi">CHI coherence</option>
        <option value="rated">Community rated</option>
        <option value="benford">Benford alerts</option>
      </select>
      <input type="text" id="f-q" placeholder="Search headlines…" style="flex:1;min-width:180px">
      <button class="btn" id="btn-sync">Sync now</button>
    </div>
    <div id="feed-list"><div class="empty">Loading…</div></div>
    <div style="text-align:center;margin-top:16px"><button class="btn ghost" id="btn-more">Load more</button></div>
  </section>

  <section id="v-saved" class="view">
    <div class="h-sub">Kept forever</div>
    <h2 class="h2">Saved — everything 8.0+</h2>
    <p style="color:var(--muted);font-size:14px;margin-bottom:16px">Anything scoring 8 or better on prophecy relevance is auto-saved here and never purged. Everything else rolls on a 90-day archive.</p>
    <div id="saved-list"><div class="empty">Loading…</div></div>
    <div style="text-align:center;margin-top:16px"><button class="btn ghost" id="btn-more-saved">Load more</button></div>
  </section>

  <section id="v-source" class="view">
    <div class="toolbar">
      <button class="btn ghost" id="btn-back-src">&larr; Sources</button>
      <div class="h-sub" id="src-kind" style="margin:0"></div>
    </div>
    <h2 class="h2" id="src-title">Source</h2>
    <div id="src-list"><div class="empty">Loading…</div></div>
    <div style="text-align:center;margin-top:16px"><button class="btn ghost" id="btn-more-src">Load more</button></div>
  </section>

  <section id="v-leaders" class="view">
    <div class="grid2">
      <div>
        <div class="h-sub">Community verdict</div>
        <h2 class="h2">Top Rated Headlines</h2>
        <div id="lb-rated"><div class="empty">No ratings yet — be the first.</div></div>
        <div class="h-sub" style="margin-top:30px">Benford inversion layer</div>
        <h2 class="h2">False-Signal Alerts</h2>
        <div id="lb-benford"><div class="empty">No alerts.</div></div>
      </div>
      <div>
        <div class="h-sub">Machine signal</div>
        <h2 class="h2">Highest Prophecy Relevance</h2>
        <div id="lb-rel"><div class="empty">Loading…</div></div>
        <div class="h-sub" style="margin-top:30px">Source quality</div>
        <h2 class="h2">Feed Rankings</h2>
        <div id="lb-feeds"><div class="empty">Loading…</div></div>
      </div>
    </div>
  </section>

  <section id="v-feeds" class="view">
    <div class="h-sub">Feed registry</div>
    <h2 class="h2">Sources Under Watch</h2>
    <div class="card">
      <div class="toolbar" style="margin-bottom:0">
        <input type="url" id="add-url" placeholder="https://example.com/feed.xml" style="flex:2;min-width:220px">
        <input type="text" id="add-name" placeholder="Name (optional)" style="flex:1;min-width:140px">
        <select id="add-watch"></select>
        <button class="btn" id="btn-add">Add feed</button>
      </div>
    </div>
    <div id="feed-table"><div class="empty">Loading…</div></div>
  </section>

  <section id="v-about" class="view about">
    <div class="h-sub">Prophecy Intel</div>
    <h2 class="h2">Thousands to Hundreds. Hundreds to a Handful.</h2>
    <p>Prophecy isn't about guessing the future. It's about recognizing the pattern.
    Scholars identify roughly <b>1,800</b> distinct prophecies in Scripture. Most have already
    unfolded in history — culminating in the first coming of Jesus. What's left is not another
    thousand unknowns, but a focused, <b>end-of-age cluster</b>.</p>
    <p>This platform watches a working set of <b>twelve live triggers</b> — prophecies where
    conditions can visibly move before His return. Under each sits a stack of topic-specific
    feeds. Every headline that arrives is scored instantly by the <b>Coherence Scorer v2.0</b>
    (CHI · Wisdom/Knowledge · Fruits · Structure · Benford false-signal inversion) — no AI call
    per item, no cost per headline. Batch ingest runs on a schedule and on demand.</p>
    <p><b>Rating:</b> every headline takes a 1–10 community rating. When a headline crosses
    <b>7.0 average with at least 3 ratings</b>, a multi-axis layer unlocks — reliability,
    relevance, significance, urgency — so the strongest signals get the deepest scrutiny.</p>
    <p><b>Memory:</b> every source keeps a rolling <b>90-day archive</b> you can click through —
    Sources, then pick a feed. Anything scoring <b>8.0 or better</b> is auto-saved and kept
    forever under <b>Saved ★</b>. The handful that matters is never purged.</p>
    <div class="wl" id="about-wl"></div>
    <div class="verse">"Test everything. Hold fast to what is good." — 1 Thessalonians 5:21</div>
    <p style="font-family:var(--mono);font-size:11px;color:var(--muted)">
    DLO HomeLab Intel · Coherence Scorer v2.0 (POF 2828) · scores are lexical heuristics,
    not measured probabilities.</p>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const api=async(p,o)=>{const r=await fetch(p,o?{method:o.method||"POST",headers:{"Content-Type":"application/json"},body:o.body?JSON.stringify(o.body):undefined}:undefined);return r.json()};
let WATCH=[],UNLOCK={avg:7,count:3},offset=0,loading=false;
const fmtRel=d=>{if(!d)return"";const t=new Date(d),m=(Date.now()-t.getTime())/6e4;
  if(m<60)return Math.max(1,Math.round(m))+"m ago";if(m<1440)return Math.round(m/60)+"h ago";return Math.round(m/1440)+"d ago"};
function toast(m){const t=$("#toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2600)}

// ---- nav ----
$("#nav").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
  $$("#nav button").forEach(x=>x.classList.toggle("on",x===b));
  $$(".view").forEach(v=>v.classList.toggle("on",v.id==="v-"+b.dataset.v));
  if(b.dataset.v==="leaders")loadLeaders(); if(b.dataset.v==="feeds")loadFeeds(); if(b.dataset.v==="saved")loadSaved(true);});

// ---- state ----
async function loadState(){const s=await api("/api/state");WATCH=s.watchlist;UNLOCK=s.axisUnlock;
  const st=s.stats||{};
  $("#hstats").innerHTML=(st.items_total||0).toLocaleString()+" items · "+(st.feeds_active||0)+"/"+(st.feeds_total||0)+" feeds · ★"+(st.saved_total||0).toLocaleString()+" saved · "+(st.ratings_total||0)+" ratings"
    +(s.lastRun?"<br>last sync "+fmtRel(s.lastRun.ran_at)+" (+"+(s.lastRun.items_new||0)+" new)":"");
  const w=$("#f-watch");if(w.options.length<=1)WATCH.forEach((n,i)=>{const o=document.createElement("option");o.value=i;o.textContent=(i+1)+". "+n;w.add(o)});
  const aw=$("#add-watch");if(!aw.options.length)WATCH.forEach((n,i)=>{const o=document.createElement("option");o.value=i;o.textContent=(i+1)+". "+n;aw.add(o)});
  const wl=$("#about-wl");if(!wl.children.length)wl.innerHTML=WATCH.map((n,i)=>"<div><span>"+(i+1)+"</span>"+esc(n)+"</div>").join("");
}

// ---- feed ----
function cardHTML(it){
  const mine=it.my&&it.my.score;
  const unlocked=(it.rated_avg||0)>=UNLOCK.avg&&(it.rated_count||0)>=UNLOCK.count;
  const btns=[...Array(10)].map((_,i)=>'<button class="rbtn'+(mine===i+1?" sel":"")+'" data-s="'+(i+1)+'">'+(i+1)+"</button>").join("");
  const sum=(it.summary||"").slice(0,220);
  return '<article class="card" data-id="'+it.id+'">'+
    '<div class="t"><a href="'+esc(it.link)+'" target="_blank" rel="noopener">'+esc(it.title)+"</a></div>"+
    (sum?'<div style="color:var(--muted);font-size:14px;margin-top:6px">'+esc(sum)+(it.summary.length>220?"…":"")+"</div>":"")+
    '<div class="meta">'+
      '<span class="tag gold">'+esc(it.feed_name)+"</span>"+
      '<span class="tag">'+esc(WATCH[it.watchlist]||"—")+"</span>"+
      '<span class="tag">'+fmtRel(it.published_at||it.fetched_at)+"</span>"+
      '<span class="tag" title="Prophecy relevance">REL '+it.relevance.toFixed(1)+"</span>"+
      '<span class="tag" title="'+esc(it.chi_status)+'">CHI '+it.chi.toFixed(1)+"</span>"+
      (it.benford>=4?'<span class="tag red" title="'+esc(it.benford_verdict)+'">BENFORD '+it.benford.toFixed(1)+"</span>":"")+
      (it.scripture_refs>0?'<span class="tag green">'+it.scripture_refs+" scripture</span>":"")+
      (it.saved?'<span class="tag gold" title="Auto-saved at 8+ relevance — kept forever">★ saved</span>':"")+
    "</div>"+
    '<div class="scorebar" title="relevance"><i style="width:'+(it.relevance*10)+'%"></i></div>'+
    '<div class="rating"><span class="lbl">Rate</span>'+btns+
      '<span class="avg">'+(it.rated_count?it.rated_avg.toFixed(1)+" · "+it.rated_count+" rating"+(it.rated_count>1?"s":""):"unrated")+"</span></div>"+
    '<div class="axwrap">'+(unlocked?axHTML(it.id,null):'<div class="locked">Multi-axis layer locks in at '+UNLOCK.avg.toFixed(1)+' avg · '+UNLOCK.count+' ratings'+(it.rated_count?" — currently "+it.rated_avg.toFixed(1)+" · "+it.rated_count:"")+"</div>")+"</div>"+
  "</article>";
}
function axHTML(it,my){
  const AX=[["reliability","Reliability"],["relevance","Relevance"],["significance","Significance"],["urgency","Urgency"]];
  return '<div class="axes">'+AX.map(([k,l])=>{
    const sel=my&&my.axes&&my.axes[k];
    return '<div class="ax" data-ax="'+k+'"><span>'+l+'</span><div class="row">'+
      [...Array(10)].map((_,i)=>'<button class="abtn'+(sel===i+1?" sel":"")+'" data-v="'+(i+1)+'">'+(i+1)+"</button>").join("")+"</div></div>";
  }).join("")+"</div>";
}
async function loadItems(reset){
  if(loading)return;loading=true;
  if(reset){offset=0;$("#feed-list").innerHTML='<div class="empty"><span class="spin"></span>Loading…</div>'}
  const p=new URLSearchParams({watchlist:$("#f-watch").value,sort:$("#f-sort").value,q:$("#f-q").value,limit:"50",offset:String(offset)});
  const r=await api("/api/items?"+p);
  if(reset)$("#feed-list").innerHTML="";
  if(!r.items.length&&offset===0){$("#feed-list").innerHTML='<div class="empty">No headlines yet — hit Sync now.</div>'}
  else $("#feed-list").insertAdjacentHTML("beforeend",r.items.map(cardHTML).join(""));
  offset+=r.items.length;loading=false;
}
$("#btn-more").onclick=()=>loadItems(false);

// ---- saved (8+ kept forever) ----
let offSaved=0,loadingSaved=false;
async function loadSaved(reset){
  if(loadingSaved)return;loadingSaved=true;
  if(reset){offSaved=0;$("#saved-list").innerHTML='<div class="empty"><span class="spin"></span>Loading…</div>'}
  const r=await api("/api/items?saved=1&sort=new&limit=50&offset="+offSaved);
  if(reset)$("#saved-list").innerHTML="";
  if(!r.items.length&&offSaved===0)$("#saved-list").innerHTML='<div class="empty">Nothing saved yet — the first 8.0+ headline lands here automatically.</div>';
  else $("#saved-list").insertAdjacentHTML("beforeend",r.items.map(cardHTML).join(""));
  offSaved+=r.items.length;loadingSaved=false;
}
$("#btn-more-saved").onclick=()=>loadSaved(false);

// ---- source drill-down (90-day archive, every article clickable) ----
let SRC=null,offSrc=0,loadingSrc=false;
async function openSource(id,name,kind){
  SRC=id;offSrc=0;
  $$("#nav button").forEach(x=>x.classList.remove("on"));
  $$(".view").forEach(v=>v.classList.toggle("on",v.id==="v-source"));
  $("#src-title").textContent=name||"Source";
  $("#src-kind").textContent=(kind||"")+" · 90-day archive";
  await loadSource(true);
}
async function loadSource(reset){
  if(!SRC||loadingSrc)return;loadingSrc=true;
  if(reset){offSrc=0;$("#src-list").innerHTML='<div class="empty"><span class="spin"></span>Loading…</div>'}
  const r=await api("/api/items?feed="+encodeURIComponent(SRC)+"&sort=new&limit=50&offset="+offSrc);
  if(reset)$("#src-list").innerHTML="";
  if(!r.items.length&&offSrc===0)$("#src-list").innerHTML='<div class="empty">No stored articles yet — this source fills in on the next sync.</div>';
  else $("#src-list").insertAdjacentHTML("beforeend",r.items.map(cardHTML).join(""));
  offSrc+=r.items.length;loadingSrc=false;
}
$("#btn-more-src").onclick=()=>loadSource(false);
$("#btn-back-src").onclick=()=>{SRC=null;
  $$("#nav button").forEach(x=>x.classList.toggle("on",x.dataset.v==="feeds"));
  $$(".view").forEach(v=>v.classList.toggle("on",v.id==="v-feeds"));
  loadFeeds();};
$("#f-watch").onchange=$("#f-sort").onchange=()=>loadItems(true);
let qT;$("#f-q").oninput=()=>{clearTimeout(qT);qT=setTimeout(()=>loadItems(true),350)};
$("#btn-sync").onclick=async()=>{$("#btn-sync").innerHTML='<span class="spin"></span>Syncing…';
  const r=await api("/api/sync",{method:"POST",body:{}});
  $("#btn-sync").textContent="Sync now";
  toast("Synced "+r.feeds+" feeds · "+r.ok+" ok · +"+r.added+" new items in "+(r.ms/1000).toFixed(1)+"s");
  loadState();loadItems(true);};

// rating interactions (delegated — covers feed, saved and source views)
$("main").addEventListener("click",async e=>{
  const card=e.target.closest(".card");if(!card)return;
  const id=card.dataset.id;
  const rb=e.target.closest(".rbtn");
  if(rb){const score=+rb.dataset.s;
    $$(".rbtn",card).forEach(b=>b.classList.toggle("sel",+b.dataset.s<=score&&false));
    rb.classList.add("sel");
    const r=await api("/api/rate",{body:{item_id:id,score}});
    if(r.ok){toast("Rated "+score+"/10 — community "+r.rated_avg.toFixed(1)+" ("+r.rated_count+")");
      $(".avg",card).textContent=r.rated_avg.toFixed(1)+" · "+r.rated_count+" rating"+(r.rated_count>1?"s":"");
      if(r.unlocked&&!$(".axes",card)){const d=await api("/api/item?id="+id);$(".axwrap",card).innerHTML=axHTML(id,d.my);}}
    return;}
  const ab=e.target.closest(".abtn");
  if(ab){const ax=ab.closest(".ax").dataset.ax,v=+ab.dataset.v;
    $$(".abtn",ab.closest(".row")).forEach(b=>b.classList.toggle("sel",b===ab));
    const axes={};$$(".ax",card).forEach(a=>{const s=$(".abtn.sel",a);if(s)axes[a.dataset.ax]=+s.dataset.v});
    const cur=$(".rbtn.sel",card);
    if(cur)await api("/api/rate",{body:{item_id:id,score:+cur.dataset.s,axes}});
    else toast("Set a 1–10 rating first, then the axes stick");
    return;}
});

// ---- leaderboard ----
async function loadLeaders(){const r=await api("/api/leaderboard");
  $("#lb-rated").innerHTML=r.topRated.length?r.topRated.map(i=>
    '<div class="card"><div class="t"><a href="'+esc(i.link)+'" target="_blank" rel="noopener">'+esc(i.title)+'</a></div><div class="meta"><span class="tag gold">'+i.rated_avg.toFixed(1)+'/10 · '+i.rated_count+'</span><span class="tag">'+esc(i.feed_name)+"</span></div></div>").join("")
    :'<div class="empty">No ratings yet — be the first.</div>';
  $("#lb-rel").innerHTML=r.topRelevance.slice(0,15).map(i=>
    '<div class="card"><div class="t"><a href="'+esc(i.link)+'" target="_blank" rel="noopener">'+esc(i.title)+'</a></div><div class="meta"><span class="tag gold">REL '+i.relevance.toFixed(1)+'</span><span class="tag">CHI '+i.chi.toFixed(1)+'</span><span class="tag">'+esc(i.feed_name)+"</span></div></div>").join("")||'<div class="empty">No items yet.</div>';
  $("#lb-feeds").innerHTML='<table><tr><th>Feed</th><th>Items</th><th>Avg REL</th><th>Avg CHI</th><th>Health</th></tr>'+
    r.feedRank.map(f=>"<tr><td>"+esc(f.name)+"</td><td>"+f.item_count+"</td><td>"+f.avg_rel.toFixed(1)+"</td><td>"+f.avg_chi.toFixed(1)+"</td><td>"+
      (f.last_error?'<span style="color:var(--red)" title="'+esc(f.last_error)+'">failing</span>':'<span style="color:var(--green)">ok</span>')+"</td></tr>").join("")+"</table>";
  $("#lb-benford").innerHTML=r.benfordAlerts.length?r.benfordAlerts.map(i=>
    '<div class="card"><div class="t">'+esc(i.title)+'</div><div class="meta"><span class="tag red">BENFORD '+i.benford.toFixed(1)+'</span><span class="tag">'+esc(i.benford_verdict)+'</span><span class="tag">'+esc(i.feed_name)+"</span></div></div>").join("")
    :'<div class="empty">No alerts.</div>';
}

// ---- sources ----
async function loadFeeds(){const r=await api("/api/feeds");
  $("#feed-table").innerHTML='<table><tr><th>Feed</th><th>Watchlist</th><th>Items</th><th>Last OK</th><th>Status</th><th></th></tr>'+
    r.feeds.map(f=>'<tr data-id="'+f.id+'"><td><button class="fname" data-kind="'+esc(f.kind||"RSS")+'" title="Open the 90-day archive for this source" style="background:none;border:none;color:var(--gold);font-size:14px;text-align:left;padding:0;min-height:0;font-family:inherit">'+esc(f.name)+'</button><br><span style="font-family:var(--mono);font-size:10px;color:var(--muted)">'+esc(f.url)+"</span></td>"+
      '<td><select class="wl-sel" style="min-height:36px;padding:4px 8px">'+r.watchlist.map((n,i)=>'<option value="'+i+'"'+(i===f.watchlist?" selected":"")+">"+(i+1)+". "+esc(n)+"</option>").join("")+"</select></td>"+
      "<td>"+f.item_count+"</td><td>"+fmtRel(f.last_ok)+"</td>"+
      "<td>"+(f.last_error?'<span style="color:var(--red);font-size:12px" title="'+esc(f.last_error)+'">'+esc(f.last_error.slice(0,40))+"</span>":'<span style="color:var(--green)">ok</span>')+"</td>"+
      '<td><button class="btn ghost tg" style="min-height:36px;padding:4px 10px">'+(f.active?"pause":"resume")+'</button> '+
      '<button class="btn ghost del" style="min-height:36px;padding:4px 10px;color:var(--red)">remove</button></td></tr>').join("")+"</table>";
}
$("#feed-table").addEventListener("click",async e=>{
  const tr=e.target.closest("tr");if(!tr)return;const id=tr.dataset.id;
  const fn=e.target.closest(".fname");
  if(fn){openSource(id,fn.textContent,fn.dataset.kind);return;}
  if(e.target.closest(".del")){if(confirm("Remove this feed and stop ingesting it?")){await fetch("/api/feeds/"+id,{method:"DELETE"});loadFeeds();loadState();}}
  if(e.target.closest(".tg")){await fetch("/api/feeds/"+id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({active:e.target.textContent==="pause"?0:1})});loadFeeds();loadState();}
});
$("#feed-table").addEventListener("change",async e=>{
  const sel=e.target.closest(".wl-sel");if(!sel)return;
  await fetch("/api/feeds/"+sel.closest("tr").dataset.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({watchlist:+sel.value})});
  toast("Watchlist updated");
});
$("#btn-add").onclick=async()=>{const url=$("#add-url").value.trim();if(!url)return toast("Paste a feed URL first");
  $("#btn-add").innerHTML='<span class="spin"></span>Adding…';
  const r=await api("/api/feeds",{body:{url,name:$("#add-name").value,watchlist:+$("#add-watch").value}});
  $("#btn-add").textContent="Add feed";
  if(r.error)toast("Error: "+r.error);else{toast("Added "+r.name+" · +"+(r.ingest?r.ingest.added:0)+" items");$("#add-url").value="";$("#add-name").value="";loadFeeds();loadState();}
};

loadState().then(()=>loadItems(true));
</script>
</body>
</html>`;

// ------------------------------------------------------------
// WORKER ENTRY
// ------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      if (url.pathname === "/intel" || url.pathname === "/intel.html") {
        return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      // On the main prophecy-platform worker the existing static site stays
      // exactly as it was — we just back its feed APIs with the database.
      if (env.ASSETS) {
        const r = await env.ASSETS.fetch(request);
        if (r.status !== 404) return r;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: String(err).slice(0, 300) }, 500);
    }
  },

  // Batch ingest on schedule — no AI, no per-item cost.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ingestAll(env.DB));
  },
};
