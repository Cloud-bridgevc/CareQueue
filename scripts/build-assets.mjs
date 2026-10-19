// Lays out static files the way server/index.js serves them, for Cloudflare Workers Static Assets.
import { cp, rm, writeFile } from 'node:fs/promises';

const OUT = 'dist';
await rm(OUT, { recursive: true, force: true });
await cp('public/site', OUT, { recursive: true });
await cp('public/app', `${OUT}/app`, { recursive: true });
await cp('public/assets', `${OUT}/assets`, { recursive: true });
await cp('shared', `${OUT}/shared`, { recursive: true });
await writeFile(`${OUT}/_headers`, `/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
  Cache-Control: no-cache
`);
console.log(`Static assets written to ${OUT}/`);
