const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectId = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { escapeRegex, isObjectId, slugify, round2 };
