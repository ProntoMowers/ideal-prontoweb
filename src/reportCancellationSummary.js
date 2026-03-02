require('dotenv').config();
const { getMySqlConnection, getMssqlConnection } = require('../providers/dbConnections');
const mssql = require('mssql');
const fs = require('fs');
const path = require('path');

const getLogger = (name) => {
    const logDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `${name}-${dateStr}.log`);
    const log = (level, msg) => {
        const time = new Date().toLocaleString();
        const line = `[${time}] [${level}] ${msg}\n`;
        fs.appendFileSync(logFile, line);
        console.log(line.trim());
    };
    return {
        info: (msg) => log('INFO', msg),
        warn: (msg) => log('WARN', msg),
        error: (msg) => log('ERROR', msg)
    };
};

const logger = getLogger('reportCancellationSummary');

// --- Helpers de Extracción de Datos ---

async function fetchSales(mssqlPool, storeIDSW, fromDate, toDate) {
    const query = `
        SELECT 
            COUNT(DISTINCT OrderID) as sales_qty,
            SUM(OrderTotal) as sales_usd
        FROM [Order]
        WHERE StoreID = @storeID
          AND OrderDate BETWEEN @from AND @to
          AND LocalStatus NOT IN ('Cancelled', 'Voided')
    `;
    const result = await mssqlPool.request()
        .input('storeID', mssql.Int, storeIDSW)
        .input('from', mssql.DateTime, fromDate)
        .input('to', mssql.DateTime, toDate)
        .query(query);
    return result.recordset;
}

async function fetchCancellations(mysqlConn, storePrefix, fromDate, toDate) {
    const sql = `
        SELECT 
            reason, type AS cancel_type, user AS user_cancel,
            COUNT(*) AS cancellation_qty,
            SUM(CAST(ordervalue AS DECIMAL(18,2))) AS cancellation_usd
        FROM cancellations
        WHERE LEFT(po, 5) = ?
          AND date BETWEEN ? AND ?
        GROUP BY reason, cancel_type, user_cancel
    `;
    const [rows] = await mysqlConn.query(sql, [storePrefix, fromDate, toDate]);
    return rows;
}

// --- Funciones de Utilidad ---

function getDateDimensions(dateStr) {
    const dateObj = new Date(dateStr);
    const monthNum = dateObj.getMonth() + 1;
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return {
        quarter: Math.floor((monthNum - 1) / 3) + 1,
        monthNumber: monthNum,
        monthName: names[monthNum - 1],
        monthShortName: names[monthNum - 1].substring(0, 3)
    };
}

function getFirstAndLastDay(year, month) {
    const lastDay = new Date(year, month, 0).getDate();
    const mm = month.toString().padStart(2, '0');
    return {
        fromDateWithTime: `${year}-${mm}-01 00:00:00`,
        toDateWithTime: `${year}-${mm}-${lastDay} 23:59:59`,
        fromDateNoTime: `${year}-${mm}-01`,
        toDateNoTime: `${year}-${mm}-${lastDay}`
    };
}

// --- Proceso Principal ---

