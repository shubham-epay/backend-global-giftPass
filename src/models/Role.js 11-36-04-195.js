const { Schema, model } = require('mongoose');
const { ALL_PERMISSIONS, SUPER } = require('../constants/permissions');

const roleSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 300 },
  permissions: {
    type: [{ type: String, enum: [...ALL_PERMISSIONS, SUPER] }],
    default: [],
    validate: { validator: (v) => new Set(v).size === v.length, message: 'Duplicate permissions' },
  },
  isSystem: { type: Boolean, default: false }, // system roles cannot be edited or deleted
}, { timestamps: true });

roleSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = model('Role', roleSchema);
