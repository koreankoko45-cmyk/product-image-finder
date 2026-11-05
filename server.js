const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

/* ------------------------------------------------------------------
   Fournisseurs de recherche d'images (variables d'environnement) :
   - SERPER_API_KEY                         -> serper.dev
   - GOOGLE_CSE_KEY + GOOGLE_CSE_CX         -> Google Custom Search (100 req/jour gratuites)
   - SERPAPI_KEY                            -> serpapi.com
   - DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD -> dataforseo.com (paiement à l'usage)
   Ordre d'essai (modifiable) : PROVIDERS=serper,google,serpapi,dataforseo
   Quand un fournisseur n'a plus de quota, le serveur passe tout seul au suivant.
------------------------------------------------------------------- */
const env = name => (process.env[name] || "").trim();

const ORDER = (env("PROVIDERS") || "serper,google,serpapi,dataforseo,bing,duckduckgo")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const HOUR = 60 * 60 * 1000;
const cache = new Map(); // même recherche = aucun quota consommé
const CACHE_MAX = 10000;
const disabledUntil = {}; // fournisseur -> timestamp (quota épuisé / clé invalide)
const lastReason = {};    // fournisseur -> dernière raison de blocage

class ProviderError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;     // "quota" | "auth" | "other"
    this.status = status;
  }
}

function classify(status, message) {
  const m = String(message || "").toLowerCase();
  if (
    status === 429 ||
    status === 402 ||
    /quota|credit|run out|out of searches|rate limit|too many|limit exceeded|payment|balance|insufficient/.test(m)
  ) return "quota";
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|api key not valid|authenticat/.test(m)) {
    return "auth";
  }
  return "other";
}

async function httpJson(url, options) {
  const res = await fetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  return { res, data };
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const nextSlot = {};
// Espace les requêtes d'un moteur gratuit (évite le blocage), même si plusieurs arrivent ensemble
async function throttle(name, minMs) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot[name] || 0);
  nextSlot[name] = slot + minMs + Math.random() * 400;
  const wait = slot - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
const decodeEntities = t =>
  String(t).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* ---------------------------- Fournisseurs ---------------------------- */
