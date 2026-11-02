const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

app.use(express.static(path.join(__dirname)));

app.get("/api/status", (req, res) => {
  res.json({ configured: Boolean(SERPAPI_KEY) });
});

app.get("/api/images", async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({
      error: "Nom du produit manquant."
    });
  }

  if (!SERPAPI_KEY) {
    return res.status(503).json({
      error: "SerpApi n'est pas configuré."
    });
  }

  try {
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

    if (!response.ok) {
      throw new Error(`SerpApi HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
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

    res.json({ results });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Impossible de récupérer les images pour le moment."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Product Image Finder running on port ${PORT}`);
});
