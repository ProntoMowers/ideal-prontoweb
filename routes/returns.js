// routes/returns.js
const express = require('express');
const router = express.Router();
const returnsController = require('../controllers/returnsController');
const multer = require('multer');

// Configuración de Multer para recibir fotos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// POST /v1/returns/submit
router.post('/v1/returns/submit', upload.array('images', 10), returnsController.submitReturn);

// Legacy endpoint (backward compatibility)
router.post('/submit-return', upload.array('images', 10), returnsController.submitReturn);

module.exports = router;
