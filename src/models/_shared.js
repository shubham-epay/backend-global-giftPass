const { Schema } = require('mongoose');

const URL_RE = /^https?:\/\/[^\s]+$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const urlField = (opts = {}) => ({ type: String, trim: true, maxlength: 2048, match: [URL_RE, 'Must be a valid http(s) URL'], ...opts });
const urlArray = () => ({ type: [urlField()], default: [] });
const slugField = () => ({ type: String, required: true, trim: true, lowercase: true, maxlength: 140, match: [SLUG_RE, 'Slug may contain lowercase letters, numbers and hyphens'] });
const money = (opts = {}) => ({ type: Number, min: 0, set: (v) => (v == null ? v : Math.round(Number(v) * 100) / 100), ...opts });
const ref = (model, opts = {}) => ({ type: Schema.Types.ObjectId, ref: model, ...opts });

const addressSchema = new Schema({
  label: { type: String, trim: true, maxlength: 60 },
  fullName: { type: String, trim: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 30 },
  line1: { type: String, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200 },
  city: { type: String, trim: true, maxlength: 80 },
  state: { type: String, trim: true, maxlength: 80 },
  country: { type: String, trim: true, maxlength: 80 },
  postalCode: { type: String, trim: true, maxlength: 20 },
  isDefault: { type: Boolean, default: false },
}, { _id: true, timestamps: false });

const seoFields = {
  seoTitle: { type: String, trim: true, maxlength: 70 },
  seoDescription: { type: String, trim: true, maxlength: 170 },
};

module.exports = { URL_RE, SLUG_RE, urlField, urlArray, slugField, money, ref, addressSchema, seoFields };
