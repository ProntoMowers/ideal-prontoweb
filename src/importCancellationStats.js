require('dotenv').config();
const path = require('path');
const fs = require('fs');
const csv = require('fast-csv');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `importCancellationStats_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

/**
 * Normaliza valores para MySQL (convierte vacíos o NaN en NULL/0)
 */
function normalizeValue(val, isNumeric = false) {
    if (val === null || val === undefined || val === '' || val === ' ') return isNumeric ? 0 : null;
    if (isNumeric && isNaN(val)) return 0;
    return val;
}

/**
 * Intenta convertir el formato de fecha del CSV (ej: 31-Mar-25) a objeto Date
 */
function parseCsvDate(val) {
    if (!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
}

async function run() {
    const startTime = Date.now();
    let mysqlConn;

    try {
        log.info('🚀 Iniciando importación de estadísticas de cancelaciones...');
        mysqlConn = await getMySqlConnection();

        const fileName = 'prontoweb vw_cancellation_monthly_summary.csv';
        const filePath = path.join(__dirname, '../data', fileName);

        if (!fs.existsSync(filePath)) {
            log.warn(`Archivo no encontrado en /data: ${fileName}`);
            return;
        }

        const rows = [];
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(csv.parse({ headers: true }))
                .on('data', (row) => {
                    // Solo agregar si la fila tiene algún dato
                    if (Object.values(row).some(v => v !== '')) rows.push(row);
                })
                .on('end', resolve)
                .on('error', reject);
        });

        if (rows.length === 0) {
            log.info('El archivo CSV está vacío.');
            return;
        }

        log.info(`Procesando ${rows.length} registros del CSV...`);

        // Mapeo manual basado en los encabezados del CSV y las columnas de la tabla
        const sql = `INSERT IGNORE INTO cancellation_statistics_summary 
            (store_name, report_date, year, quarter, month_number, month_name, month_short_name, reason, cancel_type, user_cancel, sales_qty, cancellation_qty, sales_usd, cancellation_usd)
            VALUES ?`;

        const values = rows.map(r => [
            r.storeName,
            parseCsvDate(r.Date),
            normalizeValue(r.year, true),
            normalizeValue(r.quarter, true),
            normalizeValue(r.monthNumber, true),
            r.monthName,
            r.monthShortName,
            r.reason,
            r.cancel_type,
            r.user_cancel,
            normalizeValue(r.sales_qty, true),
            normalizeValue(r.cancellation_qty, true),
            normalizeValue(r.sales_usd, true),
            normalizeValue(r.cancellation_usd, true)
        ]);

        // Inserción masiva para máxima eficiencia
        await mysqlConn.query(sql, [values]);
        log.info(`✅ Importación exitosa: ${rows.length} registros procesados.`);

    } catch (err) {
        log.error('❌ Error crítico en el script de cancelaciones', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) run();