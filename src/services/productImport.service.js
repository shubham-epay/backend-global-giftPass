const { Product, Category, Partner } = require('../models');
const ApiError = require('../utils/ApiError');
const { parseCsv, toCsv } = require('../utils/csv');
const { slugify, isObjectId, round2 } = require('../utils/helpers');
const { SLUG_RE, URL_RE } = require('../models/_shared');
const { PRODUCT_STATUS } = require('../constants/enums');
const v = require('../validators/admin.validators');
const { z } = require('../validators/common');

const MAX_ROWS = 2000;
const MAX_PRODUCTS = 5000; // after denominations are expanded into separate products

/**
 * Import columns. Header matching ignores case, spaces and punctuation, so "Sale Price", "sale_price"
 * and "salePrice" are the same column. Indexed headers ("proimg[0].src", "images.1", "howToUse[2]",
 * "image_3") are grouped into lists. To support another export format, add its header names to `aliases`.
 *
 * Field kinds:  array = URL list · list = text list (one item per indexed column or per line)
 *               bool  = TRUE/FALSE; several columns mapped to one bool field are OR-ed together
 *
 * The Grabsouq export format (price + delPrice, proimg[n].src, brand/supplier, recommended/bestsellers/dealzone,
 * howToUse[n], importantInstructions[n], termsConditions[n], whatsIncluded, packageDetails, denominations[n].*)
 * is covered by these aliases.
 */
