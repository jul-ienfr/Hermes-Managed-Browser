import {
  classifyTypedCharacter,
  sanitizeRecorderEvent,
  summarizeAgentHistoryTimeline,
  summarizeRecorderEvents,
} from '../../lib/human-session-recording.js';

describe('human session recording privacy schema', () => {
  test('classifies typed characters without retaining raw text', () => {
    expect(classifyTypedCharacter('a')).toBe('letter');
    expect(classifyTypedCharacter('7')).toBe('digit');
    expect(classifyTypedCharacter(' ')).toBe('space');
    expect(classifyTypedCharacter('.')).toBe('punctuation');
    expect(classifyTypedCharacter('Backspace')).toBe('control');
  });

  test('sanitizes key type events to class and delay only', () => {
    const sanitized = sanitizeRecorderEvent({
      t: 920,
      type: 'key.type',
      text: 'secret@example.com',
      value: 'secret@example.com',
      key: 's',
      delay: 43,
      inputType: 'email',
    });

    expect(sanitized).toEqual({
      t: 920,
      type: 'key.type',
      class: 'letter',
      delay: 43,
      sensitive: true,
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret@example.com');
    expect(JSON.stringify(sanitized)).not.toContain('text');
    expect(JSON.stringify(sanitized)).not.toContain('value');
  });

  test('drops unsafe fields from pointer and wheel events', () => {
    expect(sanitizeRecorderEvent({
      t: 430,
      type: 'wheel',
      dx: 0,
      dy: 380,
      url: 'https://example.test/private',
      selector: '#password',
    })).toEqual({ t: 430, type: 'wheel', dx: 0, dy: 380 });

    expect(sanitizeRecorderEvent({
      t: 153,
      type: 'mouse.down',
      button: 'left',
      targetText: 'Sign in as secret@example.com',
    })).toEqual({ t: 153, type: 'mouse.down', button: 'left' });
  });

  test('summarizes AgentHistory timeline without raw typed values or selectors', () => {
    const summary = summarizeAgentHistoryTimeline([
      { kind: 'navigate', url: 'https://example.com/private' },
      { kind: 'type', text: 'secret@example.com', text_redacted: true, selector: '#email', target_summary: { role: 'textbox', name: 'Email', attributes: { type: 'email', id: 'email' } } },
      { kind: 'press', key: 'Enter' },
    ]);

    expect(summary).toEqual({
      version: 1,
      totalSteps: 3,
      actionCounts: { navigate: 1, type: 1, press: 1 },
      steps: [
        { index: 1, kind: 'navigate' },
        { index: 2, kind: 'type', textRedacted: true, targetSummary: { role: 'textbox', nameLength: 5, attributeKeys: ['id', 'type'] } },
        { index: 3, kind: 'press', keyClass: 'control' },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('secret@example.com');
    expect(JSON.stringify(summary)).not.toContain('#email');
    expect(JSON.stringify(summary)).not.toContain('https://example.com/private');
  });

  test('summarizes timing distributions without raw replay content', () => {
    const summary = summarizeRecorderEvents([
      { t: 0, type: 'mouse.move', x: 10, y: 10 },
      { t: 100, type: 'mouse.move', x: 20, y: 20 },
      { t: 150, type: 'mouse.down', button: 'left' },
      { t: 180, type: 'mouse.up', button: 'left' },
      { t: 220, type: 'key.type', key: 'p', text: 'private', delay: 40 },
      { t: 280, type: 'key.type', key: '4', text: 'private', delay: 60 },
    ]);

    expect(summary.version).toBe(1);
    expect(summary.eventCounts).toEqual({
      'mouse.move': 2,
      'mouse.down': 1,
      'mouse.up': 1,
      'key.type': 2,
    });
    expect(summary.keyClassCounts).toEqual({ letter: 1, digit: 1 });
    expect(summary.keyDelayMs).toEqual({ count: 2, min: 40, max: 60, mean: 50 });
    expect(summary.interEventDelayMs.count).toBe(5);
    expect(JSON.stringify(summary)).not.toContain('private');
  });
});
