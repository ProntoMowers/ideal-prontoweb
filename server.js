// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const partsAvailabilityRoutes = require('./routes/partsAvailability');
const returnsRoutes = require('./routes/returns');
const logger = require('./helpers/logger')('server.log');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /health',
      'POST /v1/parts/availability/resolve',
      'POST /v1/returns/submit'
    ]
  });
});

// API Routes
app.use('/', partsAvailabilityRoutes);
app.use('/', returnsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Parts Availability: POST http://localhost:${PORT}/v1/parts/availability/resolve`);
  console.log(`📍 Submit Return: POST http://localhost:${PORT}/v1/returns/submit`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
