// test-parts-availability.js
require('dotenv').config();
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.PARTS_AVAILABILITY_API_KEY;

if (!API_KEY) {
  console.error('❌ Error: PARTS_AVAILABILITY_API_KEY not found in .env');
  process.exit(1);
}

async function testHealthCheck() {
  console.log('\n🔍 Testing health check...');
  try {
    const response = await axios.get(`${API_URL}/health`);
    console.log('✅ Health check passed:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testUnauthorized() {
  console.log('\n🔍 Testing unauthorized access (no API key)...');
  try {
    await axios.post(`${API_URL}/v1/parts/availability/resolve`, {
      storeId: 5,
      locationId: 4,
      products: [{ brand: 'TEST', sku: 'TEST123' }]
    });
    console.error('❌ Should have returned 401');
    return false;
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Correctly returned 401:', error.response.data);
      return true;
    }
    console.error('❌ Unexpected error:', error.message);
    return false;
  }
}

async function testInvalidApiKey() {
  console.log('\n🔍 Testing with invalid API key...');
  try {
    await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5,
        locationId: 4,
        products: [{ brand: 'TEST', sku: 'TEST123' }]
      },
      {
        headers: { 'x-api-key': 'invalid_key' }
      }
    );
    console.error('❌ Should have returned 401');
    return false;
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Correctly returned 401:', error.response.data);
      return true;
    }
    console.error('❌ Unexpected error:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testMissingFields() {
  console.log('\n🔍 Testing with missing required fields...');
  try {
    await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5
        // Missing locationId and products
      },
      {
        headers: { 'x-api-key': API_KEY }
      }
    );
    console.error('❌ Should have returned 400');
    return false;
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✅ Correctly returned 400:', error.response.data);
      return true;
    }
    console.error('❌ Unexpected error:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testEmptyProducts() {
  console.log('\n🔍 Testing with empty products array...');
  try {
    await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5,
        locationId: 4,
        products: []
      },
      {
        headers: { 'x-api-key': API_KEY }
      }
    );
    console.error('❌ Should have returned 400');
    return false;
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✅ Correctly returned 400:', error.response.data);
      return true;
    }
    console.error('❌ Unexpected error:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testValidRequestWithSku() {
  console.log('\n🔍 Testing valid request with SKU...');
  try {
    const response = await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5,
        locationId: 4,
        products: [
          {
            brand: 'BRIGGS & STRATTON',
            sku: 'BRIGGS 492932S'
          }
        ]
      },
      {
        headers: { 'x-api-key': API_KEY }
      }
    );
    
    console.log('✅ Request successful');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    
    // Validate response structure
    const data = response.data;
    if (!data.success || !data.results || !Array.isArray(data.results)) {
      console.error('❌ Invalid response structure');
      return false;
    }
    
    const result = data.results[0];
    if (!result.input || !result.match || !result.inventory || !result.stockLevels) {
      console.error('❌ Missing required fields in result');
      return false;
    }
    
    console.log('✅ Response structure is valid');
    return true;
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testValidRequestWithMpn() {
  console.log('\n🔍 Testing valid request with MPN...');
  try {
    const response = await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5,
        locationId: 4,
        products: [
          {
            brand: 'BRIGGS & STRATTON',
            mpn: '492932S'
          }
        ]
      },
      {
        headers: { 'x-api-key': API_KEY }
      }
    );
    
    console.log('✅ Request successful');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function testBatchRequest() {
  console.log('\n🔍 Testing batch request with multiple products...');
  try {
    const response = await axios.post(
      `${API_URL}/v1/parts/availability/resolve`,
      {
        storeId: 5,
        locationId: 4,
        products: [
          {
            brand: 'BRIGGS & STRATTON',
            sku: 'BRIGGS 492932S'
          },
          {
            brand: 'BRIGGS & STRATTON',
            mpn: '492932S'
          },
          {
            brand: 'INVALID_BRAND',
            sku: 'INVALID_SKU'
          }
        ]
      },
      {
        headers: { 'x-api-key': API_KEY }
      }
    );
    
    console.log('✅ Batch request successful');
    console.log('Total results:', response.data.total);
    console.log('Results summary:');
    
    response.data.results.forEach((result, index) => {
      console.log(`  Product ${index + 1}: ${result.success ? '✅ Success' : '❌ Failed'} ${result.error ? `- ${result.error}` : ''}`);
    });
    
    return true;
  } catch (error) {
    console.error('❌ Batch request failed:', error.message);
    console.error('Full error:', error.response?.data || error);
    return false;
  }
}

async function runAllTests() {
  console.log('🚀 Starting API tests...');
  console.log(`API URL: ${API_URL}`);
  
  const tests = [
    { name: 'Health Check', fn: testHealthCheck },
    { name: 'Unauthorized Access', fn: testUnauthorized },
    { name: 'Invalid API Key', fn: testInvalidApiKey },
    { name: 'Missing Fields', fn: testMissingFields },
    { name: 'Empty Products', fn: testEmptyProducts },
    { name: 'Valid Request with SKU', fn: testValidRequestWithSku },
    { name: 'Valid Request with MPN', fn: testValidRequestWithMpn },
    { name: 'Batch Request', fn: testBatchRequest }
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const passed = await test.fn();
      results.push({ name: test.name, passed });
    } catch (error) {
      console.error(`❌ Test "${test.name}" threw an error:`, error.message);
      results.push({ name: test.name, passed: false });
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  
  results.forEach(result => {
    console.log(`${result.passed ? '✅' : '❌'} ${result.name}`);
  });
  
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  
  console.log('='.repeat(60));
  console.log(`Total: ${passedCount}/${totalCount} tests passed`);
  console.log('='.repeat(60));
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
