# Nuevo Script: Sincronización de Clientes VIP con Respond.io

## 📋 Resumen

Se ha creado un nuevo script `syncVipCustomersRespondIo.js` que identifica automáticamente clientes VIP y los sincroniza con Respond.io para campañas de marketing y WhatsApp.

## 📁 Archivos Creados

### 1. Script Principal
- **`src/syncVipCustomersRespondIo.js`**
  - Script de sincronización diaria
  - Ejecuta automáticamente a las 01:00 AM
  - Identifica clientes VIP por criterios configurables
  - Crea o actualiza contactos en Respond.io

### 2. Documentación
- **`docs/respondio-setup.md`**
  - Guía completa de configuración
  - Obtención de credenciales
  - Solución de problemas
  - Mejores prácticas

### 3. Configuración
- **`.env.example`**
  - Variables de entorno necesarias
  - Valores por defecto sugeridos

### 4. Script de Prueba
- **`src/test-respondio-connection.js`**
  - Verifica conectividad con Respond.io
  - Valida credenciales
  - Diagnóstico de errores

### 5. Documentación Actualizada
- **`README.md`** - Actualizado con nueva funcionalidad
- **`github/copilot-instructions.md`** - Actualizado con patrones y mejores prácticas
- **`ecosystem.config.js`** - Agregado cron job para ejecutar diariamente

## ⚙️ Configuración Requerida

### Variables de Entorno (.env)

Agregar las siguientes variables a tu archivo `.env`:

```env
# Respond.io API - Access Token (Bearer)
RESPONDIO_ACCESS_TOKEN=tu_access_token_aqui
RESPONDIO_API_URL=https://api.respond.io/v2

# Criterios VIP (valores configurables)
VIP_MAX_CUSTOMERS=100        # Máximo de clientes a procesar por ejecución
VIP_MIN_SALES_COUNT=2        # Mínimo de ventas en el período
VIP_MIN_SALES_AMOUNT=1000    # Monto mínimo facturado (USD)
VIP_TAG=VIP                  # Tag a aplicar en Respond.io
VIP_LOOKBACK_DAYS=365        # Días hacia atrás para analizar ventas
```

### Obtener Credenciales de Respond.io

