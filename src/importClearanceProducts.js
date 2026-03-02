require('dotenv').config();
const path = require('path');
const fs = require('fs');
const csv = require('fast-csv');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `importClearanceProducts_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

/**
 * Normaliza valores para MySQL
 */
function normalizeValue(val, isNumeric = false) {
    if (val === null || val === undefined || val === '' || val === ' ') return null;
    return isNumeric ? parseInt(val) : val;
}

/**
 * Convierte formato m/d/yyyy a objeto Date
 */
function parseCsvDate(val) {
    if (!val || val === '' || val === ' ') return null;
    const parts = val.split('/');
    if (parts.length === 3) {
        // parts[0] = mes, parts[1] = día, parts[2] = año
        const date = new Date(parts[2], parts[0] - 1, parts[1]);
        return isNaN(date.getTime()) ? null : date;
    }
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
}

async function run() {
    const startTime = Date.now();
    let mysqlConn;

    try {
        log.info('🚀 Iniciando proceso de importación de Clearance (Limpieza total)...');
        mysqlConn = await getMySqlConnection();

        const fileName = 'clearence.csv';
        const filePath = path.join(__dirname, '../data', fileName);

        if (!fs.existsSync(filePath)) {
            log.warn(`Archivo no encontrado en /data: ${fileName}`);
            return;
        }

        // 1. LIMPIEZA DE LA TABLA ANTES DE IMPORTAR
        log.info('🧹 Vaciando la tabla clearance_products...');
        await mysqlConn.query('TRUNCATE TABLE clearance_products');

        // 2. LECTURA DEL CSV
        const rows = [];
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(csv.parse({ headers: true }))
                .on('data', (row) => {
                    if (Object.values(row).some(v => v !== '')) rows.push(row);
                })
                .on('end', resolve)
                .on('error', reject);
        });

        if (rows.length === 0) {
            log.info('El archivo CSV está vacío, no hay nada que importar tras la limpieza.');
            return;
        }

        log.info(`Procesando ${rows.length} registros del CSV...`);

        // 3. PREPARACIÓN DE INSERCIÓN
        const sql = `INSERT INTO clearance_products 
            (brand, sku, date_in, date_out, user, update_process, note_administration, initial_quantity, last_update, user_last_update, months_last_sale, note, location)
            VALUES ?`;

        const values = rows.map(r => [
            normalizeValue(r.Mfrid),
            normalizeValue(r.Sku),
            parseCsvDate(r['Date in']),
            parseCsvDate(r['Date out']),
            normalizeValue(r.User),
            normalizeValue(r['Max & Min']),
            normalizeValue(r.Resumen),
            normalizeValue(r['Initial Qty'], true),
            parseCsvDate(r['Last Update']),
            normalizeValue(r['Updated by']),
            normalizeValue(r['Months last sale']),
            normalizeValue(r.Note),
            null // location
        ]);

        // 4. INSERCIÓN MASIVA POR BLOQUES
        const chunkSize = 1000;
        for (let i = 0; i < values.length; i += chunkSize) {
            const chunk = values.slice(i, i + chunkSize);
            await mysqlConn.query(sql, [chunk]);
        }

        log.info(`✅ Limpieza e importación exitosa: ${rows.length} registros insertados.`);

    } catch (err) {
        log.error('❌ Error crítico en el script de Clearance', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) run();