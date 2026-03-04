# Copilot Instructions - IDEAL ProntoWeb

## Descripción del Proyecto

Este proyecto es un **sistema de migración y sincronización de datos** para Pronto Mowers. Migra datos desde el sistema ERP IDEAL (Firebird) hacia bases de datos MySQL y MS SQL Server, además de proporcionar una API REST para gestionar operaciones de negocio.

## Arquitectura del Sistema

### Bases de Datos
- **Firebird (IDEAL ERP)**: Sistema fuente con datos maestros de productos, clientes, ventas, inventario y contabilidad
- **MySQL**: Base de datos destino principal para el sistema web
- **MS SQL Server (ShipWorks)**: Base de datos auxiliar para integraciones de envíos

### Tecnologías Principales
- **Node.js** con dependencias:
  - `node-firebird`: Conexión a Firebird (IDEAL)
  - `mysql2`: Conexión a MySQL
  - `mssql`: Conexión a MS SQL Server
  - `express`: API REST
  - `axios`: Integración con APIs externas (Zoho Desk)
  - `pm2/ecosystem.config.js`: Gestión de procesos y cron jobs

## Estructura del Código

### `/providers/dbConnections.js`
Módulo centralizado de conexiones a bases de datos:
- `getMySqlConnection()`: Pool de conexiones MySQL
- `getFirebirdConnection()`: Conexión a Firebird con configuración específica
- `getMssqlConnection()`: Conexión a MS SQL Server (ShipWorks)
- `fbQuery()`: Helper para ejecutar queries en Firebird como promesas

### `/helpers/logger.js`
Sistema de logging que genera archivos en `/logs/` con formato personalizado.

### `/src/` - Scripts de Migración

#### Scripts de Migración Programados (Cron Jobs via PM2)
Ejecutan diariamente en horarios específicos:

1. **22:00** - `migrateProductIdeal.js`: Productos (PRODUCT)
2. **22:15** - `migrateProductLocation.js`: Ubicaciones de productos
3. **22:30** - `migrateSalesInvoices.js`: Facturas de venta (AR + detalle)
4. **22:45** - `migratePOReceipts.js`: Recibos de órdenes de compra
5. **23:00** - `migrateICTrans.js`: Transacciones de inventario
6. **23:15** - `migrateSalesOrders.js`: Órdenes de venta
7. **23:30** - `migrateCustomers.js`: Clientes
8. **23:45** - `migrateWorkOrders.js`: Órdenes de trabajo
9. **00:00** - `migrateProductStock.js`: Stock de productos
10. **00:15** - `migrateAccountantTrans.js`: Transacciones contables
11. **00:30** - `migrateAPTrans.js`: Transacciones de cuentas por pagar
12. **00:45** - `migrateARTrans.js`: Transacciones de cuentas por cobrar
13. **00:45** - `reportCancellationSummary.js`: Reporte de cancelaciones
14. **01:00** - `syncVipCustomersRespondIo.js`: Sincronización de clientes VIP a Respond.io

#### API REST (Activa 24/7)
- **`submitReturn.js`**: API Express en puerto 3001
  - POST `/submit-return`: Crea tickets de devolución en Zoho Desk
  - Integración con Zoho OAuth2
  - Manejo de archivos adjuntos (multer)
  - Guarda registros en MySQL

#### Scripts de Sincronización
- **`syncVipCustomersRespondIo.js`**: Sincroniza clientes VIP con Respond.io
  - Identifica clientes VIP por ventas y monto facturado
  - Crea nuevos contactos o actualiza tags en Respond.io
  - Criterios configurables via .env (cantidad ventas, monto mínimo, período)
  - Normalización automática de teléfonos a formato E.164
  - Rate limiting integrado (500ms entre requests)
  - Ver: `/docs/respondio-setup.md` para configuración detallada

#### Scripts de Importación/Reportes
- `importCancellationDetailsReport.js`: Importa detalles de cancelaciones
- `importCancellationStats.js`: Estadísticas de cancelaciones
- `importClearanceProducts.js`: Productos en liquidación
- `importFulfillmentStats.js`: Estadísticas de cumplimiento
- `importHistoricDetails.js`: Detalles históricos
- `reconstructCancellationDetailsAnterior.js`: Reconstrucción de cancelaciones anteriores
- `reconstructCancellations.js`: Reconstrucción de cancelaciones
- `updateKitsPricesBigCommerce.js`: Actualización de precios en BigCommerce

### `/config/bigquery.js`
Configuración para integración con Google BigQuery.