1. Inicia sesión en [Respond.io](https://app.respond.io)
2. Ve a **Settings** → **Developer API** → **Access Tokens**
3. Copia tu **Access Token** (es un JWT largo)

## 🚀 Uso

### 1. Configurar Variables de Entorno

```bash
# Editar el archivo .env
nano .env

# Agregar el Access Token de Respond.io
RESPONDIO_ACCESS_TOKEN=tu_access_token_real
```

### 2. Probar Conexión (Recomendado)

```bash
node src/test-respondio-connection.js
```

Debe mostrar:
```
✓ Conexión exitosa!
✓ PRUEBA COMPLETADA EXITOSAMENTE
```

### 3. Ejecución Manual (Primera Vez)

Para probar con valores conservadores:

```bash
# Editar .env temporalmente para pruebas
VIP_MAX_CUSTOMERS=5
VIP_MIN_SALES_COUNT=1
VIP_MIN_SALES_AMOUNT=100

# Ejecutar
node src/syncVipCustomersRespondIo.js
```

### 4. Verificar Resultados

1. Revisa el log generado en `logs/syncVipCustomersRespondIo_YYYY-MM-DD.log`
2. Verifica en Respond.io que los contactos se crearon
3. Confirma que los tags y campos custom estén correctos

### 5. Configurar para Producción

```bash
# Ajustar .env con valores reales
VIP_MAX_CUSTOMERS=100
VIP_MIN_SALES_COUNT=2
VIP_MIN_SALES_AMOUNT=1000

# Agregar al PM2
pm2 start ecosystem.config.js --only ideal-sync-vip-respondio

# Verificar que esté corriendo
pm2 status
```

## 📊 Criterios de Clientes VIP

El script identifica clientes VIP usando esta lógica:

```sql
SELECT clientes WHERE:
  - Tienen al menos X ventas en los últimos Y días
  - Monto total facturado >= $Z
  - Email válido y no vacío
  - Estado activo (ISACTIVE = 'T')
  - Solo facturas tipo 'IN' (Invoices)
ORDER BY monto total DESC
LIMIT N clientes
```

### Ejemplos de Configuración

**E-commerce Alto Volumen:**
```env
VIP_MIN_SALES_COUNT=5
VIP_MIN_SALES_AMOUNT=2000
VIP_LOOKBACK_DAYS=365
VIP_MAX_CUSTOMERS=200
```

**E-commerce Mediano:**
```env
VIP_MIN_SALES_COUNT=3
VIP_MIN_SALES_AMOUNT=1500
VIP_LOOKBACK_DAYS=365
VIP_MAX_CUSTOMERS=100
```

**E-commerce Pequeño:**
```env
VIP_MIN_SALES_COUNT=2
VIP_MIN_SALES_AMOUNT=500
VIP_LOOKBACK_DAYS=180
VIP_MAX_CUSTOMERS=50
```

## 📝 Datos Sincronizados

### Campos Básicos
- `firstName` - Nombre del cliente
- `lastName` - Apellido del cliente
- `email` - Email (identificador único)
- `phone` - Teléfono normalizado a formato E.164

### Campos Custom en Respond.io
- `customer_id` - ID del cliente en IDEAL
- `sales_count` - Número de ventas en el período
- `total_sales` - Monto total facturado
- `address` - Dirección completa
- `city` - Ciudad
- `state` - Estado
- `zip` - Código postal
- `country` - País
- `last_sync` - Timestamp de última sincronización

### Tags Aplicados
- `VIP` (configurable via `VIP_TAG`)

## 🔄 Comportamiento

### Contactos Nuevos
- Se crea el contacto con todos los campos
- Se aplica el tag VIP
- Log: `✓ Contacto creado: email@example.com`

### Contactos Existentes
- Se mantienen tags existentes
- Se agrega tag VIP si no lo tenía
- Se actualizan campos custom con datos frescos
- Log: `✓ Contacto actualizado: email@example.com`

### Rate Limiting
- Delay de **500ms** entre cada request
- Procesamiento secuencial (no paralelo)
- Previene error 429 (Too Many Requests)

## 📈 Monitoreo

### Logs Diarios

Ubicación: `logs/syncVipCustomersRespondIo_YYYY-MM-DD.log`

Ejemplo de contenido:
```
[2026-03-02 01:00:00] [INFO] INICIO: Sincronización de Clientes VIP
[2026-03-02 01:00:01] [INFO] ✓ Encontrados 45 clientes VIP
[2026-03-02 01:00:02] [INFO] Top 5 Clientes VIP:
[2026-03-02 01:00:02] [INFO]   1. CUST001 - John Doe | Ventas: 5 | Total: $5,234.50
[2026-03-02 01:05:00] [INFO] RESUMEN:
[2026-03-02 01:05:00] [INFO]   - Clientes procesados: 45
[2026-03-02 01:05:00] [INFO]   - Contactos creados: 30
[2026-03-02 01:05:00] [INFO]   - Contactos actualizados: 15
[2026-03-02 01:05:00] [INFO]   - Errores: 0
```

### Comandos PM2

```bash
# Ver status
pm2 status

# Ver logs en tiempo real
pm2 logs ideal-sync-vip-respondio

# Ver logs específicos
pm2 logs ideal-sync-vip-respondio --lines 100

# Reiniciar manualmente
pm2 restart ideal-sync-vip-respondio

# Detener
pm2 stop ideal-sync-vip-respondio

# Eliminar del PM2
pm2 delete ideal-sync-vip-respondio
```

## 🔧 Solución de Problemas

### Error: "RESPONDIO_API_KEY no configurado"
**Solución:** Agregar la variable al archivo `.env`

### Error: "401 Unauthorized"
**Causas posibles:**
- API key inválida
- API key expirada
- Falta permisos en la key

**Solución:** Regenerar API key en Respond.io

### Warning: "No se encontraron clientes VIP"
**Causas posibles:**
- Criterios muy restrictivos
- Base de datos sin suficientes ventas

**Solución:** Ajustar valores en `.env`:
```env
VIP_MIN_SALES_COUNT=1
VIP_MIN_SALES_AMOUNT=100
VIP_LOOKBACK_DAYS=730
```

### Error: "429 Too Many Requests"
**Causa:** Exceso de requests a la API

**Solución:** Aumentar delay en el código (línea 320) o reducir `VIP_MAX_CUSTOMERS`

## 🎯 Próximos Pasos

1. **Configurar credenciales** en `.env`
2. **Probar conexión** con `test-respondio-connection.js`
3. **Primera ejecución manual** con valores bajos
4. **Verificar resultados** en Respond.io
5. **Ajustar parámetros** según necesidad
6. **Activar en producción** con PM2

## 📚 Referencias

- **Documentación completa:** `/docs/respondio-setup.md`
- **Patrones de código:** `/github/copilot-instructions.md`
- **Esquema de BD:** `/docs/schema.md`
- **API Respond.io:** https://docs.respond.io/

## 🔐 Seguridad

- ✅ API key almacenada en `.env` (no en el código)
- ✅ `.env` debe estar en `.gitignore`
- ✅ Usar prepared statements para queries SQL
- ✅ Validación de datos antes de enviar a API
- ✅ Logging sin exponer información sensible

## 📞 Soporte

Para preguntas o problemas:
1. Revisar logs en `logs/`
2. Consultar `/docs/respondio-setup.md`
3. Verificar configuración en `.env`
4. Ejecutar `test-respondio-connection.js`

---

**Nota:** Este script se ejecuta automáticamente cada día a la **01:00 AM** mediante PM2. No requiere intervención manual una vez configurado correctamente.
