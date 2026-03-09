# Prontoweb Unified API

A unified REST API for Pronto Mowers services running on port 3001.

## 🚀 Quick Start

### Start the API

```bash
# Development
npm start

# Production with PM2
pm2 restart prontoweb-api
```

### Check Health

```bash
curl http://localhost:3001/health
```

## 📍 Available Endpoints

### 1. Parts Availability API

**Endpoint:** `POST /v1/parts/availability/resolve`

**Description:** Check parts availability across stores and locations

**Headers:**
```
x-api-key: your_api_key_here
Content-Type: application/json
```

**Request Body:**
```json
{
  "storeId": 5,
  "locationId": 4,
  "products": [
    {
      "brand": "BRIGGS & STRATTON",
      "sku": "BRIGGS 492932S"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "total": 1,
  "results": [
    {
      "success": true,
      "input": { "brand": "BRIGGS & STRATTON", "sku": "BRIGGS 492932S" },
      "match": { "mfridIdeal": 123, "partNumberIdeal": "492932S" },
      "inventory": { "onHand": 10, "available": 8 },
      "stockLevels": { "location1": 5, "location2": 3 }
    }
  ]
}
```

**Testing:**
```bash
node test-parts-availability.js
```

---

### 2. Returns Submission API

**Endpoint:** `POST /v1/returns/submit`

**Description:** Submit product return requests with images to Zoho Desk

**Headers:**
```
Content-Type: multipart/form-data
```

**Form Data:**
- `order_number` (string, required): Order number
- `part_number` (string, required): Part number being returned
- `customer_email` (string, required): Customer email
- `customer_name` (string, required): Customer name
- `return_reason` (string, required): Reason for return
- `is_last_30_days` (string): "y" or "n" - within 30 days?
- `is_original_pkg` (string): "y" or "n" - original packaging?
- `is_electronic` (string): "y" or "n" - electronic product?
- `images` (files, optional): Up to 10 images

**Response:**
```json
{
  "success": true,
  "id": 123,
  "zohoTicket": "12345"
}
```

**Example with cURL:**
```bash
curl -X POST http://localhost:3001/v1/returns/submit \
  -F "order_number=ORD123456" \
  -F "part_number=PART-001" \
  -F "customer_email=customer@example.com" \
  -F "customer_name=John Doe" \
  -F "return_reason=Defective" \
  -F "is_last_30_days=y" \
  -F "is_original_pkg=y" \
  -F "is_electronic=n" \
  -F "images=@image1.jpg" \
  -F "images=@image2.jpg"
```

---

## 🔧 Configuration

Configure in `.env` file:

```env
# Server
PORT=3001

# MySQL (for parts & returns)
MYSQL_HOST=10.1.10.21
MYSQL_PORT=3306
MYSQL_USER=pweb2
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=prontoweb

# PostgreSQL (for product matching)
PG_HOST=10.1.10.65
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=your_password
PG_DATABASE=prontoweb

# API Keys
PARTS_AVAILABILITY_API_KEY=your_secure_api_key_here

# Zoho Desk (for returns)
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_REFRESH_TOKEN=your_refresh_token
ZOHO_ORG_ID=your_org_id
ZOHO_DEPARTMENT_ID=your_department_id
```

## 📁 Project Structure

```
ideal-prontoweb/
├── server.js                      # Main API server
├── routes/
│   ├── partsAvailability.js      # Parts availability routes
│   └── returns.js                # Returns routes
├── controllers/
│   ├── partsAvailabilityController.js
│   └── returnsController.js
├── services/
│   ├── partsAvailabilityService.js
│   └── returnsService.js
├── middleware/
│   └── apiKeyAuth.js             # API key authentication
├── providers/
│   └── dbConnections.js          # Database connections
└── helpers/
    └── logger.js                 # Logging utility
```

## 🔒 Security

- Parts Availability API requires `x-api-key` header
- Returns API is open (protected by form validation)
- All requests logged for auditing
- File uploads limited to 10 images, 50MB total

## 🚀 Deployment with PM2

The API runs continuously in production using PM2:

```bash
# Start
pm2 start ecosystem.config.js --only prontoweb-api

# Restart
pm2 restart prontoweb-api

# Stop
pm2 stop prontoweb-api

# View logs
pm2 logs prontoweb-api

# Monitor
pm2 monit
```

## 📝 Adding New Endpoints

To add a new service:

1. Create route file: `routes/yourService.js`
2. Create controller: `controllers/yourServiceController.js`
3. Create service: `services/yourServiceService.js`
4. Add route to `server.js`:
   ```javascript
   const yourServiceRoutes = require('./routes/yourService');
   app.use('/', yourServiceRoutes);
   ```
5. Update health check endpoint list

## 🧪 Testing

```bash
# Test parts availability
node test-parts-availability.js

# Test with curl
curl http://localhost:3001/health
```

## 📊 Logs

Logs are stored in `logs/` directory:
- `server.log` - Main server logs
- `partsAvailabilityService.log` - Parts availability operations
- `returnsService.log` - Returns processing
- `returnsController.log` - Returns API requests

## 🌐 Production Access

In production, the API is accessible via:
- Internal: `http://localhost:3001`
- External: Through IIS reverse proxy (if configured)

---

**Maintained by:** Pronto Mowers IT Team  
**Last Updated:** March 2026
