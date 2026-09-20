import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { CLIENT_DIST, PORT, requireCrewPassword } from './config.ts';
import { orderCount } from './db.ts';
import { requireCrew, sameOriginOnly } from './auth.ts';
import { publicRouter } from './routes/public.ts';
import { crewRouter } from './routes/crew.ts';
import { adminRouter } from './routes/admin.ts';
import { ApiError } from './validate.ts';

requireCrewPassword();

const app = express();
app.disable('x-powered-by');
// Behind no proxy by default; this keeps req.ip honest for the login throttle.
app.set('trust proxy', false);

// =========================================================================================
// THE WIRING ORDER BELOW IS THE CONTRACT. Several of these are load-bearing and fail in
// confusing ways out of order - the numbered comments say which and why.
// =========================================================================================

// 1. Body parsing. Far more than any request here needs.
app.use(express.json({ limit: '32kb' }));

// 2. Clock. Every response carries the server's idea of "now", so a client's offset stays
//    fresh even across 204s. A tablet whose clock is 40s fast would otherwise blink 40s
//    early, which means a burnt pizza.
app.use((_req, res, next) => {
  res.setHeader('X-Server-Now', String(Date.now()));
  next();
});

// 3. CSRF guard on every mutating request.
app.use(sameOriginOnly);

// 4. Request log. Order tokens are capabilities, so they never reach the log.
function redactUrl(url: string): string {
  return url.replace(/^\/api\/orders\/[^/?]+/, '/api/orders/<token>');
}
app.use((req, _res, next) => {
  if (req.method !== 'GET') console.log(`${req.method} ${redactUrl(req.originalUrl)}`);
  next();
});

// 5-7. Routers. ONE line of auth wiring each, so a new crew route is protected by default.
app.use('/api', publicRouter);
app.use('/api/crew', requireCrew, crewRouter);
app.use('/api/crew/admin', requireCrew, adminRouter);

// 8. JSON 404 for the API.
// MUST come after the routers. Registered before them it swallows the entire crew API with
// a plausible-looking JSON 404 that takes an hour to diagnose.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'not_found' } });
});

// 9. Static assets from the built client, when there is one.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite emits content-hashed filenames under /assets, so those are immutable.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // 10. SPA fallback.
  // EXPRESS 5: app.get('*') THROWS at startup (path-to-regexp v8 rejects a bare '*').
  // A terminal app.use is the supported shape.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    // Without no-cache, tablets happily run last month's JS after a redeploy.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res
      .status(503)
      .type('text/plain')
      .send('The client has not been built yet.\n\nDev:  npm run dev   (then use the Vite URL)\nProd: npm run serve\n');
  });
}

// 11. Terminal 4-arg error handler.
// Without it Express 5 renders an HTML error page and every tablet reports
// "Unexpected token '<'" on the mutation path.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    // Someone deleted the oven layer mid-drag. The client animates the card back to Unplaced.
    res.status(409).json({
      error: { code: 'layer_gone', message: 'That oven layer no longer exists.' },
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal' } });
});

app.listen(PORT, () => {
  console.log(`pizza-night: http://0.0.0.0:${PORT}  (${orderCount()} orders)`);
});
