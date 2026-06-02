import { describe, it, expect } from 'vitest';
import { getTranscriptionProvider } from '../src/lib/transcribe.js';

describe('transcription provider selection', () => {
  it('returns disabled when configured disabled', () => {
    expect(getTranscriptionProvider('disabled')).toEqual({ available: false, provider: 'disabled' });
  });

  it('uses OpenAI API fallback when key is configured', () => {
    const provider = getTranscriptionProvider('api', { OPENAI_API_KEY: 'sk-test' });
    expect(provider).toEqual({ available: true, provider: 'openai-api' });
  });

  it('returns unavailable when no provider is configured', () => {
    const provider = getTranscriptionProvider('api', {});
    expect(provider.available).toBe(false);
  });
});
