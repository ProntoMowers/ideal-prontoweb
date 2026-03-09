// services/returnsService.js
const { getMySqlConnection } = require('../providers/dbConnections');
const logger = require('../helpers/logger')('returnsService.log');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');

/**
 * Create a Zoho Desk ticket for the return
 */
async function createZohoTicket(data, files, returnId) {
  try {
    logger.info(`[ID ${returnId}] Getting Zoho access token...`);
    
    const tokenParams = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const authRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', tokenParams);
    const accessToken = authRes.data.access_token;

    logger.info(`[ID ${returnId}] Creating Zoho ticket...`);
    
    const htmlDescription = `
      <b>DETALLES DEL RETORNO</b><br>
      ---------------------------------------<br>
      <b>Orden # :</b> ${data.order_number}<br>
      <b>Número de Parte:</b> ${data.part_number}<br>
      <b>Email:</b> ${data.customer_email}<br>
      <b>Nombre:</b> ${data.customer_name}<br>
      <b>Razón:</b> ${data.return_reason}<br>
      <b>Últimos 30 días?:</b> ${data.is_last_30_days === 'y' ? 'YES' : 'NO'}<br>
      <b>Empaque original?:</b> ${data.is_original_pkg === 'y' ? 'YES' : 'NO'}<br>
      <b>Producto electrónico?:</b> ${data.is_electronic === 'y' ? 'YES' : 'NO'}<br>
    `;

    const ticketBody = {
      subject: `Return Request - Order #${data.order_number}`,
      departmentId: process.env.ZOHO_DEPARTMENT_ID,
      contactId: null,
      email: data.customer_email,
      description: htmlDescription,
      category: 'Returns',
      status: 'Open'
    };

    const ticketRes = await axios.post(
      `https://desk.zoho.com/api/v1/tickets`,
      ticketBody,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'orgId': process.env.ZOHO_ORG_ID,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticketId = ticketRes.data.id;
    const ticketNumber = ticketRes.data.ticketNumber;
    
    logger.info(`[ID ${returnId}] Ticket created: #${ticketNumber} (ID: ${ticketId})`);

    // Attach images if present
    if (files && files.length > 0) {
      logger.info(`[ID ${returnId}] Attaching ${files.length} images...`);
      
      for (const file of files) {
        const form = new FormData();
        form.append('file', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype
        });

        await axios.post(
          `https://desk.zoho.com/api/v1/tickets/${ticketId}/attachments`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
              'orgId': process.env.ZOHO_ORG_ID
            }
          }
        );
      }
      
      logger.info(`[ID ${returnId}] Images attached successfully`);
    }

    return { ticketId, ticketNumber };

  } catch (error) {
    logger.error(`[ID ${returnId}] Zoho ticket creation failed`, error);
    throw new Error(`Failed to create Zoho ticket: ${error.message}`);
  }
}

/**
 * Process a return submission
 */
async function processReturn(returnData, files, originalData) {
  let mysqlConn;
  
  try {
    mysqlConn = await getMySqlConnection();
    
    // 1. Insert into MySQL
    logger.info('Inserting return into database...');
    
    const [result] = await mysqlConn.execute(
      `INSERT INTO returns (order_number, part_number, customer_email, customer_name, return_reason, is_last_30_days, is_original_pkg, is_electronic) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnData.order_number,
        returnData.part_number,
        returnData.customer_email,
        returnData.customer_name,
        returnData.return_reason,
        returnData.is_last_30_days,
        returnData.is_original_pkg,
        returnData.is_electronic
      ]
    );

    const returnId = result.insertId;
    logger.info(`Return saved to database with ID: ${returnId}`);

    // 2. Save local copies of images
    if (files && files.length > 0) {
      const uploadPath = path.join(__dirname, '../uploads/returns');
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      
      files.forEach(file => {
        const safeName = `return-${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
        fs.writeFileSync(path.join(uploadPath, safeName), file.buffer);
      });
      
      logger.info(`${files.length} images saved locally`);
    }

    // 3. Create Zoho ticket
    const zohoResult = await createZohoTicket(originalData, files, returnId);

    // 4. Update MySQL with Zoho ticket number
    if (zohoResult && zohoResult.ticketNumber) {
      await mysqlConn.execute(
        `UPDATE returns SET zoho_ticket_id = ? WHERE id = ?`,
        [zohoResult.ticketNumber, returnId]
      );
      logger.info(`MySQL updated with Zoho ticket #${zohoResult.ticketNumber}`);
    }

    return {
      id: returnId,
      zohoTicket: zohoResult ? zohoResult.ticketNumber : null
    };

  } catch (error) {
    logger.error('Error processing return', error);
    throw error;
  } finally {
    if (mysqlConn) {
      await mysqlConn.end();
    }
  }
}

module.exports = {
  processReturn
};
