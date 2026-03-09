# Parts Availability API

API endpoint para resolver equivalencias de productos, consultar inventario y stock levels desde BigCommerce.

## Endpoint

```
POST /v1/parts/availability/resolve
```

## Autenticación

El endpoint requiere un API Key en el header de la petición:

```
x-api-key: <TU_API_KEY>
```

### Configuración

1. Copia `.env.example` a `.env`
2. Configura las credenciales de PostgreSQL y MySQL
3. Define tu API Key:
   ```
   PARTS_AVAILABILITY_API_KEY=tu_api_key_segura_aqui
   ```

## Request Body

```json
{
  "storeId": 5,
  "locationId": 4,
  "products": [
    {
      "brand": "BRIGGS & STRATTON",
      "sku": "BRIGGS 492932S"
    },
    {
      "brand": "BRIGGS & STRATTON",
      "mpn": "492932S"
    }
  ]
}
```

### Campos Requeridos

**Nivel request:**
- `storeId` (number): ID de la tienda
- `locationId` (number): ID de la ubicación/almacén
- `products` (array): Array con uno o más productos

**Nivel producto:**
- `brand` (string): Marca del producto (requerido)
- `sku` (string) O `mpn` (string): Al menos uno debe estar presente

## Response

### Éxito (200)

```json
{
  "success": true,
  "storeId": 5,
  "locationId": 4,
  "total": 2,
  "results": [
    {
      "input": {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S",
        "mpn": null
      },
      "match": {
        "strategy": "brandsandstores",
        "mfridIdeal": "BRS",
        "partNumberIdeal": "492932S"
      },
      "inventory": {
        "onHandAvailability": 3
      },
      "stockLevels": {
        "stockLevel1": 0,
        "stockLevel2": 0,
        "stockLevel3": 0,
        "stockLevel4": 0
      },
      "success": true,
      "error": null
    }
  ]
}
```

### Error de autenticación (401)

```json
{
  "success": false,
  "message": "Unauthorized"
}
```

### Error de validación (400)

```json
{
  "success": false,
  "message": "products[0]: either sku or mpn is required"
}
```

### Error interno (500)

```json
{
  "success": false,
  "message": "Internal server error"
}
```

## Lógica de Resolución

### Prioridad de búsqueda

1. **PostgreSQL `product_match`**: Busca coincidencias exactas primero
   - Busca por `brand` y `sku` (o `mpn`)
   - Si encuentra match, devuelve `mfr_ideal` y `partnumber_ideal`

2. **MySQL `brandsandstores` + `brands`**: Fallback si no hay match en PostgreSQL
   - Busca la marca en `brandsandstores` por `storeid` y `brandbc`
   - Obtiene `mfrid` y `brandprefijo`
   - Si es búsqueda por SKU: remueve el `brandprefijo` del SKU
   - Si es búsqueda por MPN: usa el MPN tal cual (sin remover prefijo)
   - Aplica sufijo desde tabla `brands` si existe

### Consultas de Inventario

**Tabla `productlocation`:**
- Suma todas las cantidades `ONHANDAVAILABLEQUANTITY` para el `MFRID`, `PARTNUMBER` y `LOCATIONID`

**Tabla `productstock`:**
- Obtiene los niveles de stock 1-4 para el `MFRID`, `PARTNUMBER` y `LOCATIONID`

## Instalación

```bash
npm install
```

## Ejecución

```bash
# Iniciar el servidor
npm start

# O en modo desarrollo
npm run dev
```

El servidor inicia en el puerto configurado (por defecto 3000):
```
🚀 Server is running on port 3000
📍 Health check: http://localhost:3000/health
📍 API endpoint: POST http://localhost:3000/v1/parts/availability/resolve
```

## Health Check

```bash
GET /health
```

Respuesta:
```json
{
  "success": true,
  "message": "Server is running",
  "timestamp": "2026-03-06T12:00:00.000Z"
}
```

## Ejemplo de uso con curl

```bash
curl -X POST http://localhost:3000/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: tu_api_key_aqui" \
  -d '{
    "storeId": 5,
    "locationId": 4,
    "products": [
      {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S"
      }
    ]
  }'
```

## Estructura del Proyecto

```
ideal-prontoweb/
├── server.js                                  # Punto de entrada de Express
├── middleware/
│   └── apiKeyAuth.js                         # Middleware de autenticación
├── controllers/
│   └── partsAvailabilityController.js        # Controlador del endpoint
├── services/
│   └── partsAvailabilityService.js           # Lógica de negocio
├── routes/
│   └── partsAvailability.js                  # Definición de rutas
├── providers/
│   └── dbConnections.js                      # Conexiones a bases de datos
└── helpers/
    └── logger.js                             # Sistema de logs
```

## Logs

Los logs se guardan en el directorio `logs/`:
- `server.log`: Logs del servidor
- `partsAvailabilityController.log`: Logs del controlador
- `partsAvailabilityService.log`: Logs del servicio

## Variables de Entorno Requeridas

```env
# PostgreSQL
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=your_pg_user
PG_PASSWORD=your_pg_password
PG_DATABASE=your_pg_database

# MySQL
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=your_user
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=prontoweb

# API Key
PARTS_AVAILABILITY_API_KEY=your_secure_api_key_here

# Server
PORT=3000
LOG_LEVEL=info
```

## Notas Importantes

1. **Batch Processing**: El endpoint procesa múltiples productos en un solo request
2. **Error Handling**: Si un producto falla, no afecta al resto del lote
3. **Strategy**: Cada resultado indica qué estrategia se usó (`product_match` o `brandsandstores`)
4. **SKU vs MPN**: 
   - SKU: remueve el prefijo de la marca si existe
   - MPN: usa el valor tal cual sin modificaciones
5. **Conexiones**: Usa pools de conexión para PostgreSQL y crea nuevas conexiones MySQL por request
