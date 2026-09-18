import { describe, it, expect } from 'vitest';
import { CuratorRejectionService, type DroppedMemoryItem } from '../../src/memory/curator-rejection.service.js';
import { mockLogger } from '../fixtures/mock-providers.js';

describe('CuratorRejectionService', () => {
  it('records and retrieves dropped items from memory fallback', async () => {
    const service = new CuratorRejectionService(null, 'test_', mockLogger);
    const sessionId = 'session-123';

    const dropped: DroppedMemoryItem[] = [
      {
        type: 'fact',
        key: 'tech/language',
        content: 'Prefers TypeScript over Python',
        score: 0.12,
        timestamp: 1000,
      },
      {
        type: 'message',
        key: 'User',
        content: 'What about coffee beans from Colombia?',
        score: 0.08,
        timestamp: 2000,
      },
    ];

    await service.recordDroppedMemories(sessionId, dropped);

    // Unfiltered retrieval (newest first)
    const items = await service.getDroppedMemories(sessionId);
    expect(items.length).toBe(2);
    expect(items[0].content).toContain('coffee beans');
    expect(items[1].content).toContain('TypeScript');

    // Query-filtered retrieval
    const coffeeItems = await service.getDroppedMemories(sessionId, 'coffee');
    expect(coffeeItems.length).toBe(1);
    expect(coffeeItems[0].key).toBe('User');

    const tsItems = await service.getDroppedMemories(sessionId, 'typescript');
    expect(tsItems.length).toBe(1);
    expect(tsItems[0].key).toBe('tech/language');

    const missItems = await service.getDroppedMemories(sessionId, 'golang');
    expect(missItems.length).toBe(0);
  });

  it('formats dropped memories with probability metadata', () => {
    const service = new CuratorRejectionService(null, 'test_', mockLogger);
    const dropped: DroppedMemoryItem[] = [
      {
        type: 'fact',
        key: 'preference/coffee',
        content: 'Drinks oat milk latte',
        score: 0.22,
        timestamp: Date.now(),
      },
      {
        type: 'conversation',
        key: 'Dentist visit',
        content: 'Discussed root canal procedure',
        score: 0.15,
        timestamp: Date.now(),
      },
    ];

    const formatted = service.formatDroppedMemoriesForResponse(dropped, 'coffee');
    expect(formatted).toContain('matching "coffee"');
    expect(formatted).toContain('[Fact | p=0.22] [preference/coffee] Drinks oat milk latte');

    const emptyFormatted = service.formatDroppedMemoriesForResponse([], 'pizza');
    expect(emptyFormatted).toBe('No memories were dropped by the curator matching "pizza".');
  });
});
