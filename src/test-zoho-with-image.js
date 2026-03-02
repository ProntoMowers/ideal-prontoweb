require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

async function runFullTest() {
    console.log("=== PRUEBA DE ZOHO: TICKET + IMAGEN DESDE /MEDIA ===");
    
    try {
        // 1. Obtener Access Token
        console.log("1. Solicitando Access Token...");
        const tokenParams = new URLSearchParams({
            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });
        const authRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', tokenParams);
        const accessToken = authRes.data.access_token;
        console.log("✅ Token obtenido.");

        // 2. Crear el Ticket
        console.log("2. Creando ticket en Zoho Desk...");
        const ticketRes = await axios.post('https://desk.zoho.com/api/v1/tickets', {
            subject: "TEST FINAL: Ticket con imagen desde /media",
            departmentId: process.env.ZOHO_DEPARTMENT_ID,
            contact: { lastName: "Tester", email: "mario.prontomowers@gmail.com" },
            description: "Validando que la ruta ../media/ funciona correctamente.",
            channel: "Web"
        }, {
            headers: {
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                'orgId': String(process.env.ZOHO_ORG_ID).trim()
            }
        });

        const zohoId = ticketRes.data.id;
        console.log(`✅ Ticket #${zohoId} creado.`);

        // 3. Adjuntar imagen (Ruta: Subir desde src/ a raíz y entrar a media/)
        const imagePath = path.join(__dirname, '..', 'data', 'return-test.jpg');
        
        if (fs.existsSync(imagePath)) {
            console.log(`3. Adjuntando archivo: ${imagePath}...`);
            const form = new FormData();
            // Usamos stream para archivos físicos en scripts locales
            form.append('file', fs.createReadStream(imagePath));

            await axios.post(`https://desk.zoho.com/api/v1/tickets/${zohoId}/attachments`, form, {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                    'orgId': String(process.env.ZOHO_ORG_ID).trim()
                }
            });
            console.log("✅ Imagen adjuntada con éxito.");
        } else {
            console.error(`❌ Error de ruta: El archivo NO existe en ${imagePath}`);
        }

        console.log("\n=== PRUEBA COMPLETADA ===");
        console.log(`Verifica el ticket ${zohoId} en tu panel de Zoho.`);

    } catch (err) {
        console.error("\n❌ ERROR DETECTADO:");
        if (err.response) {
            console.error("Status:", err.response.status);
            console.error("Detalle:", JSON.stringify(err.response.data));
        } else {
            console.error("Mensaje:", err.message);
        }
    }
}

runFullTest();