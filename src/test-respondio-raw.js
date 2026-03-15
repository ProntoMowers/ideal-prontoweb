// Test directo con curl para debug
require('dotenv').config();
const axios = require('axios');

const TOKEN = process.env.RESPONDIO_ACCESS_TOKEN;

async function testRaw() {
  console.log('Testing Respond.io API...\n');
  
  // Intentar varios endpoints posibles
  const endpoints = [
    'https://api.respond.io/v2/contact',
    'https://api.respond.io/v2/contacts',
    'https://api.respond.io/contact',
    'https://api.respond.io/contacts'
  ];

  for (const endpoint of endpoints) {
    console.log(`→ Probando: ${endpoint}`);
    try {
      const response = await axios.get(endpoint, {
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json'
        },
        params: { limit: 1 }
      });
      console.log(`  ✓ Success! Status: ${response.status}`);
      console.log(`  Data keys: ${Object.keys(response.data).join(', ')}\n`);
      return;
    } catch (error) {
      if (error.response) {
        console.log(`  ✗ ${error.response.status}: ${error.response.statusText}`);
      } else {
        console.log(`  ✗ ${error.message}`);
      }
    }
  }
}

testRaw();
