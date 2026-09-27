const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://listado.mercadolibre.com.ve';
const ITEMS_PER_PAGE = 48;
const MAX_PAGES = 42; // ML no muestra más de 2000 resultados por búsqueda

const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  validateStatus: () => true,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-VE,es-419;q=0.9,es;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (t) => (t ? t.replace(/\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim() : null);

function toSlug(term) {
  return term
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function buildPageUrl(slug, page) {
  if (page <= 1) return `${BASE_URL}/${slug}_NoIndex_True`;
  return `${BASE_URL}/${slug}_Desde_${(page - 1) * ITEMS_PER_PAGE + 1}_NoIndex_True`;
}

/* ------------------------------------------------------------------ */
/* 1) Fuente principal: el JSON de  _n.ctx.r = {...}                   */
/* ------------------------------------------------------------------ */
function extractState(html) {
  const idx = html.indexOf('_n.ctx.r=');
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;

  // Recorremos llave por llave respetando strings, para cortar
  // exactamente el objeto (después vienen cosas que no son JSON).
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const ctx = JSON.parse(html.slice(start, i + 1));
        return ctx?.appProps?.pageProps?.initialState || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function mapPolycard(pc) {
  const m = pc.metadata || {};
  const comp = {};
  for (const c of pc.components || []) comp[c.type] = c;

  const price = comp.price?.price || {};
  const previous = (price.price_labels || [])
    .flatMap((l) => l.values || [])
    .find((v) => v.price?.previous)?.price;
  const rating = comp.review_compacted?.review_compacted?.values
    ?.find((v) => v.type === 'label')?.label?.text;
  const shipping = (comp.shipping_v2?.shipping_v2 || []).map((s) => s.text).join(' | ');
  const pictureId = pc.pictures?.pictures?.[0]?.id;

  return {
    id: m.id || null,
    title: comp.title?.title?.text?.trim() || null,
    url: m.url ? `https://${m.url}${m.url_params || ''}` : null,
    price: price.current_price?.value ?? null,
    currency: price.current_price?.currency ?? null,
    previousPrice: previous?.value ?? null,
    discount: price.discount_polylabel?.values?.find((v) => v.pill)?.pill?.text || null,
    rating: rating ? Number(rating) : null,
    freeShipping: /gratis/i.test(shipping),
    shipping: shipping || null,
    label: clean(pc.float_highlight_generic?.highlight?.text),   // "ÚLTIMAS 3", "OFERTA IMPERDIBLE"
    seller: clean(comp.seller?.seller?.text),                     // solo aparece en tiendas oficiales
    soldQuantity: m.tracks?.sold_quantity ?? null,
    categoryId: m.category_id || null,
    image: pictureId ? `https://http2.mlstatic.com/D_Q_NP_2X_${pictureId}-E.webp` : null,
  };
}

function parseFromState(state) {
  const items = (state.results || [])
    .filter((r) => r.id === 'POLYCARD' && r.polycard)
    .map((r) => mapPolycard(r.polycard));

  const pag = state.pagination || {};
  return {
    items,
    nextHref: pag.next_page?.show ? pag.next_page.url : null,
    pageCount: pag.page_count ?? null,
    totalResults: state.melidata_track?.event_data?.total ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 2) Respaldo: leer el HTML renderizado                               */
/* ------------------------------------------------------------------ */
function parseMoney(el) {
  if (!el || !el.length) return null;
  const fraction = el.find('.andes-money-amount__fraction').first().text().replace(/\./g, '').trim();
  const cents = el.find('.andes-money-amount__cents').first().text().trim();
  if (!fraction) return null;
  return {
    amount: Number(cents ? `${fraction}.${cents}` : fraction),
    currency: el.find('.andes-money-amount__currency-symbol').first().text().trim() || null,
  };
}

function parseFromHtml($) {
  const items = [];
  $('li.ui-search-layout__item').each((_, li) => {
    const card = $(li);
    const a = card.find('a.poly-component__title').first();
    const title = a.text().trim();
    if (!title) return;
    const url = (a.attr('href') || '').split('#')[0];
    const idMatch = url.match(/MLV-?(\d+)/i);
    const current = parseMoney(card.find('.poly-price__current .andes-money-amount').first());
    const previous = parseMoney(card.find('.andes-money-amount--previous').first());
    const rating = card.find('.poly-component__review-compacted .polylabel-label').first().text().trim();
    const shipping = card.find('.poly-component__shipping-v2 [aria-hidden="true"]').text().trim();

    items.push({
      id: idMatch ? `MLV${idMatch[1]}` : null,
      title,
      url,
      price: current?.amount ?? null,
      currency: current?.currency ?? null,
      previousPrice: previous?.amount ?? null,
      discount: card.find('.poly-price__discount-polylabel').text().trim() || null,
      rating: rating ? Number(rating) : null,
      freeShipping: /gratis/i.test(shipping),
      shipping: shipping || null,
      label: card.find('.poly-component__poly-label').text().trim() || null,
      seller: card.find('.poly-component__seller').text().trim() || null,
      soldQuantity: null,
      categoryId: null,
      image: card.find('img.poly-component__picture').last().attr('src') || null,
    });
  });
  // Ojo: en el HTML los links de paginación vienen con href="" (los maneja React),
  // por eso la paginación sale del JSON o se calcula por offset.
  return { items, nextHref: null, pageCount: null, totalResults: null };
}

function parsePage(html) {
  const state = extractState(html);
  if (state) {
    const r = parseFromState(state);
    if (r.items.length) return { ...r, source: 'json' };
  }
  return { ...parseFromHtml(cheerio.load(html)), source: 'html' };
}

/* ------------------------------------------------------------------ */
/* Diagnóstico                                                          */
/* ------------------------------------------------------------------ */
function diagnose(html, res) {
  const $ = cheerio.load(html);
  const finalUrl = res.request?.res?.responseUrl || res.config.url;
  const lower = html.toLowerCase();
  const hasState = html.includes('_n.ctx.r=');

  let reason = 'desconocido';
  if (res.status === 403 || res.status === 429) reason = `bloqueo HTTP ${res.status}`;
  else if (/captcha/.test(lower) && !hasState) reason = 'captcha';
  else if (/account-verification|negative_traffic|lgz\/login/.test(finalUrl.toLowerCase()))
    reason = 'verificación anti-bot / redirección a login';
  else if (/no hay publicaciones que coincidan/.test(lower)) reason = 'la búsqueda no tiene resultados';
  else if (!hasState) reason = 'la página no trae el JSON de resultados (probable bloqueo)';

  return {
    status: res.status,
    finalUrl,
    title: $('title').first().text().trim(),
    size: html.length,
    hasState,
    listItems: $('li.ui-search-layout__item').length,
    reason,
  };
}

function saveDebug(slug, page, html) {
  const dir = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}-p${page}.html`);
  fs.writeFileSync(file, html);
  return file;
}

/* ------------------------------------------------------------------ */
async function scrapeSearch(term, { maxPages = 3, delayMs = 1500 } = {}) {
  const slug = toSlug(term);
  if (!slug) throw new Error('El término de búsqueda no es válido.');
  maxPages = Math.min(maxPages, MAX_PAGES);

  const seen = new Set();
  const items = [];
  let url = buildPageUrl(slug, 1);
  let page = 1;
  let pageCount = null;
  let totalResults = null;

  while (url && page <= maxPages) {
    const res = await http.get(url);
    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const parsed = parsePage(html);
    console.log(`[scraper] Página ${page} (${res.status}) → ${parsed.items.length} productos [${parsed.source}]`);

    if (parsed.items.length === 0) {
      const info = diagnose(html, res);
      const file = saveDebug(slug, page, html);
      console.error('[scraper] Diagnóstico:', info);
      if (page === 1) {
        const err = new Error(`Sin productos en la página 1. Causa probable: ${info.reason}. HTML guardado en ${file}`);
        err.diagnostic = info;
        throw err;
      }
      break;
    }

    if (page === 1) {
      pageCount = parsed.pageCount;
      totalResults = parsed.totalResults;
    }

    for (const it of parsed.items) {
      const key = it.id || it.url;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...it, page });
    }

    page++;
    const lastPage = pageCount ? Math.min(pageCount, maxPages) : maxPages;
    if (page > lastPage) break;

    url = parsed.nextHref
      || (parsed.items.length >= ITEMS_PER_PAGE ? buildPageUrl(slug, page) : null);
    if (url) await sleep(delayMs);
  }

  return {
    query: term,
    slug,
    totalResults,      // total que reporta ML (ej. 12479)
    pageCount,         // páginas disponibles (máx. 42)
    pagesScraped: page - 1,
    total: items.length,
    items,
  };
}

module.exports = { scrapeSearch, parsePage, extractState, diagnose, toSlug, buildPageUrl };
