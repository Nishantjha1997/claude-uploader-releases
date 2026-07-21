const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const tar = require('tar');

const VERSION = '20.0.17';
const PACKAGES = [
  {
    platform: 'win32-x64', package: 'ccusage-win32-x64', file: 'ccusage.exe',
    integrity: 'y+rbb5D3lUQwu6kKtRk2yVGZn3Az3+9TipRQAyk9vs+K4hp3TM+ToqciVRAZ3u+tap5VhPSj2bZt4J6gGXg18w=='
  },
  {
    platform: 'darwin-x64', package: 'ccusage-darwin-x64', file: 'ccusage',
    integrity: 'FyNVZ1I7LZpkuIXB/pUE+e7OiUeEKKM1h/3Sq0bfq+zZL2SIGmWLTH5RiANcVFIhlEJYE2J2g32z2wy6zYJ9vQ=='
  },
  {
    platform: 'darwin-arm64', package: 'ccusage-darwin-arm64', file: 'ccusage',
    integrity: 'rQTuzovMtfbtBAmEMmC8ABzkd66E+jJI+E+WJ/MbEeRTGS/7cL50BpP0jI87FWTbGoY/ovlSV6gcmFyd+EvzXA=='
  },
  {
    platform: 'linux-x64', package: 'ccusage-linux-x64', file: 'ccusage',
    integrity: 'o9CFzPbRT+WEyhKV6Y0GUdxcxdrRnToBY7qclXMe+doKon4gjzZvAzHXR6qao/ZHdfg6cmLkGvBJx5ZcG/8bEw=='
  },
];

function download(url, destination, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ClaudeUsageUploader-build' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirectsLeft === 0) return reject(new Error(`Bad redirect for ${url}`));
        return download(new URL(res.headers.location, url).toString(), destination, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (${res.statusCode}): ${url}`));
      }
      const out = fs.createWriteStream(destination);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function prepare(item) {
  const url = `https://registry.npmjs.org/@ccusage/${item.package}/-/${item.package}-${VERSION}.tgz`;
  const temp = path.join(os.tmpdir(), `${item.package}-${VERSION}.tgz`);
  await download(url, temp);
  const digest = crypto.createHash('sha512').update(await fsp.readFile(temp)).digest('base64');
  if (digest !== item.integrity) throw new Error(`Integrity mismatch for ${item.platform}`);

  const destination = path.resolve(__dirname, '..', 'vendor', item.platform);
  await fsp.mkdir(destination, { recursive: true });
  await tar.x({
    file: temp,
    cwd: destination,
    strip: 2,
    filter: entry => entry === `package/bin/${item.file}`,
  });
  const output = path.join(destination, item.file);
  if (!fs.existsSync(output)) throw new Error(`Missing extracted tool: ${output}`);
  if (item.file !== 'ccusage.exe') await fsp.chmod(output, 0o755);
  await fsp.unlink(temp).catch(() => {});
  console.log(`${item.platform}: ${fs.statSync(output).size} bytes`);
}

Promise.all(PACKAGES.map(prepare)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