### `/docs/schema.md`
Documentación completa del esquema de la base de datos IDEAL con definiciones de tablas, foreign keys y estructura contable.

### `/docs/respondio-setup.md`
Guía completa de configuración y uso de la integración con Respond.io, incluyendo obtención de credenciales, estructura de datos, y solución de problemas.

## Patrones de Desarrollo

### Sincronización con APIs Externas
```javascript
// Patrón típico de sincronización
1. Consultar datos desde MySQL con criterios específicos
2. Normalizar datos según requerimientos de la API externa
3. Buscar si el recurso ya existe (por email, ID, etc.)
4. Crear o actualizar según corresponda
5. Rate limiting para evitar saturar la API
6. Logging detallado de cada operación
7. Resumen final con estadísticas
```

### Migración de Datos
```javascript
// Patrón típico de migración
1. Conectar a Firebird y MySQL
2. Leer datos por LOTES (BATCH_SIZE) desde Firebird
3. Transformar datos (mayúsculas, normalizar nulls)
4. Insertar por lotes en MySQL usando REPLACE INTO o INSERT IGNORE
5. Logging detallado de errores y progreso
6. Cerrar conexiones
```

### Manejo de Errores
- Logs detallados con timestamps
- Normalización de valores "raros" de Firebird a NULL
- Manejo de campos BLOB (NOTES, BILLTOMEMO, etc.) → se omiten o setean NULL

### Variables de Entorno (.env)
```
# MySQL
MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE

# Firebird (IDEAL)
FB_HOST, FB_PORT, FB_DATABASE, FB_USER, FB_PASSWORD, FB_LOWERCASE_KEYS

# MS SQL Server (ShipWorks)
MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DATABASE

# Zoho Desk API
ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
ZOHO_ORG_ID, ZOHO_DEPARTMENT_ID

# Respond.io API
RESPONDIO_ACCESS_TOKEN (Bearer Token para autenticación)
RESPONDIO_API_URL (por defecto: https://api.respond.io/v2)
VIP_MAX_CUSTOMERS, VIP_MIN_SALES_COUNT, VIP_MIN_SALES_AMOUNT
VIP_TAG, VIP_LOOKBACK_DAYS

# BigQuery (si aplica)
GOOGLE_APPLICATION_CREDENTIALS
```

## Convenciones de Código

### Nombres de Columnas
- **Firebird (IDEAL)**: Siempre en MAYÚSCULAS (ej: `PARTNUMBER`, `MFRID`)
- **MySQL**: Generalmente lowercase pero el código usa MAYÚSCULAS en arrays de columnas
- Mantener consistencia con el esquema original de IDEAL

### Nomenclatura
- Scripts de migración: `migrate*.js`
- Scripts de importación: `import*.js`
- Scripts de reportes: `report*.js`
- Nombres de procesos PM2: `ideal-migrate-*` o descriptivos del servicio

### Convenciones de Nombres de Variables

#### Variables de Constantes
- **MAYÚSCULAS con SNAKE_CASE** para constantes globales y configuración:
  ```javascript
  const LOG_NAME = 'migrateProduct_2026-03-02.log';
  const BATCH_SIZE = 500;
  const COLUMNS = ['MFRID', 'PARTNUMBER', 'DESCRIPTION'];
  ```

#### Variables de Conexiones
- **camelCase** para objetos de conexión:
  ```javascript
  const mysqlConn = await getMySqlConnection();
  const fbConn = await getFirebirdConnection();
  const mssqlPool = await getMssqlConnection();
  ```

#### Variables de Datos
- **camelCase** para variables locales y parámetros:
  ```javascript
  const productData = await fbQuery(db, query);
  const batchRows = [];
  const totalRecords = 0;
  let currentBatch = 0;
  ```

#### Variables de IDs y Referencias
- **Mantener el sufijo `Id`** en camelCase para identificadores:
  ```javascript
  const customerId = row.CUSTOMERID;
  const orderId = data.order_id;
  const zohoTicketId = response.data.id;
  ```

#### Variables de Configuración de APIs
- **MAYÚSCULAS con SNAKE_CASE** para env variables:
  ```javascript
  const orgId = process.env.ZOHO_ORG_ID;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const accessToken = authRes.data.access_token;
  ```

#### Funciones y Métodos
- **camelCase** comenzando con verbo:
  ```javascript
  async function getMySqlConnection() { }
  function createLogger(logName) { }
  async function processProductBatch(rows) { }
  function normalizeValue(val) { }
  const toYN = (val) => (val === '1') ? 'YES' : 'NO';
  ```

