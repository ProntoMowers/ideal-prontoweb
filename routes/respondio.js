const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { upsertContact, upsertBulkContacts } = require('../controllers/respondioController');

// POST /v1/respondio/contact/upsert
// Protected by API Key authentication (header: x-api-key)
// Env var required: RESPONDIO_CONTACT_API_KEY
router.post('/v1/respondio/contact/upsert', apiKeyAuth('RESPONDIO_CONTACT_API_KEY'), upsertContact);

// POST /v1/respondio/contact/upsert/bulk
// Procesa hasta 500 contactos con concurrencia 3 y retry automático en 429/5xx
// Env var required: RESPONDIO_CONTACT_API_KEY
router.post('/v1/respondio/contact/upsert/bulk', apiKeyAuth('RESPONDIO_CONTACT_API_KEY'), upsertBulkContacts);

module.exports = router;
