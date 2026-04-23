// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { BwMem } from '../bwmem.js';
import { PgClient } from '../db/postgres.js';
import { RedisClient } from '../db/redis.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { TrackedEmbeddingProvider, TrackedLLMProvider } from './utils/tracked-provider.js';
import { tenantStore } from './utils/tenant-scope.js';
import { createAuthHook } from './middleware/auth.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import { createUsageMiddleware } from './middleware/usage.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { messageRoutes } from './routes/messages.js';
import { contextRoutes } from './routes/context.js';
import { searchRoutes } from './routes/search.js';
import { factRoutes } from './routes/facts.js';
import { emotionRoutes } from './routes/emotions.js';
import { contradictionRoutes } from './routes/contradictions.js';
import { consolidationRoutes } from './routes/consolidation.js';
import { summaryRoutes } from './routes/summary.js';
import { graphRoutes } from './routes/graph.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { createAuditService } from './services/audit.js';
import { createEmailService } from './services/email.js';
import { createMagicLinkService } from './services/magic-link.js';
import type { ManagedSession } from './types.js';
import type { Logger } from '../types.js';

// ---- Config from env ----

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
const OPENROUTER_CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL ?? 'anthropic/claude-3.5-haiku';
const OPENROUTER_EMBEDDING_DIMENSIONS = parseInt(process.env.OPENROUTER_EMBEDDING_DIMENSIONS ?? '1536', 10);
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? '';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const TABLE_PREFIX = process.env.TABLE_PREFIX ?? 'bwmem_';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CORS_ORIGINS = process.env.CORS_ORIGINS; // comma-separated allowlist
const NEO4J_URI = process.env.NEO4J_URI ?? '';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';
const MAIL_TRANSPORT = (process.env.MAIL_TRANSPORT ?? 'sendmail') as 'sendmail' | 'smtp';
const MAIL_FROM = process.env.MAIL_FROM ?? 'noreply@bitwarelabs.com';
const MAIL_BASE_URL = process.env.MAIL_BASE_URL ?? 'https://api.bitwarelabs.com';
const MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST ?? '127.0.0.1';
const MAIL_SMTP_PORT = parseInt(process.env.MAIL_SMTP_PORT ?? '587', 10);
const MAIL_SMTP_SECURE = process.env.MAIL_SMTP_SECURE === 'true';
const MAIL_SMTP_TLS_REJECT = process.env.MAIL_SMTP_TLS_REJECT_UNAUTHORIZED !== 'false';
const KEY_ROTATION_GRACE_HOURS = parseInt(process.env.KEY_ROTATION_GRACE_HOURS ?? '24', 10);

const VERSION = '0.2.4';

// ---- Startup validation (#2) ----

function validateConfig(): void {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
  if (!REDIS_URL) {
    throw new Error('REDIS_URL must be set');
  }
  if (!ADMIN_API_KEY || ADMIN_API_KEY.length < 32) {
    throw new Error('ADMIN_API_KEY must be set and at least 32 characters');
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(TABLE_PREFIX)) {
    throw new Error('TABLE_PREFIX must contain only alphanumeric characters and underscores');
  }
  // MAIL_BASE_URL is embedded in verification and magic-link emails; a bad
  // value (or one injected via compromised env) would redirect users to a
  // phishing domain. Require a valid URL and enforce HTTPS in production.
  let mailUrl: URL;
  try {
    mailUrl = new URL(MAIL_BASE_URL);
  } catch {
    throw new Error('MAIL_BASE_URL must be a valid URL');
  }
  if (mailUrl.protocol !== 'http:' && mailUrl.protocol !== 'https:') {
    throw new Error('MAIL_BASE_URL must use http or https');
  }
  if (IS_PRODUCTION && mailUrl.protocol !== 'https:') {
    throw new Error('MAIL_BASE_URL must use https in production');
  }
}

// ---- Build app ----

