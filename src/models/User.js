const { Schema, model } = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_TYPES, USER_STATUS } = require('../constants/enums');
const { urlField, ref, addressSchema } = require('./_shared');

const BCRYPT_ROUNDS = 12;

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'] },
  phone: { type: String, trim: true, maxlength: 30 },
  type: { type: String, enum: USER_TYPES, required: true },
  roleId: ref('Role', { required: function requiredForAdmin() { return this.type === 'ADMIN'; } }),
  status: { type: String, enum: USER_STATUS, default: 'ACTIVE' },
  avatarUrl: urlField(),
  addresses: { type: [addressSchema], default: [] },

  passwordHash: { type: String, required: true, select: false },
  passwordChangedAt: { type: Date, select: false },
  // Incremented to invalidate every outstanding access token for this user.
  tokenVersion: { type: Number, default: 0, select: false },
  failedLoginAttempts: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false },
  lastLoginAt: Date,
  lastLoginIp: { type: String, select: false },
  createdBy: ref('User'),
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ type: 1, status: 1, createdAt: -1 });
userSchema.index({ roleId: 1 });

userSchema.statics.hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};
userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil > new Date());
};

userSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.passwordHash; delete ret.tokenVersion; delete ret.failedLoginAttempts;
    delete ret.lockUntil; delete ret.lastLoginIp; delete ret.passwordChangedAt; delete ret.id;
    return ret;
  },
});

module.exports = model('User', userSchema);
