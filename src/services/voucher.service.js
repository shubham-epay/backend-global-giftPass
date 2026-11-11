const crypto = require('crypto');
const { Voucher } = require('../models');

// Unambiguous alphabet (no 0/O, 1/I/L). 12 chars from 31 symbols ≈ 59 bits of entropy.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateVoucherCode(prefix = 'GGP') {
  let body = '';
  for (let i = 0; i < 12; i += 1) body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** Creates a voucher, retrying on the (astronomically unlikely) code collision. */
async function createVoucherWithUniqueCode(data, session) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [voucher] = await Voucher.create([{ ...data, code: generateVoucherCode() }], { session });
      return voucher;
    } catch (err) {
      if (!(err.code === 11000 && err.keyPattern && err.keyPattern.code)) throw err;
    }
  }
  throw new Error('Could not generate a unique voucher code');
}

module.exports = { generateVoucherCode, createVoucherWithUniqueCode };
