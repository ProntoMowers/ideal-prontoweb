# Guía de Inicio Rápido - Parts Availability API

## 🚀 Paso 1: Configurar Variables de Entorno

1. Copia el archivo de ejemplo:
   ```bash
   cp .env.example .env
   ```

2. Edita `.env` y configura:
   ```env
   # PostgreSQL (para tabla product_match)
   PG_HOST=127.0.0.1
   PG_PORT=5432
   PG_USER=tu_usuario_pg
   PG_PASSWORD=tu_password_pg
   PG_DATABASE=tu_base_datos_pg
   
   # MySQL (para brandsandstores, productlocation, productstock)
   MYSQL_HOST=127.0.0.1
   MYSQL_PORT=3306
   MYSQL_USER=tu_usuario_mysql
   MYSQL_PASSWORD=tu_password_mysql
   MYSQL_DATABASE=prontoweb
   
   # API Key (genera una clave segura)
   PARTS_AVAILABILITY_API_KEY=mi_clave_super_segura_123
   
   # Puerto del servidor
   PORT=3000
   
   # Nivel de logs (debug, info, warn, error)
   LOG_LEVEL=info
   ```

## 🎯 Paso 2: Iniciar el Servidor

```bash
npm start
```

Deberías ver:
```
🚀 Server is running on port 3000
📍 Health check: http://localhost:3000/health
📍 API endpoint: POST http://localhost:3000/v1/parts/availability/resolve
```

## ✅ Paso 3: Verificar que Funciona

### Opción A: Usando curl

```bash
curl http://localhost:3000/health
```

Debería devolver:
```json
{
  "success": true,
  "message": "Server is running",
  "timestamp": "2026-03-06T..."
}
```

### Opción B: Usando el script de pruebas

```bash
node test-parts-availability.js
```

## 🧪 Paso 4: Probar el Endpoint

### Ejemplo básico con curl:

```bash
curl -X POST http://localhost:3000/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: mi_clave_super_segura_123" \
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

### Usando Postman:

1. Importa el archivo `postman_collection.json`
2. Configura las variables de colección:
   - `baseUrl`: http://localhost:3000
   - `apiKey`: tu API key del .env
3. Ejecuta cualquier request de la colección

## 📊 Estructura de Respuesta Esperada

```json
{
  "success": true,
  "storeId": 5,
  "locationId": 4,
  "total": 1,
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

## 🔍 Troubleshooting

### Error: "Unauthorized"
- Verifica que el header `x-api-key` esté presente
- Confirma que el valor coincida con `PARTS_AVAILABILITY_API_KEY` en `.env`

### Error de conexión a base de datos
- Verifica las credenciales en `.env`
- Confirma que PostgreSQL y MySQL estén corriendo
- Revisa los logs en `logs/partsAvailabilityService.log`

### El servidor no inicia
- Verifica que el puerto 3000 no esté ocupado
- Cambia el `PORT` en `.env` si es necesario
- Revisa `logs/server.log` para más detalles

## 📝 Archivos Importantes

| Archivo | Descripción |
|---------|-------------|
| `server.js` | Punto de entrada del servidor Express |
| `middleware/apiKeyAuth.js` | Middleware de autenticación |
| `services/partsAvailabilityService.js` | Lógica de negocio |
| `controllers/partsAvailabilityController.js` | Controlador HTTP |
| `routes/partsAvailability.js` | Definición de rutas |
| `test-parts-availability.js` | Suite de pruebas automatizadas |
| `postman_collection.json` | Colección de Postman |
| `API_PARTS_AVAILABILITY.md` | Documentación completa de la API |

## 🎓 Próximos Pasos

1. Lee la documentación completa en [API_PARTS_AVAILABILITY.md](API_PARTS_AVAILABILITY.md)
2. Ejecuta las pruebas automatizadas: `node test-parts-availability.js`
3. Importa la colección de Postman para pruebas manuales
4. Revisa los logs en la carpeta `logs/` para debugging
5. Integra el endpoint con tu aplicación BigCommerce

## 💡 Consejos

- **Seguridad**: Usa una API Key fuerte y guárdala de forma segura
- **Logs**: Revisa los logs regularmente para detectar problemas
- **Performance**: El endpoint usa pooling de conexiones para PostgreSQL
- **Batch**: Puedes enviar hasta cientos de productos en un solo request
- **Error Handling**: Si un producto falla, los demás se procesarán normalmente

## 🆘 Soporte

Si encuentras problemas:
1. Revisa los logs en `logs/`
2. Verifica las configuraciones en `.env`
3. Ejecuta el script de pruebas para diagnóstico
4. Consulta la documentación completa en API_PARTS_AVAILABILITY.md
