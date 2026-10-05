const { Country } = require('../models');

// Active countries change rarely; cache the list briefly to avoid a query on every catalogue request.
const TTL_MS = 30 * 1000;
let cache = { at: 0, items: [] };

async function activeCountries() {
  if (Date.now() - cache.at < TTL_MS) return cache.items;
  const items = await Country.find({ status: 'ACTIVE' }).select('name code flag currency sortOrder').sort({ sortOrder: 1, name: 1 }).lean();
  cache = { at: Date.now(), items };
  return items;
}
const invalidateCountryCache = () => { cache = { at: 0, items: [] }; };

/**
 * Mongo filter for the products a visitor may see.
 *  - Products with no countries are sold everywhere and always match.
 *  - `codes` = the visitor's selection (ISO codes). Empty / "global" = every ACTIVE country.
 *  - Products sold only in hidden (INACTIVE) countries never match.
 */
async function countryScope(codes) {
  const active = await activeCountries();
  const wanted = String(codes || '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => c && c !== 'GLOBAL');
  const ids = (wanted.length ? active.filter((c) => wanted.includes(c.code)) : active).map((c) => c._id);
  return { $or: [{ countries: { $exists: false } }, { countries: { $size: 0 } }, { countries: { $in: ids } }] };
}

module.exports = { activeCountries, countryScope, invalidateCountryCache };
