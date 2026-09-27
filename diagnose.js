// Uso: node diagnose.js "jac repuestos"
const { scrapeSearch } = require('./src/scraper');

scrapeSearch(process.argv[2] || 'jac repuestos', { maxPages: 1 })
  .then((r) => console.log(`OK: ${r.total} productos. Primero:`, r.items[0]))
  .catch((e) => {
    console.error('\nFALLÓ:', e.message);
    if (e.diagnostic) console.table(e.diagnostic);
  });
