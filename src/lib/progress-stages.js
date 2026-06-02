const DEFAULT_STAGES = ['Queued', 'Working', 'Sending'];

export function normalizeProgressStages(stages = DEFAULT_STAGES) {
  return (Array.isArray(stages) ? stages : DEFAULT_STAGES)
    .map(stage => String(stage || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function buildProgressText(stages, activeIndex = 0) {
  const normalized = normalizeProgressStages(stages);
  if (normalized.length === 0) return '';

  return normalized.map((stage, index) => {
    const marker = index < activeIndex ? '[x]' : index === activeIndex ? '[>]' : '[ ]';
    return `${marker} ${stage}`;
  }).join('\n');
}

export function nextProgressText(stages, currentIndex = -1) {
  const normalized = normalizeProgressStages(stages);
  if (normalized.length === 0) return { index: -1, text: '' };
  const index = Math.min(currentIndex + 1, normalized.length - 1);
  return { index, text: buildProgressText(normalized, index) };
}
