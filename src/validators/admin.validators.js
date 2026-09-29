const {
  z, objectId, optObjectId, objectIdArray, url, optUrl, urlArray, str, optStr, email, optEmail, phone, slug,
  money, optMoney, int, optInt, date, optDate, password,
} = require('./common');
const E = require('../constants/enums');
const { ALL_PERMISSIONS, SUPER } = require('../constants/permissions');

// ---------- Auth ----------
const login = z.object({
  email,
  password: z.string().min(1, 'Required').max(128),
  rememberMe: z.boolean().optional().default(false),
});
const changePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
}).refine((d) => d.currentPassword !== d.newPassword, { path: ['newPassword'], message: 'New password must differ from the current one' });

// ---------- Users & roles ----------
const userCreate = z.object({
  name: str(120), email, phone, password,
  roleId: objectId,
  status: z.enum(E.USER_STATUS).default('ACTIVE'),
});
const userUpdate = z.object({
  name: str(120).optional(), phone,
  roleId: objectId.optional(),
  status: z.enum(E.USER_STATUS).optional(),
});
const resetPassword = z.object({ newPassword: password });

const roleCreate = z.object({
  name: str(60),
  description: optStr(300),
  permissions: z.array(z.enum([...ALL_PERMISSIONS, SUPER])).max(100).default([]),
});
const roleUpdate = roleCreate.partial();

// ---------- Catalogue ----------
const categoryCreate = z.object({
  name: str(120), slug, status: z.enum(E.PUBLISH_STATUS),
  description: optStr(2000), iconUrl: optUrl, bannerUrl: optUrl, parentCategoryId: optObjectId,
  sortOrder: optInt(-100000, 100000), seoTitle: optStr(70), seoDescription: optStr(170),
});

const partnerCreate = z.object({
  name: str(160), city: str(80), country: str(80), address: str(400), status: z.enum(E.PUBLISH_STATUS),
  website: optUrl, email: optEmail, phone, logoUrl: optUrl, coverImageUrl: optUrl,
  galleryUrls: urlArray.optional(), workingHours: optStr(500), description: optStr(5000),
});

const textList = (max, count) => z.array(z.string().trim().min(1).max(max)).max(count).optional();
const productCreate = z.object({
  title: str(200), slug, categoryId: objectId, partnerId: objectId, city: str(80), country: str(80),
  price: money, salePrice: money, duration: str(60), validityDays: int(1, 3650),
  imageUrls: z.array(url).min(1, 'Add at least one image URL').max(20), status: z.enum(E.PRODUCT_STATUS),
  galleryUrls: urlArray.optional(), featured: z.boolean().optional(), bestSeller: z.boolean().optional(),
  flashSale: z.boolean().optional(), peopleCount: optInt(1, 100), shortDescription: optStr(500),
  description: optStr(20000), termsConditions: optStr(20000), supplierReference: optStr(120),
  whatsIncluded: textList(500, 50), whatsNotIncluded: textList(500, 50),
  howToUse: textList(2000, 30), importantInstructions: textList(2000, 30),
  packageDetails: z.array(z.object({ label: str(80), value: z.string().trim().max(300).default('') })).max(30).optional(),
  legalNote: optStr(3000),
  apiDeliveryId: optStr(120), seoTitle: optStr(70), seoDescription: optStr(170),
});

const flag = (def) => z.enum(['true', 'false']).default(def).transform((x) => x === 'true');
const productImportQuery = z.object({
  dryRun: flag('true'),
  mode: z.enum(['create', 'upsert']).default('create'),
  createMissing: flag('false'),
  categoryId: optObjectId, partnerId: optObjectId,
  city: optStr(80), country: optStr(80), duration: optStr(60), fallbackPartner: optStr(160),
  validityDays: z.preprocess((x) => (x === '' ? undefined : x), z.coerce.number().int().min(1).max(3650).optional()),
  status: z.enum(E.PRODUCT_STATUS).default('DRAFT'),
});

const giftBoxCreate = z.object({
  name: str(160), price: money, coverImageUrl: url,
  productIds: objectIdArray.min(1, 'Add at least one product'), validityDays: int(1, 3650),
  description: optStr(5000), salePrice: optMoney, status: z.enum(E.PUBLISH_STATUS).optional(),
});