const providers = {
  serper: {
    label: "Serper",
    configured: () => Boolean(env("SERPER_API_KEY")),
    async search(q) {
      const { res, data } = await httpJson("https://google.serper.dev/images", {
        method: "POST",
        headers: { "X-API-KEY": env("SERPER_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({ q, gl: "ma", hl: "fr", num: 12 })
      });
      const msg = data.message || data.error || "";
      if (!res.ok || (msg && !data.images)) {
        throw new ProviderError(msg || `HTTP ${res.status}`, classify(res.status, msg), res.status);
      }
      return (data.images || []).map(i => ({
        title: i.title || "",
        thumbnail: i.thumbnailUrl || i.imageUrl || "",
        image: i.imageUrl || i.thumbnailUrl || "",
        source: i.source || i.domain || "",
        link: i.link || ""
      }));
    }
  },

  google: {
    label: "Google Custom Search",
    configured: () => Boolean(env("GOOGLE_CSE_KEY") && env("GOOGLE_CSE_CX")),
    async search(q) {
      const params = new URLSearchParams({
        key: env("GOOGLE_CSE_KEY"),
        cx: env("GOOGLE_CSE_CX"),
        q,
        searchType: "image",
        num: "10",
        hl: "fr",
        gl: "ma"
      });
      const { res, data } = await httpJson(`https://www.googleapis.com/customsearch/v1?${params}`);
      if (!res.ok || data.error) {
        const msg = (data.error && (data.error.message || data.error.status)) || `HTTP ${res.status}`;
        throw new ProviderError(msg, classify(res.status, msg), res.status);
      }
      return (data.items || []).map(i => ({
        title: i.title || "",
        thumbnail: (i.image && i.image.thumbnailLink) || i.link || "",
        image: i.link || "",
        source: i.displayLink || "",
        link: (i.image && i.image.contextLink) || ""
      }));
    }
  },

  serpapi: {
    label: "SerpApi",
    configured: () => Boolean(env("SERPAPI_KEY")),
    async search(q) {
      const params = new URLSearchParams({
        engine: "google_images",
        q,
        api_key: env("SERPAPI_KEY"),
        hl: "fr",
        gl: "ma"
      });
      const { res, data } = await httpJson(`https://serpapi.com/search.json?${params}`);
      const apiError = data.error ? String(data.error) : "";
      if (apiError && /hasn't returned any results/i.test(apiError)) return [];
      if (!res.ok || apiError) {
        throw new ProviderError(apiError || `HTTP ${res.status}`, classify(res.status, apiError), res.status);
      }
      return (data.images_results || []).slice(0, 12).map(i => ({
        title: i.title || "",
        thumbnail: i.thumbnail || i.original || "",
        image: i.original || i.thumbnail || "",
        source: i.source || "",
        link: i.link || ""
      }));
    }
  },

  dataforseo: {
    label: "DataForSEO",
    configured: () => Boolean(env("DATAFORSEO_LOGIN") && env("DATAFORSEO_PASSWORD")),
    async search(q) {
      const auth = Buffer.from(`${env("DATAFORSEO_LOGIN")}:${env("DATAFORSEO_PASSWORD")}`).toString("base64");
      const { res, data } = await httpJson("https://api.dataforseo.com/v3/serp/google/images/live/advanced", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify([{
          keyword: q,
          location_name: env("DFS_LOCATION") || "Morocco",
          language_code: env("DFS_LANGUAGE") || "fr"
        }])
      });
      const task = (data.tasks && data.tasks[0]) || {};
      const code = Number(task.status_code || data.status_code || 0);
      if (!res.ok || code !== 20000) {
        const msg = task.status_message || data.status_message || `HTTP ${res.status}`;
        const status = code === 40200 ? 402 : code === 40100 || code === 40101 ? 401 : res.status;
        throw new ProviderError(msg, classify(status, msg), status);
      }
      const items = (((task.result || [])[0] || {}).items || []).filter(
        i => i.type === "images_search" && (i.source_url || i.encoded_url)
      );
      return items.slice(0, 12).map(i => ({
        title: i.title || i.alt || "",
        thumbnail: i.encoded_url || i.source_url || "",
        image: i.source_url || i.encoded_url || "",
        source: hostOf(i.url) || "",
        link: i.url || ""
      }));
    }
  }
};

/* --------- Moteurs gratuits sans clé (non officiels : peuvent être bloqués) --------- */
const scrapersOn = () => env("DISABLE_FREE_SCRAPERS") !== "1";

providers.bing = {
  label: "Bing Images (gratuit)",
  configured: scrapersOn,
  async search(q) {
    await throttle("bing", 1200);
    const params = new URLSearchParams({ q, first: "1", count: "35", mmasync: "1", setlang: "fr" });
    const res = await fetch(`https://www.bing.com/images/async?${params}`, {
      headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" }
    });
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      throw new ProviderError(`Bing HTTP ${res.status}`, "blocked", res.status);
    }
    const html = await res.text();
    const results = [];
    const re = /\sm="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) && results.length < 12) {
      try {
        const o = JSON.parse(decodeEntities(m[1]));
        if (o.murl && o.turl) {
          results.push({
            title: String(o.t || "").replace(/[\ue000\ue001]/g, ""),
            thumbnail: o.turl,
            image: o.murl,
            source: hostOf(o.purl),
            link: o.purl || ""
          });
        }
      } catch (e) { /* ligne ignorée */ }
    }
    if (!results.length && (html.length < 3000 || /captcha|unusual traffic/i.test(html))) {
      throw new ProviderError("Bing a bloqué la requête", "blocked", res.status);
    }
    return results;
  }
};

