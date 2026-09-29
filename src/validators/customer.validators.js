const {
  z, objectId, optObjectId, optUrl, str, optStr, email, phone, slug,
} = require('./common');
const E = require('../constants/enums');

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
});
const searchQuery = productListQuery.extend({ q: z.string().trim().min(1, 'Enter a search term').max(100) });
const slugParams = z.object({ slug });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) });
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
const checkout = z.object({
  deliveryMethod: z.enum(['EMAIL', 'SMS', 'PHYSICAL']).default('EMAIL'),
  billingAddressId: optObjectId,
  shippingAddressId: optObjectId,
  couponCode: z.preprocess((v) => (v === '' ? null : v),
    z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Enter a valid coupon code').nullable()).optional(),
  senderName: optStr(120),
}).superRefine((d, ctx) => {
  if (d.deliveryMethod === 'PHYSICAL' && !d.shippingAddressId) {
    ctx.addIssue({ code: 'custom', path: ['shippingAddressId'], message: 'A shipping address is required for physical delivery' });
  }
});
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
  productListQuery, searchQuery, slugParams, limitQuery, bannerQuery,
  cartAdd, cartUpdate, itemIdParams, wishlistAdd, productIdParams,
  applyCoupon, checkout, orderListQuery, voucherListQuery,
};
