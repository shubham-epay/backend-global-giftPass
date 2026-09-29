const { z } = require('zod');
const { SLUG_RE } = require('../models/_shared');

const emptyToNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const optObjectId = emptyToNull(objectId.nullable()).optional();
const objectIdArray = z.array(objectId).max(500);

const url = z.string().trim().max(2048).regex(/^https?:\/\/\S+$/i, 'Must be a valid http(s) URL');
const optUrl = emptyToNull(url.nullable()).optional();
const urlArray = z.array(url).max(30);

const str = (max, min = 1) => z.string().trim().min(min, 'Required').max(max);
const optStr = (max) => emptyToNull(z.string().trim().max(max).nullable()).optional();
const email = z.string().trim().toLowerCase().email('Invalid email').max(254);
const optEmail = emptyToNull(email.nullable()).optional();
const phone = emptyToNull(z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, 'Invalid phone number').nullable()).optional();
const slug = z.string().trim().toLowerCase().max(140).regex(SLUG_RE, 'Use lowercase letters, numbers and hyphens');
const money = z.number({ invalid_type_error: 'Must be a number' }).min(0).max(10_000_000);
const optMoney = emptyToNull(money.nullable()).optional();
const int = (min, max) => z.number().int().min(min).max(max);
const optInt = (min, max) => emptyToNull(int(min, max).nullable()).optional();
const date = z.coerce.date({ invalid_type_error: 'Invalid date' });
const optDate = emptyToNull(z.union([z.null(), z.coerce.date()])).optional();

const idParams = z.object({ id: objectId });

const password = z.string()
  .min(12, 'At least 12 characters')
  .max(128, 'At most 128 characters')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number')
  .regex(/[^A-Za-z0-9]/, 'Include a symbol');

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().regex(/^-?[a-zA-Z_.]{1,40}$/).optional(),
  q: z.string().trim().max(100).optional(),
  ids: z.string().max(25 * 110).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
}).catchall(z.string().max(100));

module.exports = {
  z, emptyToNull, objectId, optObjectId, objectIdArray, url, optUrl, urlArray, str, optStr, email, optEmail,
  phone, slug, money, optMoney, int, optInt, date, optDate, idParams, password, listQuery,
};
