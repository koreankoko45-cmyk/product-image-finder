const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();

// Cache en mémoire : la même recherche ne consomme pas deux fois le quota SerpApi
const cache = new Map();
const CACHE_MAX = 2000;

app.use(express.static(path.join(__dirname)));

app.get("/api/status", (req, res) => {
  res.json({
    configured: Boolean(SERPAPI_KEY),
    nodeVersion: process.version,
    fetchAvailable: typeof fetch === "function"
  });
});

// Transforme l'erreur technique en message clair pour l'utilisateur
function friendlyError(message, status) {
  const m = String(message || "").toLowerCase();
  if (status === 401 || m.includes("invalid api key")) {
    return "Clé SerpApi invalide. Vérifiez SERPAPI_KEY sur le serveur.";
  }
  if (
    status === 429 ||
    m.includes("run out of searches") ||
    m.includes("out of searches") ||
    m.includes("rate limit") ||
    m.includes("too many requests")
  ) {
    return "Quota SerpApi épuisé (ou trop de requêtes). Vérifiez « Searches left » sur serpapi.com/dashboard.";
  }
  if (m.includes("fetch is not defined")) {
    return "Node.js trop ancien (fetch indisponible). Utilisez Node 18 ou plus.";
  }
  return "Erreur SerpApi : " + message;
}

app.get("/api/images", async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({ error: "Nom du produit manquant." });
  }

  if (!SERPAPI_KEY) {
    return res.status(503).json({ error: "SerpApi n'est pas configuré." });
  }

  const cacheKey = q.toLowerCase();
  if (cache.has(cacheKey)) {
    return res.json({ results: cache.get(cacheKey), cached: true });
  }

  try {
    if (typeof fetch !== "function") {
      throw new Error("fetch is not defined");
    }

    const params = new URLSearchParams({
      engine: "google_images",
      q,
      api_key: SERPAPI_KEY,
      hl: "fr",
      gl: "ma"
    });

    const response = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );

    // SerpApi renvoie le détail de l'erreur dans le corps JSON, même en 401/429
    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      data = {};
    }

    const apiError = data && data.error ? String(data.error) : "";

    // « Aucun résultat » n'est pas une vraie erreur : on renvoie une liste vide
    if (apiError && /hasn't returned any results/i.test(apiError)) {
      return res.json({ results: [] });
    }

    if (!response.ok || apiError) {
      const err = new Error(apiError || `SerpApi HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const results = (data.images_results || [])
      .slice(0, 12)
      .map(item => ({
        title: item.title || "",
        thumbnail: item.thumbnail || item.original || "",
        image: item.original || item.thumbnail || "",
        source: item.source || "",
        link: item.link || ""
      }))
      .filter(item => item.thumbnail);

    if (cache.size >= CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(cacheKey, results);

    res.json({ results });
  } catch (error) {
    // Détail complet dans les logs du serveur (Render > Logs)
    console.error(
      `[SerpApi] q="${q}" status=${error.status || "-"} message=${error.message}`
    );

    res.status(error.status === 401 ? 401 : error.status === 429 ? 429 : 502).json({
      error: friendlyError(error.message, error.status)
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Product Image Finder running on port ${PORT}`);
  console.log(`Node ${process.version} | SerpApi key configured: ${Boolean(SERPAPI_KEY)}`);
});
