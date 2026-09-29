const { Schema, model } = require('mongoose');
const { ref } = require('./_shared');

/**
 * Only the SHA-256 hash of a refresh token is stored. Tokens rotate on every use;
 * all tokens from one login share a familyId so a reused (stolen) token revokes the whole chain.
 */
const refreshTokenSchema = new Schema({
  userId: ref('User', { required: true }),
  tokenHash: { type: String, required: true },
  familyId: { type: String, required: true },
  rememberMe: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  revokedReason: { type: String, enum: ['ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'ADMIN_ACTION'] },
  createdByIp: String,
  userAgent: { type: String, maxlength: 400 },
}, { timestamps: true });

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }); // purge a week after expiry

module.exports = model('RefreshToken', refreshTokenSchema, 'refreshTokens');
