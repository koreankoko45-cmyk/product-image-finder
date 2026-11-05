const express = require('express');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PROGRESS_FILE = path.join(__dirname, 'progress.json');
if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, '{}');

// المجموعات ديالك - 9
const CATEGORIES = {
  "Maquillage": { file: "Maquillage.xlsx", total: 1500 },
  "Bebe_et_Maman": { file: "Produits_Bebe_et_Maman.xlsx", total: 350 },
  "Parfums": { file: "Parfums_et_Deodorants.xlsx", total: 800 },
  "Solaire": { file: "Protections_Solaires.xlsx", total: 500 },
  "Hygiene": { file: "Hygiene_et_Soins_Personnels.xlsx", total: 900 },
  "Bucco": { file: "Hygiene_Buccodentaire.xlsx", total: 400 },
  "Materiel": { file: "Materiel_Medical_et_Sante.xlsx", total: 350 },
  "Divers": { file: "Produits_Divers_A_Verifier.xlsx", total: 2177 }
};

app.get('/api/categories', (req, res) => {
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  const list = Object.keys(CATEGORIES).map(id => ({
    id,
    ...CATEGORIES[id],
    done: progress[id] ? Object.keys(progress[id]).filter(k=>k!=='last').length : 0
  }));
  res.json(list);
});

app.get('/api/products', (req, res) => {
  const catId = req.query.cat;
  const file = CATEGORIES[catId]?.file;
  if (!file || !fs.existsSync(file)) return res.json([]);
  const wb = xlsx.readFile(file);
  const data = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  res.json(data);
});

// نفس محرك البحث ديالك + تأخير باش ما يتبلوكاش
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  await new Promise(r => setTimeout(r, 5000)); // راحة 5 ثواني - فابور

  try {
    // قلب ف Bing فابور
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(q + " product")}&form=HDRSC2`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(data);
    const images = [];
    $('img.mimg').each((i, el) => {
      if (images.length >= 3) return;
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http')) images.push(src);
    });
    res.json(images.length ? images : [`https://via.placeholder.com/500?text=${encodeURIComponent(q)}`]);
  } catch (e) {
    res.json([`https://via.placeholder.com/500?text=${encodeURIComponent(q)}`]);
  }
});

app.get('/api/progress', (req, res) => {
  res.json(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')));
});

app.post('/api/save', (req, res) => {
  const { cat, index, imageUrl, designation } = req.body;
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  if (!progress[cat]) progress[cat] = {};
  progress[cat][index] = { imageUrl, designation, date: new Date().toISOString() };
  progress[cat].last = index;
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  const rows = [];
  for (const cat in progress) {
    for (const idx in progress[cat]) {
      if (idx === 'last') continue;
      const item = progress[cat][idx];
      rows.push({ Categorie: cat, Index: idx, Designation: item.designation || '', Image_URL: item.imageUrl });
    }
  }
  const ws = xlsx.utils.json_to_sheet(rows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Images");
  const out = "export_images_avec_liens.xlsx";
  xlsx.writeFile(wb, out);
  res.download(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site prive khdam f port ${PORT}`));
