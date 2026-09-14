import { constants, readFileSync, realpathSync, lstatSync, openSync, fstatSync, closeSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

/** Serve only explicit public build files; never fall through API requests to HTML. */
export function serveStatic(req, res, pathname, staticDir, privateDir) {
  if (!staticDir || !['GET', 'HEAD'].includes(req.method) || pathname === '/api' || pathname.startsWith('/api/')) return false;
  let fd;
  try {
    const decoded = decodeURIComponent(pathname);
    const parts = decoded.split('/').filter(Boolean);
    if (decoded.includes('\\') || decoded.includes('\0') || parts.some(part => part.startsWith('.'))) return false;
    if (!parts.length) parts.push('index.html');
    if (lstatSync(resolve(staticDir)).isSymbolicLink()) return false;
    const root = realpathSync(resolve(staticDir));
    let file = root;
    for (const part of parts) {
      file = join(file, part);
      if (lstatSync(file).isSymbolicLink()) return false;
    }
    const canonical = realpathSync(file);
    if (!isWithin(root, canonical) || (privateDir && isWithin(privateDir, canonical))) return false;
    const publicNotice = decoded === '/THIRD_PARTY_NOTICES.txt'
      || /^\/fonts\/[a-z0-9-]+\/LICENSE\.txt$/u.test(decoded);
    const type = publicNotice ? 'text/plain; charset=utf-8' : TYPES[extname(file).toLowerCase()];
    if (!type) return false;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024) return false;
    const body = req.method === 'HEAD' ? undefined : readFileSync(fd);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
