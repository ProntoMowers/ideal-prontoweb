const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { resolveReverseParts } = require('../controllers/partsReverseLookupController');

// POST /v1/parts/reverse/resolve
// Protected by API Key authentication
router.post('/v1/parts/reverse/resolve', apiKeyAuth(), resolveReverseParts);

module.exports = router;
