import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VmImage } from '../src/components/Catalog';

const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

/** The declarations of the first rule with exactly this selector, outside any at-rule's own selector. */
function rule(selector: string, source = styles): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`No rule for ${selector}`);
  const declarations: Record<string, string> = {};
  for (const line of match[1].split(';')) {
    const [property, ...value] = line.split(':');
    if (property && value.length > 0) declarations[property.trim()] = value.join(':').trim();
  }
  return declarations;
}

describe('screenshot thumbnails', () => {
  it('show the whole image, never cropped or stretched, in a frame of fixed shape', () => {
    const image = rule('.vm-image');
    expect(image['object-fit']).toBe('scale-down');
    expect(image['object-position']).toBe('center');
    // The frame's shape does not depend on the image, so cards line up and nothing moves as it loads.
    expect(image['aspect-ratio']).toBe('4 / 3');
    expect(image.width).toBe('100%');
    expect(styles).not.toMatch(/object-fit:\s*(cover|fill)/);
  });

  it('letterbox against a background defined for both themes', () => {
    expect(rule('.vm-image').background).toBe('var(--emucat-image-frame)');
    const themes = styles.split("[data-bs-theme='dark']");
    expect(themes[0]).toMatch(/--emucat-image-frame:\s*#[0-9a-f]{6}/);
    expect(themes[1]).toMatch(/--emucat-image-frame:\s*#[0-9a-f]{6}/);
  });

  it('are one shared component, which keeps its fallback when an image fails', () => {
    render(<VmImage src="/media/broken.jpg" alt="A screenshot" />);
    const image = screen.getByRole('img', { name: 'A screenshot' });
    expect(image.className).toBe('vm-image');
    image.dispatchEvent(new Event('error'));
    return screen.findByRole('img', { name: 'No image' });
  });
});