#### Objetos de Configuración
- **camelCase** para propiedades:
  ```javascript
  const options = {
    host: process.env.FB_HOST,
    port: Number(process.env.FB_PORT),
    database: process.env.FB_DATABASE,
    pageSize: 4096
  };
  ```

#### Arrays de Datos
- **Plural en camelCase**:
  ```javascript
  const products = [];
  const invoices = [];
  const errorMessages = [];
  ```

#### Contadores e Índices
- **camelCase descriptivo**:
  ```javascript
  let processedCount = 0;
  let errorCount = 0;
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i++) { }
  ```

### Logging
- Archivos de log con formato: `{scriptName}_YYYY-MM-DD.log`
- Usar el helper `createLogger(LOG_NAME)`
- Niveles: INFO, WARN, ERROR

### Queries SQL
- Usar prepared statements para prevenir SQL injection
- Batch processing para tablas grandes (típicamente BATCH_SIZE = 500)
- FULL REFRESH cuando sea necesario (TRUNCATE respetando FKs)

## Integración con Servicios Externos

### Zoho Desk
- OAuth2 con refresh token
- Creación de tickets de soporte
- Adjuntar archivos (imágenes de productos)
- Campos custom según departamento

### Respond.io
- API REST con Bearer token authentication
- Gestión de contactos para WhatsApp y otros canales
- Sistema de tags para segmentación
- Campos custom para datos de negocio
- Rate limiting: 500ms entre requests
- Búsqueda de contactos por email (identificador único)
- Normalización automática de teléfonos a formato E.164
- Ver `/docs/respondio-setup.md` para guía completa

### BigCommerce
- Actualización de precios de kits
- API REST integration

### ShipWorks (MS SQL)
- Consulta de información de envíos
- Integración para fulfillment

## Comandos de Desarrollo

```bash
# Ejecutar migración individual
node src/migrateProductIdeal.js

# Iniciar todos los cron jobs (PM2)
pm2 start ecosystem.config.js

# Iniciar solo la API
pm2 start ecosystem.config.js --only prontoweb-api

# Ver logs
pm2 logs ideal-migrate-product
```

## Mejores Prácticas para Copilot

1. **Al modificar scripts de migración**:
   - Respetar el orden de las columnas en los arrays
   - Mantener el batch processing para performance
   - No olvidar cerrar conexiones DB

2. **Al trabajar con Firebird**:
   - Usar `fbQuery()` helper para promesas
   - Los nombres de campos son case-sensitive
   - BLOB fields requieren manejo especial

3. **Al extender la API**:
   - Seguir patrón Express existente
   - Usar middleware cors y body-parser
   - Logs detallados para debugging

4. **Al agregar nuevas migraciones**:
   - Añadir entry en `ecosystem.config.js`
   - Usar horarios que no traslapen
   - Documentar el propósito y tablas afectadas

5. **Manejo de Errores**:
   - Siempre loguear errores con contexto
   - Normalizar valores nulos y inesperados
   - Try-catch en operaciones DB críticas

6. **Al integrar con APIs externas (Zoho, Respond.io, etc.)**:
   - Implementar rate limiting apropiado
   - Usar async/await con manejo de errores robusto
   - Validar credenciales al inicio del script
   - Loguear requests y responses para debugging
   - Normalizar datos antes de enviar (teléfonos, emails, etc.)
   - Buscar recurso existente antes de crear nuevo
   - Manejar casos de actualización vs creación
   - Respetar límites de la API (429 Too Many Requests)

7. **Al crear scripts de sincronización**:
   - Queries SQL optimizadas con índices apropiados
   - Límite configurable de registros a procesar (MAX_*)
   - Criterios parametrizados via .env
   - Delay entre requests para evitar throttling
   - Resumen estadístico al final (creados, actualizados, errores)
   - Considerar ejecución idempotente cuando sea posible

## Archivos Clave a Revisar

- `/docs/schema.md`: Estructura completa de tablas IDEAL
- `/docs/respondio-setup.md`: Configuración de Respond.io
- `/providers/dbConnections.js`: Configuración de conexiones
- `/ecosystem.config.js`: Configuración de cron jobs
- Cualquier script en `/src/migrate*.js`: Patrones de migración establecidos

## Notas Importantes

- Sistema crítico en producción corriendo 24/7
- Las migraciones se ejecutan automáticamente cada noche
- Los logs son esenciales para debugging
- Evitar cambios que rompan compatibilidad con esquemas existentes
- Testear cambios en desarrollo antes de desplegar a producción
