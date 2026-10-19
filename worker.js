// Cloudflare Workers entry: static files come from the assets binding, /api/* runs the Node server.
import { httpServerHandler } from 'cloudflare:node';
import './server/index.js';

export default httpServerHandler({ port: 4310 });
