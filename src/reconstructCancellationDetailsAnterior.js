require('dotenv').config();
const createLogger = require('../helpers/logger');
const { getMySqlConnection } = require('../providers/dbConnections');

const LOG_NAME = `reconstructDetails_Historical_${new Date().toISOString().slice(0, 10)}.log`;
const log = createLogger(LOG_NAME);

async function run() {
    const startTime = Date.now();
    let mysqlConn;

    try {
        log.info('🚀 Iniciando reconstrucción de detalles históricos (Anterior al 2025-11-25)...');
        mysqlConn = await getMySqlConnection();

        // 1. Obtener la data del reporte con filtro de fecha estricto
        const [reportRows] = await mysqlConn.query(`
            SELECT 
                mfr, part_number, store_name, date, 
                total_units, total_price 
            FROM cancellation_details_report
            WHERE date < '2025-11-25' 
              AND total_units > 0
        `);

        if (reportRows.length === 0) {
            log.warn('⚠️ No se encontró data histórica previa al 25 de noviembre para reconstruir.');
            return;
        }

        log.info(`📊 Encontrados ${reportRows.length} registros históricos. Preparando inserción...`);

        // 2. Mapear datos a la estructura de la tabla destino
        const sql = `INSERT INTO cancellationdetails 
            (po, PartNumber, mfr, Unitstorefund, unitprice, refundedprice, Date, rnote, user) 
            VALUES ?`;

        const finalValues = reportRows.map((r, index) => {
            // PO ficticio para trazabilidad de reconstrucción
            const fakePo = `RECON-HIST-${index + 1}`;
            
            const units = parseFloat(r.total_units) || 0;
            const totalPrice = parseFloat(r.total_price) || 0;
            const estimatedUnitPrice = units > 0 ? (totalPrice / units) : 0;

            return [
                fakePo,
                r.part_number,
                r.mfr,
                units,
                estimatedUnitPrice,
                totalPrice,
                r.date,
                `Histórico reconstruido (Reporte: ${r.store_name})`,
                'SYSTEM_RECON_HIST'
            ];
        });

        // 3. Inserción por bloques para optimizar el rendimiento
        if (finalValues.length > 0) {
            const chunkSize = 1000;
            for (let i = 0; i < finalValues.length; i += chunkSize) {
                const chunk = finalValues.slice(i, i + chunkSize);
                await mysqlConn.query(sql, [chunk]);
                log.info(`📦 Bloque procesado: ${i + chunk.length} de ${finalValues.length}`);
            }
            log.info(`✅ Proceso finalizado. Se agregaron ${finalValues.length} detalles históricos.`);
        }

    } catch (err) {
        log.error('❌ Error durante la reconstrucción histórica:', err);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        log.info(`⏱️ Duración total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }
}

if (require.main === module) run();