const FIELDS = [
  { key: 'title', label: 'Title', required: true, aliases: ['title', 'name', 'productname', 'producttitle', 'experience', 'experiencename'] },
  { key: 'slug', label: 'URL slug', help: 'Generated from the title when empty. Used to match existing products.', aliases: ['slug', 'urlslug', 'handle', 'productslug', 'seourl'] },
  { key: 'category', label: 'Category', required: true, help: 'Category id, slug or name', aliases: ['category', 'categoryid', 'categoryslug', 'categoryname', 'categories', 'productcategory'] },
  { key: 'partner', label: 'Partner', required: true, help: 'Partner id or name (brand is used first, then supplier)', aliases: ['brand', 'brandname', 'partner', 'partnerid', 'partnername', 'merchant', 'merchantname', 'vendor', 'vendorname', 'supplier', 'suppliername'] },
  { key: 'city', label: 'City', required: true, aliases: ['city', 'cityname', 'location'] },
  { key: 'country', label: 'Country', required: true, aliases: ['country', 'countryname'] },
  { key: 'currency', label: 'Currency', help: '3-letter code, default AED', aliases: ['currency', 'currencycode'] },
  { key: 'price', label: 'Price', required: true, help: 'Selling price. When a list/old price column (delPrice, oldPrice, mrp…) is present that becomes the struck-through price.', aliases: ['price', 'baseprice', 'amount'] },
  { key: 'listPrice', label: 'List (old) price', help: 'Struck-through "was" price', aliases: ['delprice', 'oldprice', 'mrp', 'listprice', 'regularprice', 'originalprice', 'compareatprice', 'wasprice', 'strikeprice'] },
  { key: 'salePrice', label: 'Sale price', help: 'Defaults to price', aliases: ['saleprice', 'sellingprice', 'specialprice', 'discountprice', 'discountedprice', 'finalprice', 'offerprice'] },
  { key: 'duration', label: 'Duration', required: true, help: 'e.g. "90 minutes". Also read from a "Duration" line in packageDetails.', aliases: ['duration', 'durationtext'] },
  { key: 'validityDays', label: 'Validity (days)', required: true, help: 'Also read from text such as "valid 6 months from purchase"', aliases: ['validitydays', 'validity', 'validityindays', 'expirydays', 'vouchervalidity', 'vouchervaliditydays'] },
  { key: 'imageUrls', label: 'Images', required: true, array: true, help: 'One or more image URLs; first is the cover', aliases: ['imageurls', 'imageurl', 'images', 'image', 'imagessrc', 'imagesurl', 'proimg', 'proimgsrc', 'productimages', 'productimagessrc', 'mainimage', 'thumbnail', 'thumbnailurl', 'coverimage', 'photo', 'photos', 'img'] },
  { key: 'galleryUrls', label: 'Gallery', array: true, aliases: ['galleryurls', 'gallery', 'galleryimages', 'additionalimages'] },
  { key: 'status', label: 'Status', help: `${PRODUCT_STATUS.join(' / ')}, or TRUE/FALSE`, aliases: ['status', 'productstatus'] },
  { key: 'active', label: 'Active flag', bool: true, help: 'TRUE/FALSE, used when there is no status column', aliases: ['isactive', 'active', 'published', 'ispublished', 'enabled', 'isenabled', 'visible', 'isvisible'] },
  { key: 'featured', label: 'Featured', bool: true, aliases: ['featured', 'isfeatured', 'recommended', 'topproducts'] },
  { key: 'bestSeller', label: 'Best seller', bool: true, aliases: ['bestseller', 'isbestseller', 'bestselling', 'bestsellers', 'dailybestsells', 'dailybestsellers'] },
  { key: 'flashSale', label: 'Flash sale', bool: true, aliases: ['flashsale', 'isflashsale', 'dealzone'] },
  { key: 'peopleCount', label: 'People included', aliases: ['peoplecount', 'people', 'persons', 'guests', 'pax'] },
  { key: 'ratingAvg', label: 'Rating', help: '0–5', aliases: ['ratingavg', 'rating', 'averagerating', 'fivestarrating', 'fivestartrating', 'stars'] },
  { key: 'shortDescription', label: 'Short description', help: 'If absent, the first paragraph of the description is used', aliases: ['shortdescription', 'shortdesc', 'summary', 'subtitle', 'tagline', 'excerpt'] },
  { key: 'description', label: 'Description', aliases: ['description', 'longdescription', 'fulldescription', 'details', 'desc'] },
  { key: 'whatsIncluded', label: "What's included", list: true, aliases: ['whatsincluded', 'whatisincluded', 'included', 'inclusions'] },
  { key: 'whatsNotIncluded', label: "What's not included", list: true, aliases: ['whatsnotincluded', 'whatisnotincluded', 'notincluded', 'exclusions'] },
  { key: 'howToUse', label: 'How to use', list: true, aliases: ['howtouse', 'howtoredeem', 'redemptionsteps'] },
  { key: 'importantInstructions', label: 'Important instructions', list: true, aliases: ['importantinstructions', 'instructions', 'importantinfo', 'goodtoknow'] },
  { key: 'termsConditions', label: 'Terms & conditions', list: true, aliases: ['termsconditions', 'termsandconditions', 'terms', 'tnc', 'tandc'] },
  { key: 'packageDetails', label: 'Package details', help: 'Alternating label / value lines, or "Label: value" lines', aliases: ['packagedetails', 'keyfacts', 'ataglance'] },
  { key: 'legalNote', label: 'Legal note', aliases: ['legalnote', 'disclaimer', 'fineprint'] },
  { key: 'supplierReference', label: 'Supplier reference', aliases: ['supplierreference', 'supplierref', 'sku', 'productcode', 'externalid', 'externalreference'] },
  { key: 'apiDeliveryId', label: 'API delivery ID', aliases: ['apideliveryid', 'deliveryid', 'providerproductid'] },
  { key: 'seoTitle', label: 'SEO title', aliases: ['seotitle', 'metatitle'] },
  { key: 'seoDescription', label: 'SEO description', aliases: ['seodescription', 'metadescription'] },
  { key: 'hasDenominations', label: 'Has denominations', bool: true, help: 'When TRUE, each denominations[n] becomes its own product', aliases: ['hasdenominations', 'hasvariants'] },
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const ALIAS = new Map(FIELDS.flatMap((f) => f.aliases.map((a) => [a, f])));

/** Repeating groups: denominations[0].label, denominations[0].price, … */
const GROUP_ALIASES = new Map(['denominations', 'denomination', 'variants'].map((a) => [a, 'denominations']));
const GROUP_SUBS = {
  label: ['label', 'name', 'title'],
  value: ['value', 'facevalue', 'denomination'],
  currency: ['currency'],
  price: ['price', 'saleprice', 'sellingprice'],
  oldPrice: ['oldprice', 'delprice', 'listprice', 'mrp', 'regularprice'],
  img: ['img', 'image', 'imageurl', 'src'],
};
const SUB_ALIAS = new Map(Object.entries(GROUP_SUBS).flatMap(([k, as]) => as.map((a) => [a, k])));

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header -> { field, index } | { group, index, sub } | null */
function matchHeader(header) {
  const h = String(header).trim().replace(/\[(\d+)\]/g, '.$1');
  const parts = h.split('.').filter((p) => p !== '');
  const numeric = parts.filter((p) => /^\d+$/.test(p));
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const index = numeric.length ? Number(numeric[0]) : undefined;

  if (words.length >= 2 && GROUP_ALIASES.has(norm(words[0]))) {
    const sub = SUB_ALIAS.get(norm(words.slice(1).join('')));
    return sub ? { group: GROUP_ALIASES.get(norm(words[0])), index: index ?? 0, sub } : null;
  }

  let field = ALIAS.get(norm(words.join('.')));
  let idx = index;
  if (!field) {
    const m = words.join('.').match(/^(.*?)[\s_-]?(\d{1,2})$/);
    const f = m && ALIAS.get(norm(m[1]));
    if (f && (f.array || f.list)) { field = f; idx = Number(m[2]); }
  }
  if (!field) return null;
  if (idx !== undefined && !field.array && !field.list && idx > 0) return null; // e.g. "category.1": only the first is used
  return { field, index: idx };
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'on', 'active', 'published']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', 'inactive', 'unpublished', '']);
const parseBool = (s) => {
  const t = String(s ?? '').trim().toLowerCase();
  if (TRUE.has(t)) return true;
  if (FALSE.has(t)) return false;
  return undefined;
};
const parseNumber = (s) => {
  const t = String(s).replace(/[^0-9.\-]/g, '');
  if (t === '' || t === '-' || t === '.') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const splitUrls = (s) => String(s).split(/\s*[|\n]\s*|\s*,\s*(?=https?:\/\/)/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => String(s).split(/\n+/).map((x) => x.trim()).filter(Boolean);
/** Exports often escape line breaks as a literal "\n"; turn them back into real newlines. */
const cleanCell = (s) => String(s ?? '').replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
const stripNumbering = (s) => s.replace(/^\s*(\d{1,2}[.)]|[-•*])\s+/, '').trim();
const STATUS_ALIASES = { LIVE: 'ACTIVE', PUBLISHED: 'ACTIVE', ENABLED: 'ACTIVE', TRUE: 'ACTIVE', YES: 'ACTIVE', UNPUBLISHED: 'INACTIVE', DISABLED: 'INACTIVE', HIDDEN: 'INACTIVE', FALSE: 'INACTIVE', NO: 'INACTIVE' };

/** "Duration\n3–4 hours\nCapacity\n10 guests" or "Duration: 3–4 hours" lines -> [{ label, value }] */
function parsePackageDetails(text) {
  const lines = splitLines(text);
  if (!lines.length) return [];
  if (lines.every((l) => /^[^:]{1,80}:\s*\S/.test(l))) {
    return lines.map((l) => { const i = l.indexOf(':'); return { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }; });
  }
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push({ label: lines[i].slice(0, 80), value: (lines[i + 1] || '').slice(0, 300) });
  return pairs;
}

/** Finds "valid 6 months" / "validity … 12 months" / "valid for 90 days" in free text. */
function validityFromText(texts) {
  const rx = /valid(?:ity)?\b[^.\n]{0,40}?(\d{1,3})\s*(day|week|month|year)s?/i;
  for (const t of texts) {
    const m = rx.exec(t || '');
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const days = unit === 'month' ? Math.round((n * 365) / 12) : { day: 1, week: 7, year: 365 }[unit] * n;
      if (days >= 1 && days <= 3650) return days;
    }
  }
  return undefined;
}

const importSchema = v.product.create.extend({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').optional(),
  ratingAvg: z.number().min(0).max(5).optional(),
});

/** Loads id/slug/name lookups for categories and partners once per import. */
async function loadRefs() {
  const [cats, partners] = await Promise.all([
    Category.find().select('name slug').lean(),
    Partner.find().select('name city').lean(),
  ]);
  const index = (docs, keys) => {
    const m = new Map();
    for (const d of docs) {
      m.set(String(d._id), d);
      for (const k of keys) if (d[k]) m.set(`${k}:${String(d[k]).trim().toLowerCase()}`, d);
    }
    return m;
  };
  return { categories: index(cats, ['slug', 'name']), partners: index(partners, ['name']) };
}

function resolveRef(map, raw, keys) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (isObjectId(s) && map.has(s)) return map.get(s);
  for (const k of keys) {
    const hit = map.get(`${k}:${s.toLowerCase()}`);
    if (hit) return hit;
  }
  return null;
}

