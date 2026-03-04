// src/test-respondio-connection.js
/**
 * Script de prueba para verificar conectividad con Respond.io
 * 
 * Uso:
 *   node src/test-respondio-connection.js
 */

require('dotenv').config();
const axios = require('axios');

const RESPONDIO_ACCESS_TOKEN = process.env.RESPONDIO_ACCESS_TOKEN;
const RESPONDIO_API_URL = process.env.RESPONDIO_API_URL || 'https://api.respond.io/v2';

async function testConnection() {
  console.log('='.repeat(60));
  console.log('TEST DE CONEXIÓN A RESPOND.IO');
  console.log('='.repeat(60));
  console.log('');

  // Validar variables
  if (!RESPONDIO_ACCESS_TOKEN) {
    console.error('❌ ERROR: RESPONDIO_ACCESS_TOKEN no configurado en .env');
    process.exit(1);
  }

  console.log('✓ Variables de entorno configuradas');
  console.log(`  - API URL: ${RESPONDIO_API_URL}`);
  console.log(`  - Access Token: ${RESPONDIO_ACCESS_TOKEN.substring(0, 10)}...`);
  console.log('');

  try {
    console.log('→ Probando búsqueda de contactos con email test@example.com...');
    
    const response = await axios.get(`${RESPONDIO_API_URL}/contact/test@example.com`, {
      headers: {
        'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✓ Conexión exitosa!');
    console.log(`  - Status: ${response.status}`);
    console.log(`  - Contacto encontrado: ${response.data.firstName} ${response.data.lastName}`);
    console.log('');
    console.log('='.repeat(60));
    console.log('✓ PRUEBA COMPLETADA EXITOSAMENTE');
    console.log('='.repeat(60));

  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log('⚠ Contacto test@example.com no encontrado (esto es esperado)');
      console.log('✓ Conexión exitosa! El API responde correctamente');
      console.log('');
      console.log('='.repeat(60));
      console.log('✓ PRUEBA COMPLETADA EXITOSAMENTE');
      console.log('='.repeat(60));
      return;
    }

    console.error('❌ Error de conexión:');
    
    if (error.response) {
      console.error(`  - Status: ${error.response.status}`);
      console.error(`  - Message: ${error.response.statusText}`);
      console.error(`  - Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error('  - No se recibió respuesta del servidor');
      console.error(`  - Request: ${error.request}`);
    } else {
      console.error(`  - Error: ${error.message}`);
    }

    console.log('');
    console.log('Posibles soluciones:');
    console.log('  1. Verifica que RESPONDIO_ACCESS_TOKEN sea correcto');
    console.log('  2. Confirma que el Access Token sea válido');
    console.log('  3. Revisa la documentación: https://docs.respond.io/');
    console.log('');

    process.exit(1);
  }
}

testConnection();
