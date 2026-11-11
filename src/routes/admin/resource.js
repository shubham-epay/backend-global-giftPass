const express = require('express');
const validate = require('../../middlewares/validate');
const { authorize } = require('../../middlewares/auth');
const { idParams, listQuery } = require('../../validators/common');

/**
 * Builds a standard REST router for a crud controller.
 * perms: { read: [..], create: [..], update: [..], delete: [..] }  (any-of semantics)
 */
function resourceRouter(ctrl, schemas, perms) {
  const r = express.Router();
  r.get('/', authorize(...perms.read), validate({ query: listQuery }), ctrl.list);
  r.get('/:id', authorize(...perms.read), validate({ params: idParams }), ctrl.getOne);
  r.post('/', authorize(...perms.create), validate({ body: schemas.create }), ctrl.create);
  r.patch('/:id', authorize(...perms.update), validate({ params: idParams, body: schemas.update }), ctrl.update);
  r.put('/:id', authorize(...perms.update), validate({ params: idParams, body: schemas.update }), ctrl.update);
  r.delete('/:id', authorize(...perms.delete), validate({ params: idParams }), ctrl.remove);
  return r;
}

module.exports = { resourceRouter };