const couponCreate = z.object({
  title: str(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, '3-40 characters: A-Z, 0-9, _ or -'),
  discountType: z.enum(E.DISCOUNT_TYPES), discountValue: z.number().positive().max(10_000_000),
  validFrom: date, validTill: date, status: z.enum(E.PUBLISH_STATUS),
  minimumOrderValue: optMoney, maximumDiscount: optMoney, usageLimit: optInt(1, 10_000_000),
  usagePerUser: optInt(1, 1000), applicableCategories: objectIdArray.optional(),
  applicableProducts: objectIdArray.optional(),
  applicableCities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  description: optStr(1000),
});

// ---------- Orders & vouchers ----------
const orderStatusUpdate = z.object({
  orderStatus: z.enum(E.ORDER_STATUS),
  trackingNumber: optStr(120),
  notes: optStr(2000),
});

const voucherCreate = z.object({
  orderId: objectId, recipientName: str(120), recipientEmail: email, senderName: str(120), expiryDate: date,
  recipientPhone: phone, message: optStr(1000), giftBoxId: optObjectId,
  orderItemId: optObjectId, productId: optObjectId, value: optMoney,
});
const voucherUpdate = z.object({
  recipientName: str(120).optional(), recipientEmail: email.optional(), recipientPhone: phone,
  senderName: str(120).optional(), message: optStr(1000), expiryDate: date.optional(),
});
const voucherStatusUpdate = z.object({
  status: z.enum(E.VOUCHER_STATUS),
  reason: optStr(500),
  expiryDate: optDate,
  redeemedAtPartnerId: optObjectId,
  exchangedToVoucherId: optObjectId,
});

// ---------- CMS ----------
// Empty / null means "not set" (keeps the stored value or the model default).
const unset = (schema) => z.preprocess((x) => (x === '' || x === null ? undefined : x), schema);
const bannerCreate = z.object({
  title: str(160), imageUrl: url, status: z.enum(E.PUBLISH_STATUS),
  subtitle: optStr(300), buttonText: optStr(40),
  buttonLink: z.preprocess((v) => (v === '' ? null : v),
    z.string().trim().max(2048).regex(/^(https?:\/\/|\/)\S*$/i, 'Use an http(s) URL or a path starting with /').nullable()).optional(),
  mobileImageUrl: optUrl, imageAlt: optStr(160), startDate: optDate, endDate: optDate,
  placement: z.enum(E.BANNER_PLACEMENTS).optional(), sortOrder: optInt(-100000, 100000),
  textPosition: unset(z.enum(E.BANNER_TEXT_POSITIONS).optional()),
  textTheme: unset(z.enum(E.BANNER_TEXT_THEMES).optional()),
  buttonColor: unset(z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Use a hex colour such as #E0435A').optional()),
  openInNewTab: z.boolean().optional(),
});
const collectionCreate = z.object({
  title: str(160), slug, description: optStr(2000), imageUrl: optUrl,
  productIds: objectIdArray.optional(), status: z.enum(E.PUBLISH_STATUS).optional(),
  showOnHome: z.boolean().optional(), sortOrder: optInt(-100000, 100000),
});
const blogCreate = z.object({
  title: str(200), slug, content: str(100000), excerpt: optStr(500), coverImageUrl: optUrl,
  authorName: optStr(120), tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).optional(),
  status: z.enum(E.BLOG_STATUS).optional(), seoTitle: optStr(70), seoDescription: optStr(170),
});
const faqCreate = z.object({
  question: str(300), answer: str(5000), group: optStr(60), sortOrder: optInt(-100000, 100000),
  status: z.enum(E.PUBLISH_STATUS).optional(),
});

const withUpdate = (schema) => ({ create: schema, update: schema.partial() });

module.exports = {
  login, changePassword, userCreate, userUpdate, resetPassword, roleCreate, roleUpdate,
  category: withUpdate(categoryCreate), partner: withUpdate(partnerCreate), product: withUpdate(productCreate),
  giftBox: withUpdate(giftBoxCreate), coupon: withUpdate(couponCreate),
  banner: withUpdate(bannerCreate), collection: withUpdate(collectionCreate),
  blog: withUpdate(blogCreate), faq: withUpdate(faqCreate),
  productImportQuery, orderStatusUpdate, voucherCreate, voucherUpdate, voucherStatusUpdate,
};
