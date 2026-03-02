require('dotenv').config();
const path = require('path');
const fs = require('fs');
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `reconstructCancellations_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

async function run() {
    const startTime = Date.now();
    let mysqlConn;

    try {
        log.info('🚀 Iniciando reconstrucción selectiva (Solo data estrictamente anterior al 2025-11-25)...');
        mysqlConn = await getMySqlConnection();

        // 1. Obtener la data de la tabla de resumen con filtro estrictamente menor (<)
        const [summaryRows] = await mysqlConn.query(`
            SELECT 
                store_prefix, store_name, report_date, reason, 
                cancel_type, user_cancel, cancellation_qty, cancellation_usd
            FROM cancellation_statistics_summary
            WHERE cancellation_qty > 0 
              AND report_date < '2025-11-25'
        `);

        if (summaryRows.length === 0) {
            log.warn('No se encontró data previa al 25 de noviembre para reconstruir.');
            return;
        }

        log.info(`Encontrados ${summaryRows.length} grupos de registros previos. Preparando inserción...`);

        // 2. Preparar los datos para la tabla cancellations
        const sql = `INSERT INTO cancellations 
            (po, reason, type, user, date, ordervalue, note) 
            VALUES ?`;

        const finalValues = summaryRows.map((r, index) => {
            // El PO lleva el prefijo de la tienda + identificador de reconstrucción
            const fakePo = `${r.store_prefix}-RECON-${index + 1}`;
            
            return [
                fakePo,
                r.reason || 'DATA RECONSTRUCTED',
                r.cancel_type || 'Total',
                r.user_cancel || 'SYSTEM_RECON',
                r.report_date,
                r.cancellation_usd || 0,
                'Registro histórico reconstruido (Anterior al 25 de Nov 2025)'
            ];
        });

        // 3. Inserción por bloques para seguridad
        if (finalValues.length > 0) {
            const chunkSize = 1000;
            for (let i = 0; i < finalValues.length; i += chunkSize) {
                const chunk = finalValues.slice(i, i + chunkSize);
                await mysqlConn.query(sql, [chunk]);
            }
            log.info(`✅ Se han agregado ${finalValues.length} registros anteriores al 25-Nov a la tabla cancellations.`);
        }

    } catch (err) {
        log.error('❌ Error durante la reconstrucción', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) run();