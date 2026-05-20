import { describe, it, expect } from 'vitest';
import { splitMarkdownMessage } from '../src/lib/markdown-split.js';

describe('splitMarkdownMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMarkdownMessage('hello')).toEqual(['hello']);
  });

  it('returns [""] for empty/null input', () => {
    expect(splitMarkdownMessage('')).toEqual(['']);
    expect(splitMarkdownMessage(null)).toEqual(['']);
    expect(splitMarkdownMessage(undefined)).toEqual(['']);
  });

  it('returns single chunk when text equals maxLength', () => {
    const text = 'x'.repeat(100);
    expect(splitMarkdownMessage(text, 100)).toEqual([text]);
  });

  it('splits at paragraph boundary', () => {
    const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
    const chunks = splitMarkdownMessage(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toContain('a'.repeat(60));
    expect(chunks.join('\n')).toContain('b'.repeat(60));
  });

  it('splits at line boundary when no paragraph break', () => {
    const text = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
    const chunks = splitMarkdownMessage(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits at space when no line break available', () => {
    const text = 'word '.repeat(20).trim();
    const chunks = splitMarkdownMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(30));
  });

  it('hard splits when no good break point', () => {
    const text = 'x'.repeat(200);
    const chunks = splitMarkdownMessage(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('closes and reopens code fences across chunk boundaries', () => {
    const code = '```\n' + 'x'.repeat(200) + '\n```';
    const chunks = splitMarkdownMessage(code, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('preserves all content across splits', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10).trim();
    const chunks = splitMarkdownMessage(text, 50);
    const reassembled = chunks.join(' ');
    expect(reassembled.replace(/\s+/g, ' ')).toContain('quick brown fox');
    expect(reassembled.replace(/\s+/g, ' ')).toContain('lazy dog');
  });

  it('uses default maxLength of 4000', () => {
    const text = 'x'.repeat(4000);
    expect(splitMarkdownMessage(text)).toEqual([text]);
    const longer = 'x'.repeat(4001);
    expect(splitMarkdownMessage(longer).length).toBeGreaterThan(1);
  });

  it('strips leading/trailing whitespace from chunks', () => {
    const text = 'aaa\n\n' + 'b'.repeat(100);
    const chunks = splitMarkdownMessage(text, 50);
    chunks.forEach(c => {
      expect(c).toBe(c.trim());
    });
  });
});
