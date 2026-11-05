require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "Product Image Finder server is running",
    apiConfigured: Boolean(process.env.SERPAPI_KEY)
  });
});

app.get("/api/images", async (req, res) => {
  const query = (req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Please provide a product name"
    });
  }

  if (!process.env.SERPAPI_KEY) {
    return res.status(503).json({
      error: "SERPAPI_KEY is not configured on the server"
    });
  }

  try {
    const response = await axios.get(
      "https://serpapi.com/search.json",
      {
        params: {
          engine: "google_images",
          q: query,
          api_key: process.env.SERPAPI_KEY
        },
        timeout: 25000
      }
    );

    const images = (response.data.images_results || [])
      .filter(item => item.original || item.thumbnail)
      .slice(0, 10)
      .map(item => ({
        title: item.title || query,
        image: item.original || item.thumbnail,
        thumbnail: item.thumbnail || item.original,
        source: item.source || "",
        link: item.link || ""
      }));

    res.json({ images });

  } catch (error) {
    console.error("Image search error:", error.message);

    res.status(500).json({
      error: "Image search failed. Please try again."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Product Image Finder running on port ${PORT}`);
});
