require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { getMySqlConnection } = require('../providers/dbConnections');

const app = express();
const port = 3001;

// Verificación inicial de credenciales
console.log("=== SERVIDOR INICIADO ===");
console.log("ORG ID:", process.env.ZOHO_ORG_ID);
console.log("DEPT ID:", process.env.ZOHO_DEPARTMENT_ID);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuración de Multer para recibir fotos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const toYN = (val) => (val === '1' || val === 1 || val === true || val === 'on' || val === 'y') ? 'YES' : 'NO';

/**
 * Función para interactuar con Zoho Desk
 * Devuelve el ID (para adjuntos) y el ticketNumber (para MySQL)
 */
async function createZohoTicket(data, files, returnId) {
    try {
        console.log(`>>> [ID ${returnId}] 1. Obteniendo Access Token...`);
        const tokenParams = new URLSearchParams({
            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });

        const authRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', tokenParams);
        const accessToken = authRes.data.access_token;

        console.log(`>>> [ID ${returnId}] 2. Creando ticket en Zoho...`);
        const htmlDescription = `
            <b>DETALLES DEL RETORNO</b><br>
            ---------------------------------------<br>
            <b>Orden # :</b> ${data.order_number}<br>
            <b>Parte # :</b> ${data.part_number}<br>
            <b>Razón :</b> ${data.return_reason}<br><br>
            <b>VALIDACIONES</b><br>
            ---------------------------------------<br>
            <b>En 30 días :</b> ${toYN(data.is_last_30_days)}<br>
            <b>Empaque Original :</b> ${toYN(data.is_original_pkg)}<br>
            <b>Electrónico :</b> ${toYN(data.is_electronic)}
        `;

        const ticketRes = await axios.post('https://desk.zoho.com/api/v1/tickets', {
            subject: `Return Request: Order #${data.order_number}`,
            departmentId: process.env.ZOHO_DEPARTMENT_ID,
            contact: { lastName: data.customer_name || 'Customer', email: data.customer_email },
            description: htmlDescription,
            channel: 'Web'
        }, { 
            headers: { 
                'Authorization': `Zoho-oauthtoken ${accessToken}`, 
                'orgId': String(process.env.ZOHO_ORG_ID).trim() 
            } 
        });

        const zohoId = ticketRes.data.id;
        const zohoNumber = ticketRes.data.ticketNumber; // Este es el que guardaremos
        console.log(`✅ [ID ${returnId}] Ticket Zoho #${zohoNumber} CREADO.`);

        // Adjuntar archivos si existen
        if (files && files.length > 0) {
            console.log(`>>> [ID ${returnId}] 3. Subiendo ${files.length} adjuntos...`);
            for (const file of files) {
                const form = new FormData();
                form.append('file', file.buffer, { filename: file.originalname });
                
                await axios.post(`https://desk.zoho.com/api/v1/tickets/${zohoId}/attachments`, form, {
                    headers: { 
                        ...form.getHeaders(), 
                        'Authorization': `Zoho-oauthtoken ${accessToken}`, 
                        'orgId': String(process.env.ZOHO_ORG_ID).trim() 
                    }
                });
            }
            console.log(`📎 [ID ${returnId}] Adjuntos subidos.`);
        }

        return { id: zohoId, ticketNumber: zohoNumber };

    } catch (err) {
        console.error(`❌ [ID ${returnId}] ERROR ZOHO:`, err.response ? JSON.stringify(err.response.data) : err.message);
        return null;
    }
}

app.post('/submit-return', upload.array('images', 10), async (req, res) => {
    let mysqlConn;
    try {
        mysqlConn = await getMySqlConnection();
        
        // 1. Inserción inicial en MySQL
        const [result] = await mysqlConn.execute(
            `INSERT INTO returns (order_number, part_number, customer_email, customer_name, return_reason, is_last_30_days, is_original_pkg, is_electronic) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.body.order_number, 
                req.body.part_number, 
                req.body.customer_email, 
                req.body.customer_name, 
                req.body.return_reason,
                toYN(req.body.is_last_30_days) === 'YES' ? 'y' : 'n',
                toYN(req.body.is_original_pkg) === 'YES' ? 'y' : 'n',
                toYN(req.body.is_electronic) === 'YES' ? 'y' : 'n'
            ]
        );

        const returnId = result.insertId;
        console.log(`✅ [ID ${returnId}] Guardado en MySQL.`);

        // 2. Guardar copias locales de las fotos
        if (req.files && req.files.length > 0) {
            const uploadPath = path.join(__dirname, '../uploads/returns');
            if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
            
            req.files.forEach(file => {
                const safeName = `return-${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
                fs.writeFileSync(path.join(uploadPath, safeName), file.buffer);
            });
        }

        // 3. Crear Ticket en Zoho y esperar respuesta (AWAIT)
        const zohoResult = await createZohoTicket(req.body, req.files || [], returnId);

        if (zohoResult && zohoResult.ticketNumber) {
            // 4. Actualizar MySQL con el TICKET NUMBER
            await mysqlConn.execute(
                `UPDATE returns SET zoho_ticket_id = ? WHERE id = ?`,
                [zohoResult.ticketNumber, returnId]
            );
            console.log(`✅ [ID ${returnId}] MySQL actualizado con Ticket #${zohoResult.ticketNumber}`);
        }

        // 5. Responder al cliente
        res.status(200).json({ 
            success: true, 
            id: returnId, 
            zohoTicket: zohoResult ? zohoResult.ticketNumber : null 
        });

    } catch (err) {
        console.error('❌ ERROR GENERAL:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    } finally {
        if (mysqlConn) await mysqlConn.end();
    }
});

app.listen(port, () => {
    console.log(`Servidor activo en puerto ${port}`);
});