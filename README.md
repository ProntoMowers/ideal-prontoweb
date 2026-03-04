# IDEAL ProntoWeb - Sistema de Migración y Sincronización

Sistema completo de migración de datos desde IDEAL ERP (Firebird) hacia MySQL, con integraciones a múltiples servicios externos.

## Estructura del Proyecto

- `src/migrate*.js` → Scripts de migración de datos (productos, clientes, ventas, inventario, contabilidad)
- `src/import*.js` → Scripts de importación de reportes
- `src/sync*.js` → Scripts de sincronización con servicios externos
- `src/submitReturn.js` → API REST para gestión de devoluciones
- `providers/dbConnections.js` → Conexiones a Firebird, MySQL y MS SQL Server
- `helpers/logger.js` → Sistema de logging
- `config/` → Configuraciones específicas (BigQuery, etc.)
- `docs/schema.md` → Documentación completa del esquema de base de datos
- `logs/` → Carpeta donde se generan los logs
- `.env` → Variables de entorno (copiar desde `.env.example`)

## Instalación

1. Instalar dependencias:

```bash
npm install
```

2. Copiar y configurar variables de entorno:

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

3. Crear carpeta de logs:

```bash
mkdir logs
```

## Scripts Disponibles

### Migraciones Programadas (Cron Jobs)

Estos scripts se ejecutan automáticamente cada día mediante PM2:

- **22:00** - `migrateProductIdeal.js` - Productos
- **22:15** - `migrateProductLocation.js` - Ubicaciones de productos
- **22:30** - `migrateSalesInvoices.js` - Facturas de venta
- **22:45** - `migratePOReceipts.js` - Recibos de órdenes de compra
- **23:00** - `migrateICTrans.js` - Transacciones de inventario
- **23:15** - `migrateSalesOrders.js` - Órdenes de venta
- **23:30** - `migrateCustomers.js` - Clientes
- **23:45** - `migrateWorkOrders.js` - Órdenes de trabajo
- **00:00** - `migrateProductStock.js` - Stock de productos
- **00:15** - `migrateAccountantTrans.js` - Transacciones contables
- **00:30** - `migrateAPTrans.js` - Cuentas por pagar
- **00:45** - `migrateARTrans.js` - Cuentas por cobrar
- **00:45** - `reportCancellationSummary.js` - Reporte de cancelaciones
- **01:00** - `syncVipCustomersRespondIo.js` - Sincronización de clientes VIP a Respond.io

### API REST

- `submitReturn.js` - API Express en puerto 3001 (24/7)
  - Endpoint: `POST /submit-return`
  - Crea tickets de devolución en Zoho Desk

### Sincronización con Respond.io

#### `syncVipCustomersRespondIo.js`

Sincroniza clientes VIP con Respond.io para campañas de WhatsApp y marketing.

**Criterios VIP configurables en `.env`:**

```env
VIP_MAX_CUSTOMERS=100        # Máximo de clientes a procesar
VIP_MIN_SALES_COUNT=2        # Mínimo de ventas en el período
VIP_MIN_SALES_AMOUNT=1000    # Monto mínimo facturado (USD)
VIP_TAG=VIP                  # Tag a aplicar en Respond.io
VIP_LOOKBACK_DAYS=365        # Días hacia atrás para analizar
```

**Ejecución manual:**

```bash
node src/syncVipCustomersRespondIo.js
```

**Funcionalidad:**
- Identifica clientes VIP basado en ventas del último año
- Crea nuevos contactos en Respond.io
- Actualiza tags de contactos existentes
- Sincroniza datos custom (ID cliente, total ventas, dirección)
- Delay automático entre requests para no saturar la API

## Comandos PM2

### Iniciar todos los servicios

```bash
pm2 start ecosystem.config.js
```

### Iniciar solo la API

```bash
pm2 start ecosystem.config.js --only prontoweb-api
```

### Ver logs

```bash
pm2 logs ideal-sync-vip-respondio
pm2 logs prontoweb-api
```

### Ver estado

```bash
pm2 status
```

### Reiniciar un servicio

```bash
pm2 restart ideal-sync-vip-respondio