/** Reads one CSV row into { raw, denominations } using the column mapping. */
function readCells(cells, mapped) {
  const raw = {};
  const denominations = [];
  for (const m of mapped) {
    const cell = cleanCell(cells[m.col]);
    if (!cell) continue;
    // Some exports fill a column with its own name as a placeholder (e.g. supplier = "supplier").
    if (norm(cell) === norm(m.header)) continue;
    if (m.group) {
      denominations[m.index] = denominations[m.index] || {};
      denominations[m.index][m.sub] = cell;
      continue;
    }
    const f = FIELD[m.field];
    if (f.array) {
      raw[f.key] = raw[f.key] || [];
      const urls = splitUrls(cell);
      if (m.index !== undefined) raw[f.key][m.index] = urls[0]; else raw[f.key].push(...urls);
    } else if (f.list) {
      raw[f.key] = raw[f.key] || [];
      if (m.index !== undefined) raw[f.key][m.index] = cell.replace(/\s*\n+\s*/g, ' ');
      else raw[f.key].push(...splitLines(cell));
    } else if (f.bool) {
      const b = parseBool(cell);
      if (b === undefined) { if (raw[f.key] === undefined) raw[f.key] = cell; } else raw[f.key] = String(b || parseBool(raw[f.key]) === true);
    } else if (raw[f.key] === undefined) {
      raw[f.key] = cell;
    }
  }
  for (const f of FIELDS) {
    if ((f.array || f.list) && raw[f.key]) raw[f.key] = [...new Set(raw[f.key].filter(Boolean))];
    if ((f.array || f.list) && raw[f.key] && !raw[f.key].length) delete raw[f.key];
  }
  return { raw, denominations: denominations.filter(Boolean) };
}

