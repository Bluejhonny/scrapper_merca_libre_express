const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://listado.mercadolibre.com.ve';
const ITEMS_PER_PAGE = 48; // lo que muestra ML por página en la vista grid

const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Jac Repuestos" -> "jac-repuestos" */
function toSlug(term) {
  return term
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9ñ\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

/** URL de la página N (1-based). ML pagina con _Desde_<offset> */
function buildPageUrl(slug, page) {
  if (page <= 1) return `${BASE_URL}/${slug}_NoIndex_True`;
  const desde = (page - 1) * ITEMS_PER_PAGE + 1;
  return `${BASE_URL}/${slug}_Desde_${desde}_NoIndex_True`;
}

/** Convierte un bloque .andes-money-amount en número */
function parseMoney($, el) {
  if (!el || !el.length) return null;
  const fraction = el.find('.andes-money-amount__fraction').first().text().replace(/\./g, '').trim();
  const cents = el.find('.andes-money-amount__cents').first().text().trim();
  if (!fraction) return null;
  return {
    amount: Number(cents ? `${fraction}.${cents}` : fraction),
    currency: el.find('.andes-money-amount__currency-symbol').first().text().trim() || null,
  };
}

/** Toma la mejor URL de imagen disponible (src, data-src o la primera del srcset) */
function getImage(img) {
  const src = img.attr('src') || img.attr('data-src');
  if (src && !src.startsWith('data:')) return src;
  const srcset = img.attr('srcset') || img.attr('data-srcset');
  if (srcset) return srcset.split(',').pop().trim().split(' ')[0];
  return null;
}

/** Extrae los productos del <ol> de resultados */
function parseItems(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('ol.ui-search-layout > li.ui-search-layout__item').each((_, li) => {
    const card = $(li);
    const titleLink = card.find('a.poly-component__title').first();
    const title = titleLink.text().trim();
    if (!title) return;

    const rawUrl = titleLink.attr('href') || '';
    const url = rawUrl.split('#')[0]; // quita los parámetros de tracking
    const idMatch = url.match(/(MLV)-?(\d+)/i);

    const current = parseMoney($, card.find('.poly-price__current .andes-money-amount').first());
    const previous = parseMoney($, card.find('.andes-money-amount--previous').first());
    const rating = card.find('.poly-component__review-compacted .polylabel-label').first().text().trim();
    const shippingText = card.find('.poly-component__shipping-v2').text();

    items.push({
      id: idMatch ? `${idMatch[1].toUpperCase()}${idMatch[2]}` : null,
      title,
      url,
      price: current ? current.amount : null,
      currency: current ? current.currency : null,
      previousPrice: previous ? previous.amount : null,
      discount: card.find('.poly-price__discount-polylabel').text().trim() || null,
      rating: rating ? Number(rating) : null,
      freeShipping: /env[ií]o gratis/i.test(shippingText),
      label: card.find('.poly-component__poly-label').text().trim() || null, // "ÚLTIMAS 3", "OFERTA IMPERDIBLE"...
      image: getImage(card.find('img.poly-component__picture').first()),
    });
  });

  // Link "Siguiente" de la paginación (si existe, hay más páginas)
  const nextHref =
    $('li.andes-pagination__button--next a').attr('href') ||
    $('a[title="Siguiente"]').attr('href') ||
    null;

  return { items, nextHref };
}

/** Guarda el HTML recibido cuando algo sale raro, para poder revisarlo */
function saveDebug(slug, page, html) {
  const dir = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}-p${page}.html`);
  fs.writeFileSync(file, html);
  return file;
}

/**
 * Recorre todas las páginas del listado hasta que no haya "Siguiente"
 * o se alcance maxPages.
 */
async function scrapeSearch(term, { maxPages = 3, delayMs = 1500 } = {}) {
  const slug = toSlug(term);
  if (!slug) throw new Error('El término de búsqueda no es válido.');

  const seen = new Set();
  const items = [];
  let url = buildPageUrl(slug, 1);
  let page = 1;

  while (url && page <= maxPages) {
    console.log(`[scraper] Página ${page}: ${url}`);
    const { data: html } = await http.get(url);
    const { items: pageItems, nextHref } = parseItems(html);

    if (pageItems.length === 0) {
      const file = saveDebug(slug, page, html);
      if (page === 1) {
        throw new Error(
          `No se encontraron productos en la primera página. ` +
            `Puede que no haya resultados o que MercadoLibre haya devuelto un captcha/verificación. ` +
            `HTML guardado en ${file}`
        );
      }
      break;
    }

    for (const it of pageItems) {
      const key = it.id || it.url;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...it, page });
    }

    page++;
    // Preferimos el link "Siguiente"; si no aparece, paramos.
    url = nextHref ? nextHref.split('#')[0] : null;
    if (url && page <= maxPages) await sleep(delayMs);
  }

  return {
    query: term,
    slug,
    pagesScraped: page - 1,
    total: items.length,
    items,
  };
}

module.exports = { scrapeSearch, parseItems, toSlug, buildPageUrl };