export async function buildApp(): Promise<{
  app: FastifyInstance;
  bwmem: BwMem;
  apiPg: PgClient;
  redis: RedisClient;
  trackedEmbed: TrackedEmbeddingProvider;
  usageMw: ReturnType<typeof createUsageMiddleware>;
  auditService: ReturnType<typeof createAuditService>;
  activeSessions: Map<string, ManagedSession>;
}> {
  validateConfig();

  const app = Fastify({
    trustProxy: IS_PRODUCTION, // Trust X-Forwarded-For from nginx
    logger: {
      level: LOG_LEVEL,
      transport: !IS_PRODUCTION
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    },
    bodyLimit: 1_048_576, // Explicit 1MB body limit (#5)
  });

  // Allow empty body with Content-Type: application/json (common client behavior)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (body as string).length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Adapt Fastify's pino logger to the SDK's Logger interface
  const sdkLogger: Logger = {
    debug: (msg, meta) => app.log.debug(meta ?? {}, msg),
    info: (msg, meta) => app.log.info(meta ?? {}, msg),
    warn: (msg, meta) => app.log.warn(meta ?? {}, msg),
    error: (msg, meta) => app.log.error(meta ?? {}, msg),
  };

  // API-layer PgClient (separate pool for tenant/usage queries)
  const apiPg = new PgClient(DATABASE_URL, sdkLogger);

  // Redis client (shared with rate limiter)
  const redis = new RedisClient(REDIS_URL, sdkLogger);

  // Embedding + LLM providers (tracked for usage)
  const openrouter = new OpenRouterProvider({
    apiKey: OPENROUTER_API_KEY,
    embeddingModel: OPENROUTER_EMBEDDING_MODEL,
    model: OPENROUTER_CHAT_MODEL,
    embeddingDimensions: OPENROUTER_EMBEDDING_DIMENSIONS,
  });
  const trackedEmbed = new TrackedEmbeddingProvider(openrouter, apiPg, TABLE_PREFIX, sdkLogger);
  const trackedLLM = new TrackedLLMProvider(openrouter);

  // Neo4j graph plugin (optional)
  let graphPlugin: import('../types.js').GraphPlugin | undefined;
  if (NEO4J_URI) {
    const { Neo4jGraph } = await import('../graph/index.js');
    graphPlugin = new Neo4jGraph({
      uri: NEO4J_URI,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      logger: sdkLogger,
    });
  }

  // Initialize BwMem SDK
  const bwmem = new BwMem({
    postgres: DATABASE_URL,
    redis: REDIS_URL,
    embeddings: trackedEmbed,
    llm: trackedLLM,
    graph: graphPlugin,
    tablePrefix: TABLE_PREFIX,
    logger: sdkLogger,
    consolidation: { enabled: true },
  });

  await bwmem.initialize();
  app.log.info('BwMem SDK initialized');

  // Active session tracking
  const activeSessions = new Map<string, ManagedSession>();

  // Periodic stale session cleanup — evict on inactivity rather than age.
  // A session is stale if: (a) it has already ended, or (b) no request has
  // touched it for INACTIVITY_MS. Ended sessions also self-evict via the
  // onEnd() callback wired up in sessions.ts, so this is defense in depth.
  const INACTIVITY_MS = 15 * 60_000; // 15 minutes
  const sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, managed] of activeSessions) {
      if (managed.session.isEnded) {
        activeSessions.delete(id);
        continue;
      }
      if (now - managed.lastActivityAt.getTime() > INACTIVITY_MS) {
        activeSessions.delete(id);
      }
    }
  }, 60_000);
  sessionCleanupInterval.unref();

  // ---- Plugins ----

  // Security headers
  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: IS_PRODUCTION ? undefined : false, // Disable CSP in dev for Swagger UI
  });

  // CORS — explicit origin allowlist in production (#6)
  await app.register(import('@fastify/cors'), {
    origin: CORS_ORIGINS ? CORS_ORIGINS.split(',').map(s => s.trim()) : !IS_PRODUCTION,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Embedding-Limit', 'X-Embedding-Remaining', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  });

  // Swagger — only in non-production (#9)
  if (!IS_PRODUCTION) {
    await app.register(import('@fastify/swagger'), {
      openapi: {
        info: {
          title: 'bwmem API',
          description: 'Memory SDK for AI chatbots — REST API',
          version: VERSION,
        },
        servers: [{ url: '/api/v1' }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    });
    await app.register(import('@fastify/swagger-ui'), {
      routePrefix: '/docs',
    });
  }

  // Error handler
  app.setErrorHandler(errorHandler);

  // Auth hook (runs on all /api/v1 routes)
  const { authHook, invalidateTenant } = createAuthHook(apiPg, TABLE_PREFIX, sdkLogger, ADMIN_API_KEY || undefined);

  // Usage middleware
  const usageMw = createUsageMiddleware(apiPg, TABLE_PREFIX, sdkLogger);

  // User management services
  const auditService = createAuditService(apiPg, TABLE_PREFIX, sdkLogger);
  const emailService = createEmailService({
    transport: MAIL_TRANSPORT,
    smtpHost: MAIL_SMTP_HOST,
    smtpPort: MAIL_SMTP_PORT,
    smtpSecure: MAIL_SMTP_SECURE,
    smtpTlsRejectUnauthorized: MAIL_SMTP_TLS_REJECT,
    from: MAIL_FROM,
    baseUrl: MAIL_BASE_URL,
    logger: sdkLogger,
  });
  const magicLinkService = createMagicLinkService(apiPg, redis, TABLE_PREFIX, sdkLogger);

  // Periodic cleanup: expired magic link tokens (hourly)
  const tokenCleanupInterval = setInterval(() => void magicLinkService.cleanupExpired(), 60 * 60 * 1000);
  tokenCleanupInterval.unref();

  // Periodic cleanup: expired grace-period keys (every 5 min)
  const graceKeyCleanupInterval = setInterval(async () => {
    try {
      await apiPg.query(
        `UPDATE ${TABLE_PREFIX}api_tenants
         SET prev_api_key_hash = NULL, prev_key_expires_at = NULL
         WHERE prev_key_expires_at IS NOT NULL AND prev_key_expires_at < NOW()`,
      );
    } catch (err) {
      sdkLogger.error('Failed to clean expired grace keys', { error: (err as Error).message });
    }
  }, 5 * 60 * 1000);
  graceKeyCleanupInterval.unref();

  // ---- API info ----

  app.get('/', async () => ({
    name: 'bwmem',
    version: VERSION,
    docs: !IS_PRODUCTION ? '/docs' : undefined,
  }));

  // ---- Routes ----

  // Public auth routes (no API key required, rate-limited by IP)
  await app.register(
    async (publicApi) => {
      await registerRateLimiter(publicApi, redis);
      await publicApi.register(
        (sub, _opts) => authRoutes(sub, {
          pg: apiPg, tablePrefix: TABLE_PREFIX,
          magicLink: magicLinkService, email: emailService,
          audit: auditService, baseUrl: MAIL_BASE_URL,
        }),
        { prefix: '/auth' },
      );
    },
    { prefix: '/api/v1' },
  );

  // Authenticated API routes
  await app.register(
    async (api) => {
      // Auth on all v1 routes
      api.addHook('preHandler', authHook);

      // Rate limiting
      await registerRateLimiter(api, redis);

      // Tenant context via AsyncLocalStorage.run() (#16) + usage quota check
      api.addHook('preHandler', async (request, reply) => {
        if (request.tenant && !request.tenant.isAdmin) {
          await tenantStore.run({ tenantId: request.tenant.id }, () =>
            usageMw.quotaCheck(request, reply),
          );
        } else {
          await usageMw.quotaCheck(request, reply);
        }
      });

      // Usage recording (on response)
      api.addHook('onResponse', usageMw.recordUsage);

      // Health (no auth — auth hook skips /api/v1/health)
      await api.register(
        (sub, _opts) => healthRoutes(sub, { pg: apiPg, redis, bwmem }),
      );

      // Sessions
      await api.register(
        (sub, _opts) => sessionRoutes(sub, { bwmem, pg: apiPg, activeSessions, tablePrefix: TABLE_PREFIX }),
      );

      // Messages
      await api.register(
        (sub, _opts) => messageRoutes(sub, { activeSessions }),
      );

      // Context
      await api.register(
        (sub, _opts) => contextRoutes(sub, { bwmem, activeSessions }),
      );

      // Search
      await api.register(
        (sub, _opts) => searchRoutes(sub, { bwmem }),
      );

      // Facts
      await api.register(
        (sub, _opts) => factRoutes(sub, { bwmem, pg: apiPg, tablePrefix: TABLE_PREFIX }),
      );

      // Emotions
      await api.register(
        (sub, _opts) => emotionRoutes(sub, { bwmem }),
      );

      // Contradictions
      await api.register(
        (sub, _opts) => contradictionRoutes(sub, { bwmem }),
      );

      // Consolidation
      await api.register(
        (sub, _opts) => consolidationRoutes(sub, { bwmem }),
      );

      // Summary
      await api.register(
        (sub, _opts) => summaryRoutes(sub, { bwmem, pg: apiPg, tablePrefix: TABLE_PREFIX }),
      );

      // Graph
      await api.register(
        (sub, _opts) => graphRoutes(sub, { graph: graphPlugin }),
      );

      // Account (self-service)
      await api.register(
        (sub, _opts) => accountRoutes(sub, {
          pg: apiPg, tablePrefix: TABLE_PREFIX,
          invalidateTenant, audit: auditService,
          email: emailService, graceHours: KEY_ROTATION_GRACE_HOURS,
        }),
        { prefix: '/account' },
      );

      // Admin routes
      await api.register(
        (sub, _opts) => adminRoutes(sub, {
          pg: apiPg, tablePrefix: TABLE_PREFIX, invalidateTenant,
          audit: auditService, magicLink: magicLinkService, email: emailService,
        }),
        { prefix: '/admin' },
      );
    },
    { prefix: '/api/v1' },
  );

  return { app, bwmem, apiPg, redis, trackedEmbed, usageMw, auditService, activeSessions };
}

// ---- Start server ----

export async function startServer(): Promise<void> {
  const { app, bwmem, apiPg, trackedEmbed, usageMw, auditService, activeSessions } = await buildApp();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);

    // End all active sessions
    for (const [id, managed] of activeSessions) {
      try {
        await managed.session.end();
      } catch (err) {
        app.log.error(err, `Failed to end session ${id}`);
      }
    }
    activeSessions.clear();

    await auditService.shutdown();
    await usageMw.shutdown();
    await trackedEmbed.shutdown();
    await bwmem.shutdown();
    await apiPg.close();
    await app.close();

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: PORT, host: IS_PRODUCTION ? '127.0.0.1' : '0.0.0.0' });
    app.log.info(`bwmem API v${VERSION} listening on port ${PORT}`);
    if (!IS_PRODUCTION) {
      app.log.info(`Swagger docs at http://localhost:${PORT}/docs`);
    }
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// Auto-start if this is the main module
const isMainModule = process.argv[1]?.endsWith('server.js');
if (isMainModule) {
  void startServer();
}
