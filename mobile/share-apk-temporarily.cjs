const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const apkPath = path.join(__dirname, '.phone-share', 'Stillwell.apk');
const address = process.env.PHONE_SHARE_ADDRESS;
const port = Number(process.env.PHONE_SHARE_PORT || 8765);

if (!address || !fs.existsSync(apkPath)) {
  throw new Error('Set PHONE_SHARE_ADDRESS and place Stillwell.apk in mobile/.phone-share/.');
}

const token = randomBytes(18).toString('hex');
const route = `/${token}/Stillwell.apk`;
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== route) {
    response.writeHead(404).end('Not found');
    return;
  }

  const size = fs.statSync(apkPath).size;
  response.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': 'attachment; filename="Stillwell.apk"',
    'Content-Length': size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(apkPath).pipe(response);
});

server.listen(port, address, () => {
  const url = `http://${address}:${port}${route}`;
  fs.writeFileSync(path.join(__dirname, '.phone-share', 'download-url.txt'), url);
  console.log(`Temporary APK link: ${url}`);
  console.log(`Server PID: ${process.pid}`);
});

const autoStop = setTimeout(() => server.close(() => process.exit(0)), 60 * 60 * 1000);
autoStop.unref();
