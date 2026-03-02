require('dotenv').config();
const path = require('path');
const fs = require('fs');
const csv = require('fast-csv');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `importFulfillmentStats_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

/**
 * Normaliza valores para MySQL (convierte vacíos en NULL)
 */
function normalizeValue(val) {
    if (val === null || val === undefined || val === '' || val === ' ') return null;
    return val;
}

async function run() {
    const startTime = Date.now();
    let mysqlConn;

    try {
        log.info('🚀 Iniciando importación de estadísticas históricas...');
        mysqlConn = await getMySqlConnection();

        // 1. Procesar MFR (Ya se insertaron 106k, puedes comentarlo si no quieres duplicarlos)
        // await processMfr(mysqlConn);

        // 2. Procesar Store (Aquí es donde daba el error de duplicados)
        await processStore(mysqlConn);

        log.info('✅ Proceso de importación finalizado con éxito.');
    } catch (err) {
        log.error('❌ Error crítico en el script', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

async function processMfr(mysqlConn) {
    const fileName = 'prontoweb vw_mfr_fulfillment_stats.csv';
    const filePath = path.join(__dirname, '../data', fileName);
    if (!fs.existsSync(filePath)) return log.warn(`Archivo no encontrado: ${fileName}`);

    const rows = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv.parse({ headers: true }))
            .on('data', (row) => rows.push(row))
            .on('end', async () => {
                try {
                    // Usamos INSERT IGNORE por si acaso hay duplicados de fecha/parte
                    const sql = `INSERT IGNORE INTO mfr_fulfillment_stats 
                        (mfrid, partnumber, report_date, total_onorderquantity, total_allocatedquantity, total_stocklvl, total_no_stocklvl, total_allocated_no_stocklvl, total_allocated_stocklvl)
                        VALUES ?`;
                    
                    const values = rows.map(r => [
                        r.Mfr, r.Partnumber, r.Date ? new Date(r.Date) : null,
                        normalizeValue(r.total_onorder), normalizeValue(r.total_allocated),
                        normalizeValue(r.total_in_stock), normalizeValue(r.total_no_stock),
                        normalizeValue(r.total_allocated_no_stock), normalizeValue(r.total_allocated_stock)
                    ]);

                    await mysqlConn.query(sql, [values]);
                    log.info(`MFR: ${rows.length} registros procesados.`);
                    resolve();
                } catch (err) { reject(err); }
            });
    });
}

async function processStore(mysqlConn) {
    const fileName = 'prontoweb vw_store_fulfillment_stats.csv';
    const filePath = path.join(__dirname, '../data', fileName);
    if (!fs.existsSync(filePath)) return log.warn(`Archivo no encontrado: ${fileName}`);

    const rows = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv.parse({ headers: true }))
            .on('data', (row) => rows.push(row))
            .on('end', async () => {
                try {
                    // Omitimos la columna 'id' para que MySQL genere IDs nuevos (AUTO_INCREMENT)
                    const sql = `INSERT IGNORE INTO store_fulfillment_stats 
                        (store_id, store_name, report_date, year, month, month_name, quarter, total_orders, total_orders_no_stocklvl, total_orders_stocklvl, total_active, total_active_no_stocklvl, total_active_stocklvl)
                        VALUES ?`;

                    const values = rows.map(r => [
                        normalizeValue(r.storeId), 
                        r.storeName, 
                        r.Date ? new Date(r.Date) : null,
                        normalizeValue(r.year), 
                        normalizeValue(r.monthNumber), 
                        r.monthName, 
                        normalizeValue(r.quarter),
                        normalizeValue(r.totalOrders), 
                        normalizeValue(r.ordersNoStockLvl), 
                        normalizeValue(r.ordersStockLvl),
                        normalizeValue(r.totalActive), 
                        normalizeValue(r.activeNoStockLvl), 
                        normalizeValue(r.activeStockLvl)
                    ]);

                    await mysqlConn.query(sql, [values]);
                    log.info(`Store: ${rows.length} registros procesados.`);
                    resolve();
                } catch (err) { reject(err); }
            });
    });
}

run();