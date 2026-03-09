// routes/partsAvailability.js
const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { resolvePartsAvailability } = require('../controllers/partsAvailabilityController');

// POST /v1/parts/availability/resolve
// Protected by API Key authentication
router.post('/v1/parts/availability/resolve', apiKeyAuth(), resolvePartsAvailability);

module.exports = router;
