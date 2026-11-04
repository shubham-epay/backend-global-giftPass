const {
  z, objectId, optObjectId, optUrl, str, optStr, email, phone, slug,
} = require('./common');
const E = require('../constants/enums');
const { COUNTRIES } = require('../constants/countries');
const { EMAIL_RE, UAE_EMIRATES, normalizePhone } = require('../utils/contact');

// Customers get a friendlier (but still reasonable) password policy than admins.
const customerPassword = z.string()
  .min(8, 'At least 8 characters')
  .max(128, 'At most 128 characters')
  .regex(/[A-Za-z]/, 'Include a letter')
  .regex(/[0-9]/, 'Include a number');

// ---------- Auth ----------
const register = z.object({
  name: str(120), email, phone, password: customerPassword,
});
const login = z.object({
  email,
  password: z.string().min(1, 'Required').max(128),
  rememberMe: z.boolean().optional().default(false),
});
const changePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: customerPassword,
}).refine((d) => d.currentPassword !== d.newPassword, { path: ['newPassword'], message: 'New password must differ from the current one' });

// ---------- Profile & addresses ----------
const profileUpdate = z.object({
  name: str(120).optional(), phone, avatarUrl: optUrl,
});
const address = z.object({
  label: optStr(60), fullName: str(120), phone, line1: str(200), line2: optStr(200),
  city: str(80), state: optStr(80), country: str(80), postalCode: optStr(20),
  isDefault: z.boolean().optional(),
});
const addressUpdate = address.partial();

// ---------- Catalogue ----------
const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'popular', 'rating', 'title'];
// Visitor's country selection: ISO codes "AE,SA", or "global" / empty for all shown countries.
const countries = z.string().trim().max(400)
  .regex(/^(global|[A-Za-z]{2}(,[A-Za-z]{2})*)$/i, 'Use ISO country codes separated by commas, e.g. AE,SA')
  .optional();
const countryQuery = z.object({ countries });
const productListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(PRODUCT_SORTS).default('newest'),
  city: z.string().trim().max(80).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  featured: z.enum(['true', 'false']).optional(),
  bestSeller: z.enum(['true', 'false']).optional(),
  flashSale: z.enum(['true', 'false']).optional(),
  countries,
});
const searchQuery = productListQuery.extend({ q: z.string().trim().min(1, 'Enter a search term').max(100) });
const slugParams = z.object({ slug });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12), countries });
const bannerQuery = z.object({ placement: z.enum(['HOME_HERO', 'HOME_SECONDARY', 'CATEGORY']).optional() });

// ---------- Cart & wishlist ----------
const recipient = z.object({
  name: optStr(120),
  email: z.preprocess((v) => (v === '' ? null : v), email.nullable()).optional(),
  phone,
}).optional();

const cartAdd = z.object({
  itemType: z.enum(E.ITEM_TYPES).default('PRODUCT'),
  productId: optObjectId,
  giftBoxId: optObjectId,
  quantity: z.number().int().min(1).max(100).default(1),
  // Required for open-amount products (e.g. a 50–5,000 gift card): the chosen value.
  amount: z.number().positive().max(1_000_000).optional(),
  recipient,
  message: optStr(1000),
}).superRefine((d, ctx) => {
  if (d.itemType === 'PRODUCT' && !d.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Required' });
  if (d.itemType === 'GIFT_BOX' && !d.giftBoxId) ctx.addIssue({ code: 'custom', path: ['giftBoxId'], message: 'Required' });
});
const cartUpdate = z.object({
  quantity: z.number().int().min(1).max(100).optional(),
  recipient,
  message: optStr(1000),
});
const itemIdParams = z.object({ itemId: objectId });
const wishlistAdd = z.object({ productId: objectId });
const productIdParams = z.object({ productId: objectId });

// ---------- Checkout & orders ----------
const applyCoupon = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Enter a valid coupon code'),
});
const ISO_CODES = new Set(COUNTRIES.map((c) => c.code));
const checkoutEmail = z.string().trim().toLowerCase().max(254).regex(EMAIL_RE, 'Enter a valid email address');
const addressFields = {
  country: z.string().trim().toUpperCase().refine((c) => ISO_CODES.has(c), 'Choose a country'),
  firstName: str(60),
  lastName: str(60),
  address: str(200),
  apartment: optStr(200),
  city: str(80),
  state: optStr(80),
  postalCode: optStr(20),
};
/** UAE addresses need one of the seven emirates. */
const checkEmirate = (a, ctx, path) => {
  if (a.country === 'AE' && !UAE_EMIRATES.includes(a.state)) {
    ctx.addIssue({ code: 'custom', path: [...path, 'state'], message: 'Choose an emirate' });
  }
};

/**
 * Guest or signed-in checkout. The phone must be a valid number for the delivery country and is stored
 * in E.164 (e.g. +971501234567). Card details are never sent here: payment happens with the provider.
 */
