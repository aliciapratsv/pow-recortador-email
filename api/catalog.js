// Lee el catálogo público de una tienda (Shopify, VTEX, Tiendanube u otra) y devuelve sus URLs.
const UA = "Mozilla/5.0 (compatible; POW-Recortador/1.0; +https://pow.la)";
const MAX_ITEMS = 2500;

function originOf(raw) {
  let s = String(raw || "").trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || !h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") ||
    /^\[/.test(h) || /^(0|10|127)\./.test(h) || /^169\.254\./.test(h) ||
    /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) throw new Error("bad");
  return u.origin;
}
function safe(url) { try { originOf(url); return true; } catch (e) { return false; } }

async function get(url, ms = 9000) {
  if (!safe(url)) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: c.signal, redirect: "follow" });
    return r.ok ? r : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
async function getJSON(url) { const r = await get(url); if (!r) return null; try { return await r.json(); } catch (e) { return null; } }
async function getText(url) { const r = await get(url); if (!r) return null; try { return await r.text(); } catch (e) { return null; } }

function decode(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
}
function titleFromPath(p) {
  const segs = p.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
  return segs.slice(-2).join(" › ").replace(/[-_]+/g, " ").replace(/\.html?$/, "") || "Inicio";
}

async function shopify(o) {
  const c = await getJSON(o + "/collections.json?limit=250");
  if (!c || !Array.isArray(c.collections)) return null;
  const out = c.collections.map((x) => ({ k: "colección", u: "/collections/" + x.handle, t: x.title }));
  for (let p = 1; p <= 6; p++) {
    const d = await getJSON(o + "/products.json?limit=250&page=" + p);
    if (!d || !Array.isArray(d.products) || !d.products.length) break;
    d.products.forEach((x) => out.push({ k: "producto", u: "/products/" + x.handle, t: x.title + (x.product_type ? " (" + x.product_type + ")" : "") }));
    if (d.products.length < 250) break;
  }
  return out;
}

async function vtex(o) {
  const tree = await getJSON(o + "/api/catalog_system/pub/category/tree/3");
  if (!Array.isArray(tree) || !tree.length) return null;
  const out = [];
  const walk = (n, parent) => {
    let path = n.url || "";
    try { path = new URL(n.url, o).pathname; } catch (e) {}
    const t = parent ? parent + " › " + n.name : n.name;
    if (path) out.push({ k: "categoría", u: path, t });
    (n.children || []).forEach((ch) => walk(ch, t));
  };
  tree.forEach((n) => walk(n, ""));
  return out;
}

async function sitemap(o) {
  const seen = new Set(), out = [];
  const queue = [o + "/sitemap.xml"];
  let fetched = 0;
  const rank = (u) => (/categor|collection|department|depart|brand|marca/i.test(u) ? 0 : /product/i.test(u) ? 2 : 1);
  while (queue.length && fetched < 12 && out.length < 4000) {
    const x = await getText(queue.shift());
    fetched++;
    if (!x) continue;
    const locs = [...x.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => decode(m[1]));
    if (/<sitemapindex/i.test(x)) {
      locs.filter(safe).sort((a, b) => rank(a) - rank(b)).forEach((l) => queue.push(l));
      queue.sort((a, b) => rank(a) - rank(b));
      continue;
    }
    locs.forEach((l) => {
      try {
        const u = new URL(l);
        const key = u.pathname + u.search;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ k: /\/p$|\/products?\//i.test(u.pathname) ? "producto" : "página", u: key, t: titleFromPath(u.pathname) });
      } catch (e) {}
    });
  }
  return out;
}

function navLinks(html, o) {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*?href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    let u;
    try { u = new URL(decode(m[1]), o); } catch (e) { continue; }
    if (u.origin !== o) continue;
    const key = u.pathname + u.search;
    if (key === "/" || seen.has(key)) continue;
    if (/\/(account|cart|checkout|login|cuenta|carrito|mi-cuenta|policies|search|buscar)\b/i.test(key)) continue;
    const t = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t) continue;
    seen.add(key);
    out.push({ k: "menú", u: key, t });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let o;
  try { o = originOf((req.query && req.query.site) || ""); }
  catch (e) { return res.status(400).json({ error: "La URL de la tienda no es válida." }); }
  try {
    const home = await get(o, 12000);
    let html = "";
    if (home) {
      try { o = new URL(home.url).origin; } catch (e) {}
      html = await home.text().catch(() => "");
    }
    let platform = "", items = [];
    const sh = await shopify(o);
    if (sh && sh.length) { platform = "Shopify"; items = sh; }
    else {
      const vt = await vtex(o);
      if (vt && vt.length) { platform = "VTEX"; items = vt; }
    }
    if (!platform) platform = /tiendanube|nuvemshop/i.test(html) ? "Tiendanube" : "Sitio";
    const menu = navLinks(html, o);
    const sm = platform === "Shopify" ? [] : await sitemap(o);

    const all = [], seen = new Set();
    let products = 0;
    [menu, items.filter((x) => x.k !== "producto"), items.filter((x) => x.k === "producto"), sm].forEach((list) => {
      list.forEach((x) => {
        if (!x.u || seen.has(x.u) || all.length >= MAX_ITEMS) return;
        if (x.k === "producto" && ++products > 1500) return;
        seen.add(x.u);
        all.push({ k: x.k, u: x.u, t: String(x.t || "").slice(0, 120) });
      });
    });
    if (!all.length) return res.status(404).json({ error: "No pude leer el catálogo de esa tienda. Revisá la URL o probá con la home (https://...)." });
    res.status(200).json({ origin: o, platform, items: all });
  } catch (e) {
    res.status(500).json({ error: "Error leyendo la tienda. Probá de nuevo en unos segundos." });
  }
};