providers.duckduckgo = {
  label: "DuckDuckGo Images (gratuit)",
  configured: scrapersOn,
  async search(q) {
    await throttle("duckduckgo", 1500);
    const headers = { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" };
    const page = await fetch("https://duckduckgo.com/?" + new URLSearchParams({ q, iax: "images", ia: "images" }), { headers });
    const html = await page.text();
    const vqd = (html.match(/vqd=["']?([\d-]+)["']?/) || [])[1];
    if (!vqd) throw new ProviderError("DuckDuckGo : jeton introuvable (bloqué)", "blocked", page.status);
    const params = new URLSearchParams({ l: "fr-fr", o: "json", q, vqd, f: ",,,,,", p: "1" });
    const res = await fetch("https://duckduckgo.com/i.js?" + params, {
      headers: { ...headers, Referer: "https://duckduckgo.com/" }
    });
    if (!res.ok) throw new ProviderError(`DuckDuckGo HTTP ${res.status}`, "blocked", res.status);
    let data = {};
    try { data = await res.json(); } catch (e) { throw new ProviderError("DuckDuckGo : réponse invalide", "blocked", res.status); }
    return (data.results || []).slice(0, 12).map(i => ({
      title: i.title || "",
      thumbnail: i.thumbnail || i.image || "",
      image: i.image || i.thumbnail || "",
      source: hostOf(i.url) || "",
      link: i.url || ""
    }));
  }
};

function isAvailable(name) {
  const p = providers[name];
  if (!p || !p.configured()) return false;
  return !(disabledUntil[name] && Date.now() < disabledUntil[name]);
}

/* ------------------------------ Routes ------------------------------ */
app.use(express.static(path.join(__dirname)));

app.get("/api/status", (req, res) => {
  const list = ORDER.filter(n => providers[n]).map(n => ({
    id: n,
    name: providers[n].label,
    configured: providers[n].configured(),
    active: isAvailable(n),
    pausedUntil: disabledUntil[n] && Date.now() < disabledUntil[n] ? new Date(disabledUntil[n]).toISOString() : null,
    reason: lastReason[n] || null
  }));
  res.json({
    configured: list.some(p => p.configured),
    providers: list,
    cacheSize: cache.size,
    nodeVersion: process.version,
    fetchAvailable: typeof fetch === "function"
  });
});

app.get("/api/images", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Nom du produit manquant." });

  const configured = ORDER.filter(n => providers[n] && providers[n].configured());
  if (!configured.length) {
    return res.status(503).json({
      error: "Aucun fournisseur de recherche configuré (SERPER_API_KEY, GOOGLE_CSE_KEY + GOOGLE_CSE_CX, SERPAPI_KEY ou DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD)."
    });
  }

  const key = q.toLowerCase();
  if (cache.has(key)) return res.json({ results: cache.get(key), cached: true });

  if (typeof fetch !== "function") {
    return res.status(500).json({ error: "Node.js trop ancien (fetch indisponible). Utilisez Node 18 ou plus." });
  }

  const failures = [];
  for (const name of ORDER) {
    if (!isAvailable(name)) continue;
    try {
      const results = (await providers[name].search(q)).filter(r => r.thumbnail && r.image);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, results);
      return res.json({ results, provider: name });
    } catch (e) {
      const kind = e.kind || "other";
      console.error(`[${name}] q="${q}" kind=${kind} status=${e.status || "-"} message=${e.message}`);
      failures.push({ name, kind, message: e.message });
      if (kind === "blocked") {
        disabledUntil[name] = Date.now() + 10 * 60 * 1000; // on réessaie dans 10 min
        lastReason[name] = "Bloqué temporairement";
      } else if (kind === "quota") {
        disabledUntil[name] = Date.now() + 6 * HOUR; // on repasse au fournisseur suivant
        lastReason[name] = "Quota épuisé";
      } else if (kind === "auth") {
        disabledUntil[name] = Date.now() + 24 * HOUR;
        lastReason[name] = "Clé invalide";
      }
    }
  }

  // Tous les fournisseurs disponibles ont échoué (ou sont déjà en pause)
  if (!failures.length) {
    const paused = configured.map(n => `${providers[n].label} : ${lastReason[n] || "en pause"}`).join(" · ");
    return res.status(429).json({
      error: `Tous les fournisseurs sont en pause (${paused}). Ajoutez un fournisseur ou attendez le renouvellement du quota.`
    });
  }
  const detail = failures.map(f => `${providers[f.name].label} : ${f.message}`).join(" · ");
  const allQuota = failures.every(f => f.kind === "quota" || f.kind === "blocked");
  res.status(allQuota ? 429 : 502).json({
    error: (allQuota ? "Tous les moteurs sont limités pour le moment, réessayez dans quelques minutes. " : "Erreur de recherche. ") + detail
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  const active = ORDER.filter(n => providers[n] && providers[n].configured()).map(n => providers[n].label);
  console.log(`Product Image Finder running on port ${PORT}`);
  console.log(`Node ${process.version} | Fournisseurs configurés : ${active.length ? active.join(", ") : "aucun"}`);
});
