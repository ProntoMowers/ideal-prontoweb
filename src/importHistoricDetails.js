require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync'); 
const { getMySqlConnection } = require('../providers/dbConnections');

/**
 * Convierte fechas de formato M/D/YYYY a YYYY-MM-DD para MySQL
 */
function formatToMySQLDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') return null;
    
    // Divide la fecha por "/" o "-"
    const parts = dateStr.split(/[\/\-]/);
    if (parts.length !== 3) return dateStr; // Retorna original si no coincide

    let month = parts[0].padStart(2, '0');
    let day = parts[1].padStart(2, '0');
    let year = parts[2];

    // Maneja casos de años de 2 dígitos si fuera necesario
    if (year.length === 2) year = '20' + year;

    return `${year}-${month}-${day}`;
}

async function main() {
    console.log('📂 Iniciando restauración de historial...');
    
    let mysqlConn;
    try {
        mysqlConn = await getMySqlConnection();

        const csvPath = path.join(__dirname, '../historico_cancelaciones.csv');
        if (!fs.existsSync(csvPath)) {
            throw new Error(`Archivo no encontrado en: ${csvPath}`);
        }

        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const records = parse(fileContent, {
            columns: true, 
            skip_empty_lines: true, 
            trim: true
        });

        console.log(`📊 Registros detectados: ${records.length}`);

        // Mapeo con transformación de fecha
        const values = records.map((r, index) => {
            const cleanDate = formatToMySQLDate(r.Date);
            return [
                r.mfr, 
                r.partNumber, 
                r.storeName, 
                r.reason, 
                cleanDate, 
                r.total_units, 
                r.total_price
            ];
        });

        // Inserción por lotes para evitar saturar la conexión con 51k registros
        const batchSize = 5000;
        let inserted = 0;

        for (let i = 0; i < values.length; i += batchSize) {
            const batch = values.slice(i, i + batchSize);
            const sql = `INSERT INTO cancellation_details_report 
                         (mfr, part_number, store_name, reason, date, total_units, total_price) 
                         VALUES ?`;
            
            const [result] = await mysqlConn.query(sql, [batch]);
            inserted += result.affectedRows;
            console.log(`⏳ Progreso: ${inserted}/${values.length} filas...`);
        }

        console.log(`✅ ¡Éxito! Se insertaron ${inserted} filas históricas correctamente.`);

    } catch (error) {
        console.error('❌ Error durante la importación:', error.message);
    } finally {
        if (mysqlConn) await mysqlConn.end();
    }
}

main();