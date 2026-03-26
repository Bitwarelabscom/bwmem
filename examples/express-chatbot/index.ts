/**
 * Express chatbot example - demonstrates bwmem in a real HTTP chatbot.
 *
 * Endpoints:
 *   POST /chat         - Send a message, get AI response with memory context
 *   GET  /facts/:userId - Get stored facts for a user
 *   GET  /health       - Health check
 *
 * Prerequisites:
 *   npm install express @types/express
 *   PostgreSQL with pgvector + Redis running
 *   OPENAI_API_KEY set
 *
 * Run:
 *   npx tsx examples/express-chatbot/index.ts
 */

// NOTE: This is a reference example. In production you'd import from '@bitwarelabs/bwmem'
import { BwMem } from '../../src/index.js';
import type { Session } from '../../src/session/session.js';
import { OpenAIProvider } from '../../src/providers/openai.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY environment variable');
  process.exit(1);
}

// -- Setup bwmem --
const provider = new OpenAIProvider({
  apiKey: OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});

const mem = new BwMem({
  postgres: process.env.DATABASE_URL || 'postgresql://localhost/bwmem_chatbot',
  redis: process.env.REDIS_URL || 'redis://localhost:6379',
  embeddings: provider,
  llm: provider,
  consolidation: {
    daily: '0 2 * * *',
    weekly: '0 3 * * 0',
  },
  session: {
    inactivityTimeoutMs: 10 * 60 * 1000, // 10 minutes
  },
});

// Track active sessions per user
const activeSessions = new Map<string, Session>();

async function getOrCreateSession(userId: string): Promise<Session> {
  let session = activeSessions.get(userId);
  if (!session) {
    session = await mem.startSession({ userId });
    activeSessions.set(userId, session);
  }
  return session;
}

// -- Minimal HTTP server (no express dependency needed for the example) --
import { createServer } from 'node:http';

async function main() {
  await mem.initialize();
  console.log('bwmem initialized');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');

    try {
      // Health check
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Chat endpoint
      if (url.pathname === '/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const { userId, message } = JSON.parse(body);

        if (!userId || !message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'userId and message required' }));
          return;
        }

        // Get or create session
        const session = await getOrCreateSession(userId);

        // Record user message
        await session.recordMessage({ role: 'user', content: message });

        // Build memory context for this user
        const context = await mem.buildContext(userId, {
          query: message,
          sessionId: session.id,
        });

        // Generate AI response using memory context
        const response = await provider.chat([
          {
            role: 'system',
            content: `You are a helpful AI assistant. You remember things about the user from previous conversations.

${context.formatted ? `## Memory Context\n${context.formatted}` : ''}

Use the memory context to personalize your responses. Reference things you know about the user naturally.`,
          },
          { role: 'user', content: message },
        ], { temperature: 0.7 });

        // Record assistant response
        await session.recordMessage({ role: 'assistant', content: response });

        res.writeHead(200);
        res.end(JSON.stringify({
          response,
          sessionId: session.id,
          memorySourcesResponded: context.sourcesResponded,
          factsKnown: context.facts.length,
        }));
        return;
      }

      // Get facts endpoint
      if (url.pathname.startsWith('/facts/') && req.method === 'GET') {
        const userId = url.pathname.split('/facts/')[1];
        const facts = await mem.facts.get(userId);
        res.writeHead(200);
        res.end(JSON.stringify({ facts }));
        return;
      }

      // End session endpoint
      if (url.pathname === '/end-session' && req.method === 'POST') {
        const body = await readBody(req);
        const { userId } = JSON.parse(body);
        const session = activeSessions.get(userId);
        if (session) {
          await session.end();
          activeSessions.delete(userId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ended: true }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('Error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });

  const PORT = parseInt(process.env.PORT || '3030');
  server.listen(PORT, () => {
    console.log(`Chatbot running on http://localhost:${PORT}`);
    console.log(`
Endpoints:
  POST /chat          - { "userId": "user-1", "message": "Hello!" }
  GET  /facts/:userId - Get stored facts
  POST /end-session   - { "userId": "user-1" }
  GET  /health        - Health check

Example:
  curl -X POST http://localhost:${PORT}/chat \\
    -H 'Content-Type: application/json' \\
    -d '{"userId":"demo","message":"My name is Alice and I love hiking"}'
`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const [_userId, session] of activeSessions) {
      await session.end();
    }
    await mem.shutdown();
    server.close();
    process.exit(0);
  });
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
