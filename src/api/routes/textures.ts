// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { textureParamsSchema, textureQuerySchema, captureTextureSchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function textureRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /textures/:userId — latest texture row (no surfacing side effect)
  app.get('/textures/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = textureParamsSchema.parse(request.params);
    const q = textureQuerySchema.parse(request.query ?? {});
    const texture = await bwmem.textures.getLatest(scopeUserId(tenant.id, userId), {
      mode: q.mode,
      speaker: q.speaker,
    });
    return { success: true, data: { texture: texture ? stripTenantFromResponse(texture) : null } };
  });

  // GET /textures/:userId/prompt — formatted anchor block for prompt injection
  app.get('/textures/:userId/prompt', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = textureParamsSchema.parse(request.params);
    const q = textureQuerySchema.parse(request.query ?? {});
    const block = await bwmem.textures.getForPrompt(scopeUserId(tenant.id, userId), {
      mode: q.mode,
      speaker: q.speaker,
    });
    return { success: true, data: { prompt: block } };
  });

  // POST /textures — capture (fire-and-forget; returns immediately)
  app.post('/textures', async (request: FastifyRequest, _reply) => {
    const body = captureTextureSchema.parse(request.body);
    // Fire-and-forget at the SDK layer — but await here so the caller knows
    // we accepted the request. The SDK's own .capture() swallows errors.
    await bwmem.textures.capture(body.sessionId, { mode: body.mode, speaker: body.speaker });
    return { success: true, data: { captured: true } };
  });
}
