const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';

function normalizeStarters(starters) {
  return (Array.isArray(starters) ? starters : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

export function buildWelcomeCard(config = {}, botName = 'bot') {
  const title = String(config.welcomeCardTitle || botName || 'bot').trim();
  const starters = normalizeStarters(config.promptStarters);

  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: "I'm ready to help here.",
        wrap: true,
      },
    ],
    actions: starters.map(starter => ({
      type: 'Action.Submit',
      title: starter,
      data: {
        msteams: {
          type: 'imBack',
          value: starter,
        },
        text: starter,
      },
    })),
  };
}

export function buildWelcomeCardAttachment(config = {}, botName = 'bot') {
  return {
    contentType: ADAPTIVE_CARD,
    content: buildWelcomeCard(config, botName),
  };
}
