import { describe, expect, it } from 'vitest';
import {
  assertImageBudget,
  ESTIMATED_IMAGE_TOKENS,
  imageBytes,
  imageDataUrl,
  imageFilePart,
  imageLabel,
  imageMediaType,
  isImageDataUrl,
  isImagePart,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_CHARS,
  MAX_IMAGES_PER_TURN,
  storedImage,
} from '../src/core/images.js';

const PNG = imageDataUrl(Buffer.from('a tiny picture'), 'image/png');

describe('imageMediaType', () => {
  it('knows the picture formats a model can be sent, by extension', () => {
    expect(imageMediaType('a/b/diagram.PNG')).toBe('image/png');
    expect(imageMediaType('photo.JPEG')).toBe('image/jpeg');
    expect(imageMediaType('photo.jpg')).toBe('image/jpeg');
    expect(imageMediaType('icon.gif')).toBe('image/gif');
    expect(imageMediaType('icon.webp')).toBe('image/webp');
    // A dot in a directory name is not an extension, and a file with none has no type.
    expect(imageMediaType('v1.2/shot.png')).toBe('image/png');
    expect(imageMediaType('v1.2/shot')).toBeUndefined();
  });

  it('says nothing about a file it does not recognise', () => {
    for (const file of ['notes.txt', 'model.ts', 'clip.mp4', 'sheet.csv', 'no-extension']) {
      expect(imageMediaType(file)).toBeUndefined();
    }
  });
});

describe('isImageDataUrl', () => {
  it('accepts only an inline image payload', () => {
    expect(isImageDataUrl(PNG)).toBe(true);
    expect(isImageDataUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E')).toBe(false);
    expect(isImageDataUrl('https://example.com/a.png')).toBe(false);
    expect(isImageDataUrl('not even close')).toBe(false);
    expect(isImageDataUrl('data:text/plain;base64,AAA=')).toBe(false);
    expect(isImageDataUrl(undefined)).toBe(false);
  });

  it('refuses a payload over the per-image cap', () => {
    const huge = imageDataUrl(Buffer.alloc(MAX_IMAGE_BYTES + 1, 7), 'image/png');
    expect(isImageDataUrl(huge)).toBe(false);
    expect(() => assertImageBudget([huge])).toThrow(/at most 3 MB/);
  });

  it('puts the same cap on the wire as on the bytes', () => {
    // base64 is 4 characters per 3 bytes, so the IPC length cap cannot drift.
    expect(MAX_IMAGE_CHARS).toBe(Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
  });
});

describe('assertImageBudget', () => {
  it('accepts nothing at all, and a turn that fits', () => {
    expect(() => assertImageBudget([])).not.toThrow();
    expect(() => assertImageBudget([PNG, PNG])).not.toThrow();
  });

  it('names the count cap before the model is asked', () => {
    const tooMany = Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, () => PNG);
    expect(() => assertImageBudget(tooMany)).toThrow(
      new RegExp(`At most ${MAX_IMAGES_PER_TURN} images per turn`),
    );
  });

  it('refuses a value that is not an inline image', () => {
    expect(() => assertImageBudget(['https://example.com/a.png'])).toThrow(/data:image URL/);
  });
});

describe('imageBytes and imageLabel', () => {
  it('reports the decoded size, not the base64 length', () => {
    for (const bytes of [1, 2, 3, 4, 300]) {
      const url = imageDataUrl(Buffer.alloc(bytes, 7), 'image/png');
      expect(imageBytes(url)).toBe(bytes);
    }
  });

  it('reads as a size a person can check against the file', () => {
    expect(imageLabel(imageDataUrl(Buffer.alloc(2_000), 'image/png'))).toBe('image/png · 2 KB');
    expect(imageLabel(imageDataUrl(Buffer.alloc(2_000_000), 'image/jpeg'))).toBe(
      'image/jpeg · 1.9 MB',
    );
  });
});

describe('imageFilePart', () => {
  it('sends the current part shape, not the deprecated image one', () => {
    expect(imageFilePart(PNG)).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: 'YSB0aW55IHBpY3R1cmU=',
    });
  });

  it('keeps the media type it was given instead of guessing png', () => {
    expect(imageFilePart(imageDataUrl(Buffer.alloc(3), 'image/webp')).mediaType).toBe('image/webp');
  });
});

describe('isImagePart', () => {
  it('recognises a picture by its media type', () => {
    expect(isImagePart(imageFilePart(PNG))).toBe(true);
    expect(isImagePart({ type: 'file', mediaType: 'image', data: 'AAA=' })).toBe(true);
  });

  it('does not call a text or a non-image file a picture', () => {
    for (const part of [
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'application/pdf', data: 'AAA=' },
      { type: 'file', data: 'AAA=' },
      null,
    ]) {
      expect(isImagePart(part)).toBe(false);
    }
  });
});

it('estimates an image at one vendor upper bound, not at its payload length', () => {
  expect(ESTIMATED_IMAGE_TOKENS).toBe(1_600);
});

describe('storedImage', () => {
  it('takes the bytes out of either shape a stored part holds', () => {
    expect(storedImage({ type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' })).toEqual({
      mediaType: 'image/png',
      base64: 'aGVsbG8=',
    });
    expect(
      storedImage({ type: 'file', mediaType: 'image', data: { type: 'data', data: 'aGVsbG8=' } }),
    ).toEqual({ mediaType: 'image', base64: 'aGVsbG8=' });
  });

  it('says nothing about a part that is not a picture or has no base64 in it', () => {
    expect(storedImage({ type: 'text', text: 'aGVsbG8=' })).toBeUndefined();
    expect(
      storedImage({ type: 'file', mediaType: 'application/pdf', data: 'QQ==' }),
    ).toBeUndefined();
    expect(storedImage({ type: 'file', mediaType: 'image/png' })).toBeUndefined();
    // Bytes stored as a typed array are not a string the export can name or link.
    expect(
      storedImage({ type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2]) }),
    ).toBeUndefined();
  });
});
