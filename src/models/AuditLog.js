const { Schema, model } = require('mongoose');
const { ref } = require('./_shared');

const auditLogSchema = new Schema({
  actorId: ref('User'),
  actorEmail: String,
  action: { type: String, required: true }, // e.g. products.create, auth.login.failed
  resource: String,
  resourceId: String,
  summary: { type: String, maxlength: 500 },
  changes: Schema.Types.Mixed,
  ip: String,
  userAgent: { type: String, maxlength: 400 },
  requestId: String,
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1 });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 3600 }); // ~13 months retention

module.exports = model('AuditLog', auditLogSchema, 'auditLogs');
