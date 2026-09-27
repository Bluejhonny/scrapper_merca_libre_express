const express = require('express');
const path = require('path');
const { scrapeSearch } = require('./src/scraper');
const { toCSV } = require('./src/csv');

const app = express();
const port = process.env.PORT || 3000;

// Página del buscador
app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/search?q=jac repuestos&maxPages=5&format=json|csv
 */
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Falta el parámetro "q" con el término de búsqueda.' });
  }

  const maxPages = Math.min(Math.max(parseInt(req.query.maxPages, 10) || 3, 1), 42);
  const format = (req.query.format || 'json').toLowerCase();

  try {
    const result = await scrapeSearch(q, { maxPages });

    if (format === 'csv') {
      const filename = `${result.slug}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send('\uFEFF' + toCSV(result.items)); // BOM para que Excel lea los acentos
    }

    res.json(result);
  } catch (err) {
    console.error('[scraper]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Scraper escuchando en http://localhost:${port}`);
});