/**
 * Parses and validates the CSV. Nothing is written. Returns a plan the caller can show (dry run) or commit.
 * options: { mode: 'create'|'upsert', createMissing, defaults: { categoryId, partnerId, fallbackPartner, city, country, duration, validityDays, status } }
 */
async function planImport(csvText, options) {
  const { mode, createMissing, defaults } = options;
  const table = parseCsv(csvText);
  if (table.length < 2) throw ApiError.badRequest('The file needs a header row and at least one product row');
  const [headers, ...body] = table;
  if (body.length > MAX_ROWS) throw ApiError.badRequest(`Import up to ${MAX_ROWS} rows at a time (this file has ${body.length})`);

  // ---- column mapping ----
  const mapped = [];
  const ignored = [];
  headers.forEach((header, col) => {
    if (!String(header).trim()) return;
    const m = matchHeader(header);
    if (!m) ignored.push(header);
    else if (m.group) mapped.push({ col, header, group: m.group, sub: m.sub, index: m.index, field: `${m.group}.${m.sub}` });
    else mapped.push({ col, header, field: m.field.key, index: m.index });
  });
  const present = new Set(mapped.map((m) => m.field));
  const fallbackPartner = createMissing && defaults.fallbackPartner ? String(defaults.fallbackPartner).trim() : '';
  const missingColumns = FIELDS.filter((f) => f.required && !present.has(f.key)
    && !(f.key === 'price' && (present.has('salePrice') || present.has('listPrice') || present.has('denominations.price')))
    && !(f.key === 'category' && defaults.categoryId)
    && !(f.key === 'partner' && (defaults.partnerId || fallbackPartner))
    && !(f.key === 'duration' && (defaults.duration || present.has('packageDetails')))
    && !(['city', 'country', 'validityDays'].includes(f.key) && defaults[f.key]))
    .map((f) => f.label);

  const refs = await loadRefs();
  const [defaultCategory, defaultPartner] = [
    defaults.categoryId ? refs.categories.get(String(defaults.categoryId)) : null,
    defaults.partnerId ? refs.partners.get(String(defaults.partnerId)) : null,
  ];
  if (defaults.categoryId && !defaultCategory) throw ApiError.badRequest('The default category no longer exists');
  if (defaults.partnerId && !defaultPartner) throw ApiError.badRequest('The default partner no longer exists');

  const newCategories = new Map(); // lower name -> display name
  const newPartners = new Map();   // lower name -> { name, city, country }
  const seenSlugs = new Map();     // slug -> first row id

  /** Resolves a category/partner value to an existing id, a to-be-created "new:" key, the default, or an error. */
  const pickRef = (kind, value, row) => {
    const isCat = kind === 'category';
    const map = isCat ? refs.categories : refs.partners;
    const found = resolveRef(map, value, isCat ? ['slug', 'name'] : ['name']);
    const fallback = isCat ? defaultCategory : defaultPartner;
    const label = isCat ? 'Category' : 'Partner';
    if (found) return { id: String(found._id), label: found.name };
    if (value) {
      if (createMissing && !isObjectId(value)) {
        const name = value.trim();
        const key = name.toLowerCase();
        if (isCat) newCategories.set(key, newCategories.get(key) || name);
        else if (!newPartners.has(key)) newPartners.set(key, { name, city: row.city || defaults.city, country: row.country || defaults.country });
        return { id: `new:${key}`, label: name, created: true };
      }
      if (fallback) return { id: String(fallback._id), label: fallback.name, warning: `${label} "${value}" not found, using default "${fallback.name}"` };
      return { error: `${label} "${value}" not found` };
    }
    if (fallback) return { id: String(fallback._id), label: fallback.name };
    if (!isCat && fallbackPartner) return pickRef('partner', fallbackPartner, row);
    return { error: `${label} is required`, missing: true };
  };

  /** Builds and pre-validates one product from a raw row. */
  const buildRow = (raw, rowId) => {
    const errors = [];
    const warnings = [];
    const data = {};
    // Keys whose value came from this row's cells (not from import defaults). Updates only touch these.
    const fromFile = new Set(Object.keys(raw).filter((k) => !['active', 'listPrice', 'hasDenominations', 'category', 'partner'].includes(k)));
    // `missing: true` marks "required but absent" problems, which do not apply when updating an existing product.
    const need = (field, message) => errors.push({ field, message, missing: true });

    data.title = raw.title;
    data.slug = raw.slug ? slugify(raw.slug) : slugify(raw.title || '');

    // ---- category / partner ----
    const cat = pickRef('category', raw.category, raw);
    if (cat.error) (cat.missing ? need : (f, msg) => errors.push({ field: f, message: msg }))('category', cat.error);
    else { data.categoryId = cat.id; if (cat.warning) warnings.push(cat.warning); }
    const partner = pickRef('partner', raw.partner, raw);
    if (partner.error) (partner.missing ? need : (f, msg) => errors.push({ field: f, message: msg }))('partner', partner.error);
    else { data.partnerId = partner.id; if (partner.warning) warnings.push(partner.warning); }
    if (raw.category) fromFile.add('categoryId');
    if (raw.partner) fromFile.add('partnerId');

    data.city = raw.city || defaults.city;
    data.country = raw.country || defaults.country;
    if (raw.currency) data.currency = raw.currency;

    // ---- prices ----
    const num = (k) => (raw[k] !== undefined ? parseNumber(raw[k]) : undefined);
    const p = num('price'); const l = num('listPrice'); const s = num('salePrice');
    for (const [k, n] of [['price', p], ['listPrice', l], ['salePrice', s]]) {
      if (Number.isNaN(n)) errors.push({ field: k === 'listPrice' ? 'price' : k, message: `"${raw[k]}" is not a number` });
    }
    const ok = (n) => n !== undefined && !Number.isNaN(n);
    let sale; let list;
    if (ok(l)) { sale = ok(s) ? s : ok(p) ? p : l; list = l; } else { sale = ok(s) ? s : p; list = ok(s) && ok(p) ? p : sale; }
    if (ok(sale) && ok(list) && sale > list) {
      if (ok(l)) { warnings.push(`Old price ${list} is below the selling price ${sale}; no discount shown`); list = sale; } else errors.push({ field: 'salePrice', message: 'Sale price cannot be greater than price' });
    }
    if (ok(list)) data.price = round2(list);
    if (ok(sale)) data.salePrice = round2(sale);
    fromFile.delete('price'); fromFile.delete('salePrice');
    if (raw.listPrice !== undefined || (raw.price !== undefined && raw.salePrice !== undefined) || (raw.price !== undefined && raw.listPrice === undefined && raw.salePrice === undefined)) fromFile.add('price');
    if (raw.salePrice !== undefined || raw.listPrice !== undefined || (raw.price !== undefined && raw.salePrice === undefined)) fromFile.add('salePrice');

    // ---- content ----
    if (raw.description !== undefined) {
      const paras = raw.description.split(/\n\s*\n/);
      if (raw.shortDescription === undefined && paras.length > 1 && paras[0].length <= 500) {
        data.shortDescription = paras[0].trim();
        data.description = paras.slice(1).join('\n\n').trim();
        fromFile.add('shortDescription');
      } else data.description = raw.description;
    }
    if (raw.shortDescription !== undefined) data.shortDescription = raw.shortDescription;
    for (const k of ['whatsIncluded', 'whatsNotIncluded', 'importantInstructions']) if (raw[k]) data[k] = raw[k];
    if (raw.howToUse) data.howToUse = raw.howToUse.map(stripNumbering).filter(Boolean);
    if (raw.termsConditions) data.termsConditions = raw.termsConditions.join('\n');
    if (raw.packageDetails) data.packageDetails = parsePackageDetails(raw.packageDetails);
    for (const k of ['legalNote', 'supplierReference', 'apiDeliveryId', 'seoTitle', 'seoDescription']) if (raw[k] !== undefined) data[k] = raw[k];
    if (data.seoTitle && data.seoTitle.length > 70) { data.seoTitle = data.seoTitle.slice(0, 70); warnings.push('SEO title shortened to 70 characters'); }
    if (data.seoDescription && data.seoDescription.length > 170) { data.seoDescription = data.seoDescription.slice(0, 170); warnings.push('SEO description shortened to 170 characters'); }

    // ---- duration & validity (column → package details / text → defaults) ----
    const detail = (rx) => (data.packageDetails || []).find((d) => rx.test(d.label))?.value;
    if (raw.duration) data.duration = raw.duration;
    else if (detail(/^duration$/i)) { data.duration = detail(/^duration$/i).slice(0, 60); fromFile.add('duration'); } else data.duration = defaults.duration;

    if (raw.validityDays !== undefined) {
      const n = parseNumber(raw.validityDays);
      if (ok(n)) data.validityDays = Math.round(n);
      else {
        const t = validityFromText([raw.validityDays]);
        if (t) data.validityDays = t; else errors.push({ field: 'validityDays', message: `"${raw.validityDays}" is not a number of days` });
      }
    } else {
      const t = validityFromText([...(data.importantInstructions || []), data.termsConditions, detail(/validity/i)]);
      if (t) { data.validityDays = t; fromFile.add('validityDays'); } else if (defaults.validityDays) data.validityDays = Number(defaults.validityDays);
    }

    // ---- numbers & flags ----
    if (raw.peopleCount !== undefined) {
      const n = parseNumber(raw.peopleCount);
      if (!ok(n)) { warnings.push(`Ignored people count "${raw.peopleCount}"`); fromFile.delete('peopleCount'); } else data.peopleCount = Math.round(n);
    }
    if (raw.ratingAvg !== undefined) {
      const n = parseNumber(raw.ratingAvg);
      if (ok(n) && n >= 0 && n <= 5) data.ratingAvg = Math.round(n * 10) / 10;
      else { warnings.push(`Ignored rating "${raw.ratingAvg}"`); fromFile.delete('ratingAvg'); }
    }

    data.imageUrls = (raw.imageUrls || []).filter((u) => URL_RE.test(u));
    if ((raw.imageUrls || []).length !== data.imageUrls.length) warnings.push('Skipped image values that are not http(s) URLs');
    if (data.imageUrls.length > 20) { data.imageUrls = data.imageUrls.slice(0, 20); warnings.push('Only the first 20 images were kept'); }
    if (!data.imageUrls.length) fromFile.delete('imageUrls');
    if (raw.galleryUrls) data.galleryUrls = raw.galleryUrls.filter((u) => URL_RE.test(u)).slice(0, 30);

    if (raw.status) {
      const st = raw.status.toUpperCase().replace(/\s+/g, '_');
      data.status = STATUS_ALIASES[st] || st;
      if (!PRODUCT_STATUS.includes(data.status)) errors.push({ field: 'status', message: `Unknown status "${raw.status}" (use ${PRODUCT_STATUS.join(', ')} or TRUE/FALSE)` });
    } else if (raw.active !== undefined && parseBool(raw.active) !== undefined) {
      data.status = parseBool(raw.active) ? 'ACTIVE' : 'INACTIVE';
      fromFile.add('status');
    } else data.status = defaults.status;

    for (const flag of ['featured', 'bestSeller', 'flashSale']) {
      if (raw[flag] === undefined) continue;
      const b = parseBool(raw[flag]);
      if (b === undefined) { warnings.push(`Ignored ${flag} value "${raw[flag]}"`); fromFile.delete(flag); } else data[flag] = b;
    }

    if (data.slug && !SLUG_RE.test(data.slug)) errors.push({ field: 'slug', message: 'Slug may contain lowercase letters, numbers and hyphens' });
    if (!data.slug) need('slug', 'Title or slug is required');
    if (data.slug) {
      if (seenSlugs.has(data.slug)) errors.push({ field: 'slug', message: `Duplicate slug "${data.slug}" (also on row ${seenSlugs.get(data.slug)})` });
      else seenSlugs.set(data.slug, rowId);
    }

    return {
      row: rowId,
      data,
      fromFile,
      errors,
      warnings,
      preview: {
        title: data.title, slug: data.slug, category: cat.label, partner: partner.label, newCategory: Boolean(cat.created), newPartner: Boolean(partner.created),
        city: data.city, price: data.price, salePrice: data.salePrice, currency: data.currency || 'AED', status: data.status, image: data.imageUrls?.[0],
      },
    };
  };

  const rows = [];
  body.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based incl. header, matches spreadsheet row numbers
    const { raw, denominations } = readCells(cells, mapped);
    const variants = parseBool(raw.hasDenominations) ? denominations.filter((d) => d.price || d.value) : [];
    if (!variants.length) { rows.push(buildRow(raw, rowNumber)); return; }
    // Each denomination becomes its own product (the catalogue has no variant model).
    variants.forEach((d, k) => {
      const tag = d.label || [d.currency, d.value].filter(Boolean).join(' ') || `Option ${k + 1}`;
      rows.push(buildRow({
        ...raw,
        title: raw.title ? `${raw.title} - ${tag}` : raw.title,
        slug: `${raw.slug || raw.title || ''}-${slugify(tag)}`,
        price: undefined,
        salePrice: d.price ?? d.value,
        listPrice: d.oldPrice,
        currency: d.currency && /^[a-z]{3}$/i.test(d.currency) ? d.currency : raw.currency,
        imageUrls: d.img && URL_RE.test(d.img) ? [d.img, ...(raw.imageUrls || []).filter((u) => u !== d.img)] : raw.imageUrls,
      }, `${rowNumber}.${k + 1}`));
    });
  });
  if (rows.length > MAX_PRODUCTS) throw ApiError.badRequest(`This file expands to ${rows.length} products; import up to ${MAX_PRODUCTS} at a time`);

  // ---- existing products (by slug) decide create / update / skip, then schema validation ----
  const slugs = rows.map((r) => r.data.slug).filter(Boolean);
  const existing = new Map((await Product.find({ slug: { $in: slugs } }).select('_id slug').lean()).map((p) => [p.slug, p._id]));
  const placeholder = (id) => (String(id || '').startsWith('new:') ? '000000000000000000000000' : id);

  for (const r of rows) {
    const existingId = existing.get(r.data.slug);
    const isUpdate = Boolean(existingId) && mode === 'upsert';
    let candidate = r.data;
    let schema = importSchema;
    if (isUpdate) {
      // Only the columns present for this row are applied; the existing product keeps everything else.
      candidate = Object.fromEntries(Object.entries(r.data).filter(([k]) => r.fromFile.has(k)));
      delete candidate.slug;
      schema = importSchema.partial();
      r.errors = r.errors.filter((e) => !e.missing);
    }
    // Same rules as the product form. Placeholder ids stand in for categories/partners created on commit.
    const parsed = schema.safeParse({ ...candidate, categoryId: placeholder(candidate.categoryId), partnerId: placeholder(candidate.partnerId) });
    if (parsed.success) {
      r.data = { ...parsed.data };
      if (candidate.categoryId !== undefined) r.data.categoryId = candidate.categoryId; else delete r.data.categoryId;
      if (candidate.partnerId !== undefined) r.data.partnerId = candidate.partnerId; else delete r.data.partnerId;
    } else {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] || 'row');
        if ((field === 'categoryId' || field === 'partnerId') && r.errors.some((e) => e.field === field.replace('Id', ''))) continue;
        if (r.errors.some((e) => e.field === field)) continue;
        const label = FIELD[field]?.label || field;
        const where = issue.path.length > 1 ? ` (item ${Number(issue.path[1]) + 1})` : '';
        r.errors.push({ field, message: issue.message === 'Required' ? `${label} is required` : `${label}${where}: ${issue.message}` });
      }
    }

    if (r.errors.length) r.action = 'error';
    else if (!existingId) r.action = 'create';
    else if (isUpdate) {
      r.action = 'update';
      r.existingId = existingId;
      if (Object.keys(r.data).length === 0) { r.action = 'skip'; r.warnings.push('Nothing to update'); }
    } else {
      r.action = 'skip';
      r.warnings.push('A product with this slug already exists');
    }
    r.errors = r.errors.map(({ field, message }) => ({ field, message }));
  }

  // Only report new categories/partners that valid rows will actually use.
  const used = (prefix) => new Set(rows.filter((r) => r.action === 'create' || r.action === 'update')
    .map((r) => r.data[prefix]).filter((x) => String(x).startsWith('new:')).map((x) => x.slice(4)));
  const usedCats = used('categoryId');
  const usedPartners = used('partnerId');

  const count = (a) => rows.filter((r) => r.action === a).length;
  return {
    totalRows: body.length,
    totalProducts: rows.length,
    columns: { mapped: mapped.map(({ header, field, index }) => ({ header, field, index })), ignored, missing: missingColumns },
    summary: { create: count('create'), update: count('update'), skip: count('skip'), error: count('error') },
    newReferences: {
      categories: [...newCategories].filter(([k]) => usedCats.has(k)).map(([, n]) => n),
      partners: [...newPartners].filter(([k]) => usedPartners.has(k)).map(([, p]) => p.name),
    },
    rows,
    _new: { categories: newCategories, partners: newPartners },
    _defaults: defaults,
  };
}