const checkout = z.object({
  email: checkoutEmail,
  ...addressFields,
  phone: z.string().trim().min(4, 'Enter a phone number').max(30),
  saveInfo: z.boolean().optional().default(false),
  paymentMethod: z.enum(E.PAYMENT_METHODS).default('CARD'),
  paymentEnvironment: z.enum(E.PAYMENT_ENVIRONMENTS).optional(), // SynraPay sandbox | dev; the configured default when omitted
  paymentLinkType: z.enum(E.PAYMENT_LINK_TYPES).optional(),
  directCaptureMode: z.enum(E.DIRECT_CAPTURE_MODES).optional(),
  paymentLinkExpiresInHours: z.number().int().min(24).max(720).optional(),
  billingSameAsShipping: z.boolean().optional().default(true),
  billing: z.object(addressFields).optional(),
  couponCode: z.preprocess((v) => (v === '' ? null : v),
    z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Enter a valid coupon code').nullable()).optional(),
  senderName: optStr(120),
}).superRefine((d, ctx) => {
  checkEmirate(d, ctx, []);
  const phone = normalizePhone(d.phone, d.country);
  if (!phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a valid phone number for the selected country' });
  else d.phone = phone;
  if (!d.billingSameAsShipping) {
    if (!d.billing) ctx.addIssue({ code: 'custom', path: ['billing'], message: 'Enter a billing address' });
    else checkEmirate(d.billing, ctx, ['billing']);
  }
});
const orderNumberParams = z.object({
  orderNumber: z.string().trim().toUpperCase().regex(/^GGP-\d{6}-[A-Z0-9]{6}$/, 'Invalid order number'),
});
const paymentStart = z.object({
  method: z.enum(['CARD', 'HOSTED_SESSION', 'PAY_BY_LINK', 'DIRECT_CARD']),
  environment: z.enum(E.PAYMENT_ENVIRONMENTS).optional(),
  linkType: z.enum(E.PAYMENT_LINK_TYPES).optional(),
  captureMode: z.enum(E.DIRECT_CAPTURE_MODES).optional(),
  expiresInHours: z.number().int().min(24).max(720).optional(),
}).strict();
/** Luhn checksum: catches mistyped card numbers before they reach the payment provider. */
const luhnOk = (digits) => {
  let sum = 0;
  for (let i = digits.length - 1, alt = false; i >= 0; i -= 1, alt = !alt) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
};
/**
 * Direct API card. Spaces and dashes in the number are removed. Error messages never echo the values.
 * strict(): unknown fields are refused so nothing unexpected rides along with card data.
 */
const directCard = z.object({
  number: z.string().transform((v) => v.replace(/[\s-]/g, '')).pipe(
    z.string().refine((v) => /^\d{12,19}$/.test(v) && luhnOk(v), 'Enter a valid card number')),
  expiry_month: z.string().trim().regex(/^(0?[1-9]|1[0-2])$/, 'Enter a valid month').transform((v) => v.padStart(2, '0')),
  expiry_year: z.string().trim().regex(/^(\d{2}|20\d{2})$/, 'Enter a valid year').transform((v) => v.slice(-2)),
  cvv: z.string().trim().regex(/^\d{3,4}$/, 'Enter the 3 or 4 digit security code'),
  name: z.string().trim().regex(/^[\p{L} .'-]{2,100}$/u, 'Enter the name as shown on the card').optional(),
}).strict().superRefine((c, ctx) => {
  const now = new Date();
  const year = 2000 + Number(c.expiry_year);
  if (year < now.getFullYear() || (year === now.getFullYear() && Number(c.expiry_month) < now.getMonth() + 1)) {
    ctx.addIssue({ code: 'custom', path: ['expiry_month'], message: 'This card has expired' });
  }
});
// A saved card's payment_method_id (PM_...): an opaque reference, never card data.
const paymentMethodId = z.string().trim().min(1).max(100);
const browserDetails = z.object({
  acceptHeaders: z.string().trim().min(1).max(4096),
  colorDepth: z.number().int().min(1).max(48),
  javaEnabled: z.boolean(),
  language: z.string().trim().min(1).max(35),
  screenHeight: z.number().int().min(1).max(10000),
  screenWidth: z.number().int().min(1).max(10000),
  timeZone: z.number().int().min(-840).max(840),
}).strict();
/** Exactly one of `card` (typed in) or `paymentMethodId` (saved card). saveCard: the shopper agreed to keep the typed card. */
const paymentDirectPay = z.object({
  card: directCard.optional(),
  paymentMethodId: paymentMethodId.optional(),
  saveCard: z.boolean().optional(),
  browser_details: browserDetails,
}).strict().superRefine((d, ctx) => {
  if (Boolean(d.card) === Boolean(d.paymentMethodId)) {
    ctx.addIssue({ code: 'custom', path: [d.card ? 'paymentMethodId' : 'card'], message: 'Send either card details or a saved card, not both' });
  }
});
const paymentMethodParams = z.object({ paymentMethodId });
// The environment the saved card is in (each SynraPay account keeps its own cards).
const paymentMethodQuery = z.object({ environment: z.enum(E.PAYMENT_ENVIRONMENTS).optional() });
const paymentDirectAuthenticate = z.object({}).strict();

const paymentSendLink = z.object({ email: checkoutEmail.optional() }).strict();

const orderListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: z.enum(E.ORDER_STATUS).optional(),
});
const voucherListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(E.VOUCHER_STATUS).optional(),
  type: z.enum(['all', 'purchased', 'received']).default('all'),
});

module.exports = {
  register, login, changePassword, profileUpdate, address, addressUpdate,
  productListQuery, searchQuery, slugParams, limitQuery, bannerQuery, countryQuery,
  cartAdd, cartUpdate, itemIdParams, wishlistAdd, productIdParams,
  applyCoupon, checkout, orderListQuery, voucherListQuery, orderNumberParams, paymentStart, paymentSendLink, paymentDirectPay, paymentDirectAuthenticate, paymentMethodParams, paymentMethodQuery,
};
