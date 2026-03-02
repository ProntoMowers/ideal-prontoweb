# IDEAL Product Migrator

Script standalone para migrar la tabla `PRODUCT` de IDEAL (Firebird) a la tabla `product` en MySQL.

## Estructura

- `src/migrateProductIdeal.js` → Script principal
- `providers/dbConnections.js` → Conexiones a Firebird y MySQL
- `helpers/logger.js` → Logger simple con salida a `logs/`
- `logs/` → Carpeta donde se generan los logs
- `.env` → Variables de entorno (copiar desde `.env.example`)

## Uso

1. Instalar dependencias:

```bash
npm install
