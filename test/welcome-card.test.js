import { describe, it, expect } from 'vitest';
import { buildWelcomeCard, buildWelcomeCardAttachment } from '../src/lib/welcome-card.js';

describe('welcome card', () => {
  it('builds an Adaptive Card with prompt starter actions', () => {
    const card = buildWelcomeCard({
      welcomeCardTitle: 'Zylos',
      promptStarters: ['Draft a reply', 'Summarize this'],
    }, 'fallback');

    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    expect(card.body[0].text).toBe('Zylos');
    expect(card.actions).toEqual([
      {
        type: 'Action.Submit',
        title: 'Draft a reply',
        data: { msteams: { type: 'imBack', value: 'Draft a reply' }, text: 'Draft a reply' },
      },
      {
        type: 'Action.Submit',
        title: 'Summarize this',
        data: { msteams: { type: 'imBack', value: 'Summarize this' }, text: 'Summarize this' },
      },
    ]);
  });

  it('normalizes prompt starters and caps action count', () => {
    const card = buildWelcomeCard({
      promptStarters: [' one ', '', null, 'two', 'three', 'four', 'five', 'six'],
    }, 'Bot');

    expect(card.body[0].text).toBe('Bot');
    expect(card.actions.map(action => action.title)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('wraps the card in a Teams attachment', () => {
    const attachment = buildWelcomeCardAttachment({ promptStarters: [] }, 'Bot');

    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content.type).toBe('AdaptiveCard');
  });
});
