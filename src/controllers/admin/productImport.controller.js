const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { hasPermission } = require('../../middlewares/auth');
const { audit } = require('../../services/audit.service');
const {
  planImport, commitImport, publicPlan, templateCsv, fieldGuide, MAX_ROWS,
} = require('../../services/productImport.service');

/**
 * POST /api/admin/products/import?dryRun=true|false&mode=create|upsert&...defaults
 * Body: the raw CSV file (Content-Type: text/csv).
 * dryRun=true validates and returns the plan without writing anything.
 */
const importProducts = asyncHandler(async (req, res) => {
  const { dryRun, mode, createMissing, ...defaults } = req.query;
  if (typeof req.body !== 'string' || !req.body.trim()) {
    throw ApiError.badRequest('Upload a CSV file (Content-Type: text/csv)');
  }
  if (mode === 'upsert' && !hasPermission(req.user.permissions, 'products.update')) {
    throw ApiError.forbidden('Updating existing products needs the "Edit products" permission');
  }

  const plan = await planImport(req.body, { mode, createMissing, defaults });
  if (dryRun) return res.json({ success: true, data: { dryRun: true, mode, ...publicPlan(plan) } });

  if (plan.summary.create + plan.summary.update === 0) {
    throw new ApiError(422, 'NOTHING_TO_IMPORT', 'No valid rows to import. Fix the errors and try again.');
  }
  const result = await commitImport(plan, req.user._id);
  audit(req, {
    action: 'products.import', resource: 'products',
    summary: `CSV import: ${result.created} created, ${result.updated} updated, ${plan.summary.skip} skipped, ${plan.summary.error + result.failed.length} failed`,
    changes: { rows: { from: null, to: plan.totalRows }, mode: { from: null, to: mode } },
  });
  return res.status(201).json({ success: true, data: { dryRun: false, mode, ...publicPlan(plan), result } });
});

const template = (_req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="products-import-template.csv"');
  res.send(`﻿${templateCsv()}`);
};

const fields = (_req, res) => res.json({ success: true, data: { fields: fieldGuide(), maxRows: MAX_ROWS } });

module.exports = { importProducts, template, fields };