/** Writes a plan. Row-level failures (e.g. a slug taken by a concurrent edit) are reported, not fatal. */
async function commitImport(plan, userId) {
  const actionable = plan.rows.filter((r) => r.action === 'create' || r.action === 'update');
  const used = (prefix) => new Set(actionable.map((r) => r.data[prefix]).filter((x) => String(x).startsWith('new:')).map((x) => x.slice(4)));
  const defaults = plan._defaults || {};

  // Create referenced categories / partners that do not exist yet (only those needed by valid rows).
  // A concurrent import may have created the same name a moment ago, so re-check by name first.
  const idFor = new Map();
  const usedCats = used('categoryId');
  for (const [key, name] of plan._new.categories) {
    if (!usedCats.has(key)) continue;
    // eslint-disable-next-line no-await-in-loop
    let doc = await Category.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
    if (!doc) {
      const base = slugify(name) || 'category';
      let slug = base;
      // eslint-disable-next-line no-await-in-loop
      for (let n = 2; await Category.exists({ slug }); n += 1) slug = `${base}-${n}`;
      // eslint-disable-next-line no-await-in-loop
      doc = await Category.create({ name, slug, status: 'ACTIVE', createdBy: userId });
    }
    idFor.set(`cat:${key}`, String(doc._id));
  }
  const usedPartners = used('partnerId');
  for (const [key, p] of plan._new.partners) {
    if (!usedPartners.has(key)) continue;
    // eslint-disable-next-line no-await-in-loop
    let doc = await Partner.findOne({ name: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
    if (!doc) {
      const city = p.city || defaults.city || 'Dubai';
      // eslint-disable-next-line no-await-in-loop
      doc = await Partner.create({
        name: p.name, city, country: p.country || defaults.country || 'United Arab Emirates', address: city, status: 'ACTIVE', createdBy: userId,
      });
    }
    idFor.set(`partner:${key}`, String(doc._id));
  }

  const results = { created: 0, updated: 0, failed: [] };
  const BATCH = 25;
  for (let i = 0; i < actionable.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(actionable.slice(i, i + BATCH).map(async (r) => {
      const data = { ...r.data };
      if (String(data.categoryId).startsWith('new:')) data.categoryId = idFor.get(`cat:${data.categoryId.slice(4)}`);
      if (String(data.partnerId).startsWith('new:')) data.partnerId = idFor.get(`partner:${data.partnerId.slice(4)}`);
      try {
        if (r.action === 'create') {
          await Product.create({ ...data, createdBy: userId });
          results.created += 1;
        } else {
          const doc = await Product.findById(r.existingId);
          if (!doc) throw new Error('Product was deleted during the import');
          doc.set(data);
          doc.updatedBy = userId;
          await doc.save();
          results.updated += 1;
        }
      } catch (err) {
        const message = err.code === 11000 ? 'A product with this slug already exists'
          : err.errors ? Object.values(err.errors).map((e) => e.message).join('; ') : err.message;
        results.failed.push({ row: r.row, title: r.data.title, message });
      }
    }));
  }
  results.createdReferences = {
    categories: [...plan._new.categories].filter(([k]) => idFor.has(`cat:${k}`)).map(([, n]) => n),
    partners: [...plan._new.partners].filter(([k]) => idFor.has(`partner:${k}`)).map(([, p]) => p.name),
  };
  return results;
}

/** Public shape of a plan for the API (drops internal fields). */
function publicPlan(plan) {
  const { _new, _defaults, rows, ...rest } = plan;
  return {
    ...rest,
    rows: rows.map(({ row, action, errors, warnings, preview }) => ({ row, action, errors, warnings, preview })),
  };
}

function templateCsv() {
  const headers = ['title', 'slug', 'description', 'category', 'brand', 'price', 'delPrice', 'status', 'proimg[0].src', 'proimg[1].src',
    'recommended', 'bestsellers', 'dealzone', 'five_start_rating', 'howToUse[0]', 'howToUse[1]', 'importantInstructions[0]',
    'termsConditions[0]', 'termsConditions[1]', 'whatsIncluded', 'whatsNotIncluded', 'packageDetails', 'legalNote',
    'hasDenominations', 'denominations[0].label', 'denominations[0].price', 'denominations[0].oldPrice', 'denominations[1].label', 'denominations[1].price', 'denominations[1].oldPrice'];
  const row = ['Sunset Desert Safari', 'sunset-desert-safari', 'Dune bashing, camel ride and BBQ dinner.\\n\\nA full evening in the desert with pick-up from your hotel.',
    'Adventure', 'Desert Tours LLC', '399', '450', 'True', 'https://example.com/safari-1.jpg', 'https://example.com/safari-2.jpg',
    'True', 'False', 'False', '4.6', '1. **Receive your voucher by email**', '2. **Book your date with the operator**', '**Voucher valid 12 months from purchase**',
    '**Validity** — voucher is valid for 12 months from the date of purchase.', '**No refunds after redemption**',
    'Hotel pick-up and drop-off\\nBBQ dinner\\nCamel ride', 'Quad biking\\nGratuity', 'Duration\\n6 hours\\nLocation\\nDubai desert', 'Subject to weather conditions.',
    'False', '', '', '', '', '', ''];
  return toCsv([headers, row]);
}

const fieldGuide = () => [
  ...FIELDS.filter((f) => f.key !== 'hasDenominations').map(({ key, label, required, help, array, list, aliases }) => ({ key, label, required: Boolean(required), help, array: Boolean(array || list), aliases })),
  {
    key: 'denominations', label: 'Denominations', required: false, array: false,
    help: 'With hasDenominations = TRUE, each denominations[n] (label, value, currency, price, oldPrice, img) becomes its own product, e.g. "Title - AED 100".',
    aliases: ['hasDenominations', 'denominations[n].label', 'denominations[n].price', 'denominations[n].oldPrice', 'denominations[n].currency', 'denominations[n].img'],
  },
];

module.exports = { planImport, commitImport, publicPlan, templateCsv, fieldGuide, MAX_ROWS };
