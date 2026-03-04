# Configuración de Respond.io

## Obtención de Credenciales

### Access Token

1. Inicia sesión en [Respond.io](https://app.respond.io)
2. Ve a **Settings** → **Developer API** → **Access Tokens**
3. Copia tu **Access Token** (es un JWT largo)
4. Agrégalo en `.env`:
   ```
   RESPONDIO_ACCESS_TOKEN=tu_access_token_aqui
   ```

**Nota:** El Access Token es un Bearer token que se usa en el header `Authorization: Bearer {token}`

## Estructura de Contactos en Respond.io

### Campos Básicos Sincronizados

- **firstName**: Nombre del cliente
- **lastName**: Apellido del cliente  
- **email**: Email (usado como identificador único para búsqueda)
- **phone**: Número de teléfono en formato E.164 (+1234567890) - también usado para búsqueda

### Tags Aplicados

- **VIP**: Aplicado automáticamente a todos los clientes que cumplen los criterios

## Criterios de Clientes VIP

Los clientes VIP se identifican mediante los siguientes parámetros configurables:

### Variables de Configuración

```env
# Número máximo de clientes a sincronizar por ejecución
VIP_MAX_CUSTOMERS=100

# Número mínimo de ventas en el período
VIP_MIN_SALES_COUNT=2

# Monto mínimo facturado en el período (USD)
VIP_MIN_SALES_AMOUNT=1000

# Tag a aplicar en Respond.io
VIP_TAG=VIP

# Días hacia atrás para analizar ventas
VIP_LOOKBACK_DAYS=365
```

### Query de Identificación

El script ejecuta la siguiente lógica:

```sql
SELECT customers con:
  - Mínimo X ventas en los últimos Y días
  - Monto total facturado >= $Z
  - Email válido y no vacío
  - Estado activo (ISACTIVE = 'T')
  - Solo facturas tipo 'IN' (Invoices)
ORDER BY monto total DESC
LIMIT N clientes
```

## Formato de Números de Teléfono

El script normaliza automáticamente los números de teléfono al formato E.164 requerido por WhatsApp:

### Reglas de Normalización

1. Limpia caracteres no numéricos: `(123) 456-7890` → `1234567890`
2. Agrega código de país si no existe (default: `1` para USA)
3. Agrega símbolo `+` al inicio: `1234567890` → `+11234567890`
4. Valida longitud mínima (11 dígitos con código)

### Prioridad de Campos

El script intenta obtener el teléfono en este orden:
1. `CELL` (celular)
2. `PHONE` (teléfono fijo)

Si ninguno es válido, el contacto se crea sin número de teléfono.

## Comportamiento de Sincronización

### Búsqueda de Contactos

El script busca contactos existentes usando el endpoint `GET /contact/{identifier}`:

1. **Primero por email**: Si existe un contacto con ese email, lo usa
2. **Luego por teléfono**: Si no encontró por email, busca por teléfono normalizado

Si no encontrado en ambos, se crea un nuevo contacto.

### Contactos Nuevos

Cuando un cliente VIP no existe en Respond.io:
- Se crea un nuevo contacto con `POST /contact`
- Campos enviados: firstName, lastName, email, phone (si aplica)
- Se aplica el tag VIP (mediante `PUT /contact/{id}`)
- Se registra en el log como "created"

### Contactos Existentes

Cuando un cliente VIP ya existe en Respond.io (encontrado por email o phone):
- Se actualiza con `PUT /contact/{id}`
- Se mantienen los tags existentes
- Se agrega el tag VIP (si no lo tenía)
- Se agrega el tag VIP (si no lo tenía)
- Se actualizan los campos custom con datos frescos
- Se registra en el log como "updated"

### Rate Limiting

Para evitar saturar la API de Respond.io:
- Delay de **500ms** entre cada request
- Procesamiento secuencial (no paralelo)
- Logging detallado de cada operación

## Monitoreo y Logs

### Ubicación de Logs

```
logs/syncVipCustomersRespondIo_YYYY-MM-DD.log
```

### Estructura del Log

```
[2026-03-02 01:00:00] [INFO] Conectando a MySQL...
[2026-03-02 01:00:01] [INFO] ✓ Conexión MySQL establecida
[2026-03-02 01:00:02] [INFO] Consultando clientes VIP...
[2026-03-02 01:00:03] [INFO] ✓ Encontrados 45 clientes VIP
[2026-03-02 01:00:04] [INFO] Top 5 Clientes VIP:
[2026-03-02 01:00:04] [INFO]   1. CUST001 - John Doe | Ventas: 5 | Total: $5,234.50
...
[2026-03-02 01:00:10] [INFO] [1/45] Procesando: CUST001 - John Doe
[2026-03-02 01:00:11] [INFO]   ✓ Contacto creado: john@example.com
...
[2026-03-02 01:05:00] [INFO] RESUMEN DE SINCRONIZACIÓN:
[2026-03-02 01:05:00] [INFO]   - Clientes procesados: 45
[2026-03-02 01:05:00] [INFO]   - Contactos creados: 30
[2026-03-02 01:05:00] [INFO]   - Contactos actualizados: 15
[2026-03-02 01:05:00] [INFO]   - Errores: 0
```

## Solución de Problemas

### Error: "RESPONDIO_ACCESS_TOKEN no configurado"

**Causa**: Falta el Access Token en el archivo `.env`

**Solución**: 
1. Obtén tu Access Token desde Settings → Developer API → Access Tokens en Respond.io
2. Agrégalo al `.env`:
   ```
   RESPONDIO_ACCESS_TOKEN=tu_access_token_real
   ```

### Error: "401 Unauthorized"

**Causa**: Access Token inválido, expirado o sin permisos

**Solución**: 
1. Verifica que el Access Token sea completo y sin espacios
2. Regenera el Access Token en Respond.io si está expirado
3. Confirma que el token tenga permisos de lectura/escritura

### Error: "404 Not Found" al buscar contacto

**Causa**: Normal cuando el contacto no existe aún

**Acción**: El script automáticamente crea el contacto nuevo

### Warning: "No se encontraron clientes VIP"

**Causa**: Ningún cliente cumple los criterios configurados

**Solución**: 
- Ajusta los valores en `.env` (reduce `VIP_MIN_SALES_COUNT` o `VIP_MIN_SALES_AMOUNT`)
- Aumenta `VIP_LOOKBACK_DAYS` para analizar un período más largo

### Error: "429 Too Many Requests"

**Causa**: Exceso de requests a la API de Respond.io

**Solución**: 
- El script tiene delay de 500ms entre requests
- Reducir `VIP_MAX_CUSTOMERS` para procesar menos clientes por ejecución
- Distribuir las ejecuciones en diferentes horarios si hay muchos clientes

## Mejores Prácticas

### Pruebas Iniciales

Antes de ejecutar en producción:

1. Configura valores bajos para pruebas:
   ```env
   VIP_MAX_CUSTOMERS=5
   VIP_MIN_SALES_COUNT=1
   VIP_MIN_SALES_AMOUNT=100
   ```

2. Ejecuta manualmente:
   ```bash
   node src/syncVipCustomersRespondIo.js
   ```

3. Verifica en Respond.io que los contactos se crearon correctamente

4. Revisa el log generado para confirmar que todo funcionó

### Monitoreo Continuo

- Revisa los logs diarios en `logs/`
- Verifica PM2 status: `pm2 status`
- Monitorea el tiempo de ejecución (debería ser < 5 minutos para 100 clientes)

### Ajuste de Parámetros

Basado en tu base de clientes:

- **E-commerce alto volumen**: `VIP_MIN_SALES_COUNT=5`, `VIP_MIN_SALES_AMOUNT=2000`
- **E-commerce mediano**: `VIP_MIN_SALES_COUNT=3`, `VIP_MIN_SALES_AMOUNT=1500`  
- **E-commerce pequeño**: `VIP_MIN_SALES_COUNT=2`, `VIP_MIN_SALES_AMOUNT=500`

## Segmentación Avanzada (Futuras Mejoras)

Ideas para extender la funcionalidad:

### Tags Adicionales por Segmento

```javascript
// Ejemplos de tags adicionales
if (customer.total_sales_amount > 5000) tags.push('HIGH_VALUE');
if (customer.sales_count > 10) tags.push('FREQUENT_BUYER');
if (customer.STATE === 'CA') tags.push('CALIFORNIA');
```

### Campos Custom Adicionales

```javascript
customFields: {
  // ... campos existentes
  last_purchase_date: lastSale.TRANSDATE,
  average_order_value: (totalSales / salesCount).toFixed(2),
  customer_since: customer.ENTRYDATE,
  preferred_product_category: topCategory
}
```

### Múltiples Segmentos

Crear scripts separados para diferentes segmentos:
- `syncVipCustomersRespondIo.js` - Clientes VIP
- `syncNewCustomersRespondIo.js` - Clientes nuevos (últimos 30 días)
- `syncDormantCustomersRespondIo.js` - Clientes inactivos (sin compras en 6 meses)
- `syncBirthdayCustomersRespondIo.js` - Clientes con cumpleaños este mes

## Documentación de API

Documentación oficial: [https://docs.respond.io/](https://docs.respond.io/)

### Endpoints Utilizados

- `POST /v2/contact` - Crear contacto
- `PUT /v2/contact/{id}` - Actualizar contacto
- `GET /v2/contact/search` - Buscar contacto por email
