/**
 * Single source of truth for admin permissions.
 * '*' is reserved for the system Super Admin role.
 */
const PERMISSION_GROUPS = [
  { group: 'Dashboard', permissions: [{ key: 'dashboard.read', label: 'View dashboard' }] },
  { group: 'Products', permissions: [
    { key: 'products.read', label: 'View products' },
    { key: 'products.create', label: 'Create products' },
    { key: 'products.update', label: 'Edit products' },
    { key: 'products.delete', label: 'Delete products' },
  ] },
  { group: 'Catalogue', permissions: [
    { key: 'categories.manage', label: 'Manage categories' },
    { key: 'partners.manage', label: 'Manage partners' },
    { key: 'giftBoxes.manage', label: 'Manage gift boxes' },
  ] },
  { group: 'Coupons', permissions: [
    { key: 'coupons.read', label: 'View coupons' },
    { key: 'coupons.create', label: 'Create coupons' },
    { key: 'coupons.update', label: 'Edit coupons' },
    { key: 'coupons.delete', label: 'Delete coupons' },
  ] },
  { group: 'Orders', permissions: [
    { key: 'orders.read', label: 'View orders' },
    { key: 'orders.updateStatus', label: 'Change order status' },
  ] },
  { group: 'Vouchers', permissions: [
    { key: 'vouchers.read', label: 'View vouchers' },
    { key: 'vouchers.create', label: 'Issue vouchers' },
    { key: 'vouchers.update', label: 'Edit or cancel vouchers' },
  ] },
  { group: 'Content', permissions: [{ key: 'cms.manage', label: 'Manage banners, collections, blogs and FAQs' }] },
  { group: 'Administration', permissions: [
    { key: 'users.manage', label: 'Manage users' },
    { key: 'roles.manage', label: 'Manage roles' },
    { key: 'auditLogs.read', label: 'View audit log' },
  ] },
];

const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
const SUPER = '*';

module.exports = { PERMISSION_GROUPS, ALL_PERMISSIONS, SUPER };
