// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SUPPORTED_IMAGE_TYPES } from '../src/core/images.js';
import {
  ACCEPTED_IMAGE_TYPES,
  imageOfPart,
  imagesOfContent,
  pickImages,
  sizeLabel,
} from '../web/src/attachments';

/** Small caps so a test can fill a turn without building megabytes of pixels. */
const CAPS = { vision: true, perTurn: 4, maxBytes: 1024 };

function png(name = 'diagram.png', bytes = 'hello'): File {
  return new File([bytes], name, { type: 'image/png' });
}

describe('the composer’s picture rules', () => {
  it('offers exactly the formats the kernel accepts', () => {
    // The browser cannot import the kernel's module, so the two lists drift apart by accident.
    expect([...ACCEPTED_IMAGE_TYPES].sort()).toEqual([...SUPPORTED_IMAGE_TYPES].sort());
  });

  it('accepts a picture and keeps the label a person can check against the file', async () => {
    const { accepted, rejected } = await pickImages([png()], CAPS, []);

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.label).toBe('image/png · 5 B');
    expect(accepted[0]?.dataUrl).toBe('data:image/png;base64,aGVsbG8=');
  });

  it('refuses a file type the vendors behind cake do not read', async () => {
    const sheet = new File(['a,b'], 'data.csv', { type: 'text/csv' });
    const { accepted, rejected } = await pickImages([sheet], CAPS, []);

    expect(accepted).toEqual([]);
    expect(rejected[0]).toMatch(/data\.csv is text\/csv — cake sends PNG, JPEG, GIF or WebP/);
  });

  it('refuses a picture over the size the wire carries', async () => {
    const { rejected } = await pickImages([png('huge.png', 'x'.repeat(2048))], CAPS, []);

    expect(rejected[0]).toBe('huge.png is 2 KB — over the 1 KB limit');
  });

  it('counts the pictures already waiting against the turn, not this drop', async () => {
    const caps = { ...CAPS, perTurn: 2 };
    const staged = (await pickImages([png('one.png', 'a'), png('two.png', 'b')], caps, []))
      .accepted;
    expect(staged).toHaveLength(2);

    const { accepted, rejected } = await pickImages([png('three.png', 'c')], caps, staged);

    expect(accepted).toEqual([]);
    expect(rejected[0]).toBe('2 images per turn — remove one to add another');
  });

  it('will not spend two slots on the same picture', async () => {
    const file = png('same.png');
    const staged = (await pickImages([file], CAPS, [])).accepted;
    const { accepted, rejected } = await pickImages([png('copy.png'), file], CAPS, staged);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['copy.png is already attached', 'same.png is already attached']);
  });

  it('sizes a picture the way a file list does', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2 KB');
    expect(sizeLabel(3_000_000)).toBe('2.9 MB');
  });
});

describe('reading pictures back out of a stored message', () => {
  const parts = { type: 'data', data: 'aGVsbG8=' };

  it('finds the bytes whether the part tags them or not', () => {
    const bare = { type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' };

    expect(imageOfPart(bare)).toBe('data:image/png;base64,aGVsbG8=');
    expect(imageOfPart({ type: 'file', mediaType: 'image', data: parts })).toBe(
      'data:image;base64,aGVsbG8=',
    );
  });

  it('says nothing about text, another kind of file, or a part with no type', () => {
    expect(imageOfPart({ type: 'text', text: 'hello' })).toBeUndefined();
    expect(
      imageOfPart({ type: 'file', mediaType: 'application/pdf', data: 'QQ==' }),
    ).toBeUndefined();
    expect(imageOfPart({ type: 'file', data: 'aGVsbG8=' })).toBeUndefined();
    expect(imageOfPart(null)).toBeUndefined();
  });

  it('collects every picture a turn carried and nothing else', () => {
    const urls = imagesOfContent([
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: {} },
      { type: 'file', mediaType: 'image/webp', data: parts },
    ]);

    expect(urls).toEqual(['data:image/png;base64,aGVsbG8=', 'data:image/webp;base64,aGVsbG8=']);
    expect(imagesOfContent('a string is not a part list')).toEqual([]);
  });
});
