require('dotenv').config();
const path = require('path');
const fs = require('fs');
const csv = require('fast-csv');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `importCancellationDetailsReport_${new Date().toISOString().slice(0, 10)}.log`;
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
 * Intenta convertir el formato de fecha del CSV a objeto Date
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
        log.info('🚀 Iniciando importación de DETALLE de estadísticas de cancelaciones...');
        mysqlConn = await getMySqlConnection();

        // El nombre del archivo CSV detectado en tus archivos
        const fileName = 'prontoweb vw_cancellation_details_monthly.csv';
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
            log.info('El archivo CSV de detalle está vacío.');
            return;
        }

        log.info(`Procesando ${rows.length} registros de detalle del CSV...`);

        // Mapeo hacia la tabla cancellation_details_report
        // Los encabezados del CSV detectados son: storeName, mfr, partNumber, Date, reason, total_units, total_price
        const sql = `INSERT IGNORE INTO cancellation_details_report 
            (mfr, part_number, store_name, reason, date, total_units, total_price) 
            VALUES ?`;

        const values = rows.map(r => [
            r.mfr,
            r.partNumber,
            r.storeName,
            r.reason,
            parseCsvDate(r.Date),
            normalizeValue(r.total_units, false), // Se deja false porque el schema es varchar(100)
            normalizeValue(r.total_price, false)   // Se deja false porque el schema es varchar(100)
        ]);

        // Inserción masiva
        await mysqlConn.query(sql, [values]);
        log.info(`✅ Importación de detalles exitosa: ${rows.length} registros procesados.`);

    } catch (err) {
        log.error('❌ Error crítico en el script de importación de detalles', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) run();