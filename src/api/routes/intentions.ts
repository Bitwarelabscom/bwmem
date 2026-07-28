// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import {
  intentionParamsSchema, intentionIdParamsSchema,
  saveIntentionSchema, resolveIntentionSchema, intentionPromptQuerySchema,
} from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function intentionRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /intentions/:userId — list open intentions (no side effects)
  app.get('/intentions/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = intentionParamsSchema.parse(request.params);
    const intentions = await bwmem.intentions.listOpen(scopeUserId(tenant.id, userId));
    return { success: true, data: { intentions: stripTenantFromResponse(intentions) } };
  });

  // GET /intentions/:userId/all — list all intentions (status history)
  app.get('/intentions/:userId/all', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = intentionParamsSchema.parse(request.params);
    const intentions = await bwmem.intentions.listAll(scopeUserId(tenant.id, userId));
    return { success: true, data: { intentions: stripTenantFromResponse(intentions) } };
  });

  // POST /intentions — save a new intention
  app.post('/intentions', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = saveIntentionSchema.parse(request.body);
    const id = await bwmem.intentions.save(
      scopeUserId(tenant.id, body.userId),
      body.intention,
      body.note,
    );
    return { success: true, data: { id } };
  });

  // POST /intentions/resolve — resolve (done | let_go)
  app.post('/intentions/resolve', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = resolveIntentionSchema.parse(request.body);
    const resolved = await bwmem.intentions.resolve(
      scopeUserId(tenant.id, body.userId),
      body.status,
      { id: body.id, note: body.note },
    );
    return { success: true, data: { resolved } };
  });

  // DELETE /intentions/:id — explicit removal (resolve as let_go)
  app.delete('/intentions/:id', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { id } = intentionIdParamsSchema.parse(request.params);
    // Use resolve with status='let_go' to keep the audit trail.
    // Caller must include userId via the body for tenant scoping.
    const body = resolveIntentionSchema.partial({ status: true }).parse(request.body ?? {});
    if (!body.userId) {
      return { success: false, error: 'userId required in body', code: 'BAD_REQUEST' };
    }
    const resolved = await bwmem.intentions.resolve(
      scopeUserId(tenant.id, body.userId),
      'let_go',
      { id, note: body.note },
    );
    return { success: true, data: { resolved } };
  });

  // GET /intentions/:userId/prompt — surface the oldest open intention (SIDE EFFECT)
  // Bumps defer_count and stamps last_surfaced_at. Call from a wake/idle loop,
  // never from a hot read path.
  app.get('/intentions/:userId/prompt', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = intentionParamsSchema.parse(request.params);
    const q = intentionPromptQuerySchema.parse(request.query ?? {});
    const prompt = await bwmem.intentions.getPrompt(scopeUserId(tenant.id, userId), {
      timezone: q.timezone,
      deferLimit: q.deferLimit,
    });
    return { success: true, data: { prompt } };
  });
}
