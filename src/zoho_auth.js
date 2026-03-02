const axios = require('axios');

const params = new URLSearchParams();
// 1. PEGA AQUÍ EL CÓDIGO NUEVO QUE GENERES AHORA MISMO
params.append('code', '1000.18871865ab5117d11a43f3b7f4c08d43.0eb1c1ff2b52fecfbf61159e634f71b6'); 
params.append('client_id', '1000.3S1NRZDV4628EXLWC8K1LVF4W99YAF');
// 2. PEGA AQUÍ EL CLIENT SECRET LARGO (EL QUE EMPIEZA CON 4398...)
params.append('client_secret', '43988098488a554167bf0d0cd47cdf34c41b440c64'); 
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