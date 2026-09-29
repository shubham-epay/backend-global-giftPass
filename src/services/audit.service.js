const { AuditLog } = require('../models');

const REDACT = new Set(['password', 'passwordHash', 'newPassword', 'currentPassword', 'token', 'refreshToken']);

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && !(value instanceof Date) && !value._bsontype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.has(k) ? '[REDACTED]' : redact(v, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** Fire-and-forget audit entry. Never blocks or fails the request. */
function audit(req, { action, resource, resourceId, summary, changes, actor }) {
  const who = actor || req.user;
  AuditLog.create({
    actorId: who?._id,
    actorEmail: who?.email,
    action,
    resource,
    resourceId: resourceId ? String(resourceId) : undefined,
    summary,
    changes: changes ? redact(changes) : undefined,
    ip: req.ip,
    userAgent: (req.get('user-agent') || '').slice(0, 400),
    requestId: req.id,
  }).catch((err) => console.error('[audit] failed to write audit log:', err.message));
}

/** Builds a {path: {from, to}} diff for top-level modified paths. */
function diff(before, doc) {
  const out = {};
  for (const path of doc.modifiedPaths()) {
    if (path.includes('.') || path === 'updatedAt' || path === 'updatedBy') continue;
    out[path] = { from: before[path], to: doc.get(path) };
  }
  return out;
}

module.exports = { audit, diff };
