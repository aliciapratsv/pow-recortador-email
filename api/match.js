// Asigna a cada recorte la URL del catálogo que le corresponde, usando Claude con visión.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const RULES = `Asignás links de destino a los bloques recortados de un newsletter de eCommerce.
Para cada bloque: leé el texto visible (títulos, botones, nombres de producto, categorías, descuentos) y mirá qué muestra la imagen. Elegí del catálogo la URL que corresponde.
Criterios:
- Si el bloque nombra o muestra un producto puntual que está en el catálogo, usá el producto.
- Si habla de un rubro, categoría o colección (ej. "Vestidos", "Nueva temporada", "Jeans 30% OFF"), usá la categoría o colección más específica que coincida.
- Si es una promo general sin rubro y existe una página de sale/ofertas/outlet, usala; si no, usá "/".
- Header, logo o "ver todo" sin rubro: "/".
- Bloques sin sentido como link (separadores, espacios en blanco, texto legal, íconos de redes): path "" .
- Solo podés devolver paths que estén en el catálogo, o "/" o "".
- conf: "alta" si el texto del bloque coincide claramente con la página; "media" si es una inferencia razonable; "baja" si es una suposición.
- why: motivo en español, máximo 12 palabras.
Respondé SOLO con un array JSON, sin texto ni backticks: [{"id":"...","path":"/...","conf":"alta|media|baja","why":"..."}]`;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido." });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Falta cargar ANTHROPIC_API_KEY en Vercel (Settings → Environment Variables)." });

  const { origin, items, pieces } = readBody(req);
  if (!origin || !Array.isArray(items) || !items.length || !Array.isArray(pieces) || !pieces.length)
    return res.status(400).json({ error: "Faltan datos para analizar." });
  if (pieces.length > 6 || items.length > 3000) return res.status(400).json({ error: "Demasiados datos en un solo pedido." });

  const catalog = items.map((x) => `${x.k} | ${x.u} | ${x.t}`).join("\n");
  const valid = new Set(items.map((x) => x.u));
  const content = [];
  pieces.forEach((p) => {
    content.push({ type: "text", text: "Bloque id=" + p.id });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(p.image || "") } });
  });
  content.push({ type: "text", text: "Asigná la URL a cada uno de estos " + pieces.length + " bloques. Usá exactamente los ids indicados." });

  let data;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: [
          { type: "text", text: RULES },
          { type: "text", text: "Tienda: " + origin + "\nCatálogo (tipo | path | título):\n" + catalog, cache_control: { type: "ephemeral" } }
        ],
        messages: [{ role: "user", content }]
      })
    });
    data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Claude respondió con error: " + ((data && data.error && data.error.message) || r.status) });
  } catch (e) {
    return res.status(502).json({ error: "No pude conectarme con Claude. Probá de nuevo." });
  }

  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  let arr = [];
  try {
    const s = text.replace(/```json|```/g, "");
    arr = JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1));
  } catch (e) {
    return res.status(502).json({ error: "No pude interpretar la respuesta. Probá de nuevo." });
  }

  const results = arr.map((x) => {
    let path = String(x.path || "").trim(), conf = ["alta", "media", "baja"].includes(x.conf) ? x.conf : "baja";
    try { if (/^https?:/i.test(path)) { const u = new URL(path); path = u.origin === origin ? u.pathname + u.search : ""; } } catch (e) { path = ""; }
    if (path && path !== "/" && !valid.has(path)) conf = "baja";
    return { id: String(x.id), url: path ? origin + path : "", conf, why: String(x.why || "").slice(0, 140) };
  });
  res.status(200).json({ results });
};
