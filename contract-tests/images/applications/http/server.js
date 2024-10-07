// server.js

const http = require('http');

const PORT = 8080;
const NETWORK_ALIAS = 'backend';
const SUCCESS = 'success';
const ERROR = 'error';
const FAULT = 'fault';

const server = http.createServer((req, res) => {
  const method = req.method;
  const url = req.url;

  // Helper function to check if a substring is in the path
  const inPath = (subPath) => url.includes(subPath);

  if (inPath(`/${NETWORK_ALIAS}`)) {
    let statusCode;
    if (inPath(`/${SUCCESS}`)) {
      statusCode = 200;
    } else if (inPath(`/${ERROR}`)) {
      statusCode = 400;
    } else if (inPath(`/${FAULT}`)) {
      statusCode = 500;
    } else {
      statusCode = 404;
    }
    res.writeHead(statusCode);
    res.end();
  } else {
    // Forward the request to http://backend:8080/backend{original_path}
    const options = {
      hostname: NETWORK_ALIAS,
      port: PORT,
      // port: 9090,
      path: `/${NETWORK_ALIAS}${url}`,
      method: method,
      headers: req.headers,
      timeout: 20000, // 20 seconds timeout
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      res.writeHead(500);
      res.end('Proxy error');
    });

    req.pipe(proxyReq, { end: true });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Ready');
});
