const axios = require('axios');

const params = new URLSearchParams();
params.append('code', '1000.0761a09726b645fe58c678c23c2ef5a9.57b0f8959c3591552fb28ebda008a4f0');
params.append('client_id', '1000.3S1NRZDV4628EXLWC8K1LVF4W99YAF');
params.append('client_secret', 'TU_CLIENT_SECRET_AQUI'); // Pon el tuyo aquí
params.append('grant_type', 'authorization_code');
params.append('redirect_uri', 'https://api-console.zoho.com/');

axios.post('https://accounts.zoho.com/oauth/v2/token', params)
    .then(res => {
        console.log('--- REFRESH TOKEN GENERADO ---');
        console.log(res.data.refresh_token);
        console.log('------------------------------');
    })
    .catch(err => {
        console.error('Error:', err.response ? err.response.data : err.message);
    });