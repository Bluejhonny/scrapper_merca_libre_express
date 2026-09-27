const COLUMNS = [
  'id', 'title', 'price', 'currency', 'previousPrice', 'discount',
  'rating', 'freeShipping', 'shipping', 'label', 'seller', 'soldQuantity',
  'categoryId', 'url', 'image', 'page',
];

function escape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(items) {
  const lines = [COLUMNS.join(',')];
  for (const it of items) lines.push(COLUMNS.map((c) => escape(it[c])).join(','));
  return lines.join('\n');
}

module.exports = { toCSV };
