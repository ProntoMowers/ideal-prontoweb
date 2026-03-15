// Script de prueba para crear un contacto en Respond.io
require('dotenv').config();
const axios = require('axios');

const RESPONDIO_ACCESS_TOKEN = process.env.RESPONDIO_ACCESS_TOKEN;
const RESPONDIO_API_URL = process.env.RESPONDIO_API_URL || 'https://api.respond.io/v2';

async function testCreateContact() {
  console.log('='.repeat(60));
  console.log('TEST: CREAR CONTACTO EN RESPOND.IO');
  console.log('='.repeat(60));
  console.log('');

  if (!RESPONDIO_ACCESS_TOKEN) {
    console.error('❌ ERROR: RESPONDIO_ACCESS_TOKEN no configurado');
    process.exit(1);
  }

  const timestamp = Date.now();
  const email = `test-${timestamp}@example.com`;
  const testContact = {
    firstName: 'Test',
    lastName: 'Usuario',
    phone: '+60123456789'
  };

  console.log('→ Intentando crear contacto de prueba...');
  console.log(`  Email (identifier): ${email}`);
  console.log('');

  try {
    const response = await axios.post(
      `${RESPONDIO_API_URL}/contact/${email}`,
      testContact,
      {
        headers: {
          'Authorization': `Bearer ${RESPONDIO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✓ ¡Contacto creado exitosamente!');
    console.log(`  - Status: ${response.status}`);
    console.log(`  - ID del contacto: ${response.data.id}`);
    console.log(`  - Nombre: ${response.data.firstName} ${response.data.lastName}`);
    console.log('');
    console.log('='.repeat(60));
    console.log('✓ PRUEBA COMPLETADA EXITOSAMENTE');
    console.log('='.repeat(60));
    console.log('');
    console.log('Verifica el contacto en Respond.io en la sección de Contacts');
    console.log(`Busca por: ${email}`);

  } catch (error) {
    console.error('❌ Error al crear contacto:');
    console.error('');

    if (error.response) {
      console.error(`  Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`  Data: ${JSON.stringify(error.response.data, null, 2)}`);
      
      if (error.response.status === 401) {
        console.error('');
        console.error('→ El Access Token no es válido o ha expirado');
        console.error('  Genera uno nuevo en: https://app.respond.io/space/383380/settings/integrations/developer-api');
      } else if (error.response.status === 403) {
        console.error('');
        console.error('→ El Access Token no tiene permisos para crear contactos');
      } else if (error.response.status === 404) {
        console.error('');
        console.error('→ El endpoint no existe. Verifica que RESPONDIO_API_URL sea correcto');
        console.error(`  Actual: ${RESPONDIO_API_URL}`);
        console.error(`  Debe ser: https://api.respond.io/v2`);
      }
    } else if (error.request) {
      console.error('  No se recibió respuesta del servidor');
      console.error(`  Verifica la conexión a internet y la URL: ${RESPONDIO_API_URL}`);
    } else {
      console.error(`  ${error.message}`);
    }

    console.error('');
    process.exit(1);
  }
}

testCreateContact();