async function main() {
    logger.info('🚀 Iniciando Reporte Global y Detalle de Cancelaciones (Modo Protegido)');
    
    let mysqlConn;
    let mssqlPool;

    // FECHA DE CORTE PARA PROTEGER RESPALDO
    const CUTOFF_DATE = '2025-12-01 00:00:00';

    try {
        mysqlConn = await getMySqlConnection();
        mssqlPool = await getMssqlConnection();

        // 1. PROCESO DE RESUMEN (cancellation_statistics_summary)
        const [stores] = await mysqlConn.query(
            "SELECT PREFIJO, DESCRIPTION AS store_name, StoreIDSW FROM stores WHERE StoreIDSW IS NOT NULL"
        );

        if (stores.length === 0) {
            logger.warn('⚠️ No hay tiendas con StoreIDSW configurado.');
        } else {
            // PROTECCIÓN: Solo borrar data nueva
            await mysqlConn.query('DELETE FROM cancellation_statistics_summary WHERE report_date >= ?', [CUTOFF_DATE]);
            logger.info(`Limpieza selectiva completada: Se eliminó data de resumen >= ${CUTOFF_DATE}`);

            const today = new Date();
            // AJUSTE: Empezar desde el mes de la fecha de corte para no procesar el pasado huérfano
            let cursor = new Date('2025-11-01'); 
            const summaryData = [];

            while (cursor <= today) {
                const year = cursor.getFullYear();
                const month = cursor.getMonth() + 1;
                const dates = getFirstAndLastDay(year, month);
                const dims = getDateDimensions(dates.fromDateWithTime);

                for (const store of stores) {
                    const sales = await fetchSales(mssqlPool, store.StoreIDSW, dates.fromDateWithTime, dates.toDateWithTime);
                    summaryData.push([
                        store.PREFIJO, store.store_name, dates.toDateWithTime,
                        year, dims.quarter, dims.monthNumber, dims.monthName, dims.monthShortName,
                        null, null, null, sales[0]?.sales_qty || 0, 0, sales[0]?.sales_usd || 0, 0
                    ]);

                    const cancels = await fetchCancellations(mysqlConn, store.PREFIJO, dates.fromDateNoTime, dates.toDateNoTime);
                    for (const c of cancels) {
                        summaryData.push([
                            store.PREFIJO, store.store_name, dates.toDateWithTime,
                            year, dims.quarter, dims.monthNumber, dims.monthName, dims.monthShortName,
                            c.reason, c.cancel_type, c.user_cancel,
                            0, c.cancellation_qty, 0, c.cancellation_usd
                        ]);
                    }
                }
                cursor.setMonth(cursor.getMonth() + 1);
            }

            if (summaryData.length > 0) {
                // Filtrar el array para asegurar que no insertamos duplicados del pasado si el cursor retrocedió demasiado
                const filteredData = summaryData.filter(row => row[2] >= CUTOFF_DATE);
                if (filteredData.length > 0) {
                    await mysqlConn.query(`INSERT INTO cancellation_statistics_summary VALUES ?`, [filteredData]);
                    logger.info('✅ Tabla de resumen actualizada (solo periodos nuevos).');
                }
            }
        }

        // 2. PROCESO DE DETALLE POR PRODUCTO (cancellation_details_report)
        logger.info('📊 Generando detalle de cancelaciones por Marca y SKU...');
        
        // PROTECCIÓN: Solo borrar data nueva del detalle
        await mysqlConn.query('DELETE FROM cancellation_details_report WHERE date >= ?', [CUTOFF_DATE]);
        logger.info(`Limpieza selectiva completada: Se eliminó detalle de productos >= ${CUTOFF_DATE}`);

        const sqlDetails = `
            SELECT 
                cd.mfr,
                cd.PartNumber as part_number,
                s.DESCRIPTION as store_name,
                c.reason,
                cd.Date as date,
                SUM(cd.Unitstorefund) as total_units,
                SUM(cd.refundedprice) as total_price
            FROM cancellationdetails cd
            JOIN cancellations c ON cd.po = c.po
            JOIN stores s ON LEFT(cd.po, 5) = s.PREFIJO
            WHERE cd.Date >= ?
            GROUP BY cd.mfr, cd.PartNumber, s.DESCRIPTION, c.reason, cd.Date
        `;

        const [detailsRows] = await mysqlConn.query(sqlDetails, [CUTOFF_DATE]);

        if (detailsRows.length > 0) {
            const finalDetails = detailsRows.map(r => [
                r.mfr, r.part_number, r.store_name, r.reason, r.date, r.total_units, r.total_price
            ]);

            await mysqlConn.query(`
                INSERT INTO cancellation_details_report 
                (mfr, part_number, store_name, reason, date, total_units, total_price) 
                VALUES ?`, [finalDetails]);
            
            logger.info(`✅ Detalle actualizado: ${finalDetails.length} productos procesados.`);
        }

        logger.info('🏁 Todo el proceso se completó con éxito sin afectar el respaldo histórico.');

    } catch (error) {
        logger.error(`❌ Error crítico: ${error.message}`);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        if (mssqlPool) await mssqlPool.close();
    }
}

main();