# Brand guidelines

EmuCat's name refers to a cat, and a cat is the project's mascot.

**Status: version 1, original artwork, drawn as hand-written SVG.** It is integrated across the web app and is
fine to use, but no professional designer has reviewed it. See [outstanding work](#outstanding-work).

## The idea

A friendly cat whose face is an old computer's screen: square phosphor pixels for eyes on a dark display, with
a small amber indicator-light nose. The full mascot sits like a tower PC, with a drive slot and a power light on
its chest. The retro reference stays in those details, and everything else is plain and modern.

## Assets

Everything lives in [`apps/web/src/assets/brand`](../apps/web/src/assets/brand). Nothing else in the repository
should contain brand artwork. Use these files rather than copying the geometry.

| File                              | What it is                 | Use it for                                    |
| --------------------------------- | -------------------------- | --------------------------------------------- |
| `mark.svg`                        | The cat's head             | Tight spaces, image placeholders, sign-in     |
| `wordmark.svg`                    | "EmuCat" as drawn letters  | Beside the mark                               |
| `mascot.svg`                      | The whole cat, three moods | Empty states, errors, the welcome page        |
| `favicon.svg`                     | Simplified head            | The browser tab. Follows the system theme     |
| `logo-light.svg`, `logo-dark.svg` | Mark and wordmark          | Outside the app, on light or dark backgrounds |

Inside the app, use the components in [`Brand.tsx`](../apps/web/src/components/Brand.tsx): `BrandMark`,
`BrandLogo` and `Mascot`. They inline the SVG so that it follows the theme through CSS variables. The `mark`,
`wordmark` and `mascot` files fall back to their light colors when opened on their own.

A test ([`brand.test.tsx`](../apps/web/test/brand.test.tsx)) checks that the logos and favicon keep the same
geometry as the source files, that both themes define every color, and that no asset contains scripts or
external references.

## Mascot moods

| Mood       | Where                                               |
| ---------- | --------------------------------------------------- |
| `idle`     | The welcome page                                    |
| `sleeping` | Empty states: nothing is wrong, nothing is here yet |
| `puzzled`  | Errors and pages that do not exist                  |

Decorative by default, because the text beside it says what happened. Pass `labelled` if it stands alone.

## Colors

Defined in [`styles.css`](../apps/web/src/styles.css). The palette is teal, near-black and one small amber
accent, and it stays that restrained.

| Variable                | Light     | Dark      | Role                   |
| ----------------------- | --------- | --------- | ---------------------- |
| `--emucat-cat-body`     | `#0f766e` | `#2dd4bf` | The cat, primary color |
| `--emucat-cat-shade`    | `#115e59` | `#14b8a6` | Tail, paws, whiskers   |
| `--emucat-cat-screen`   | `#042f2e` | `#042f2e` | The face's display     |
| `--emucat-cat-phosphor` | `#5eead4` | `#99f6e4` | Eyes                   |
| `--emucat-cat-led`      | `#f59e0b` | `#fbbf24` | Nose and power light   |
| `--emucat-word-primary` | `#134e4a` | `#f0fdfa` | "Emu"                  |
| `--emucat-word-accent`  | `#0f766e` | `#2dd4bf` | "Cat"                  |

## Visual language

- **Catalog images** share a 4:3 frame, the shape of the screens they show.
- **The placeholder** is the mark, faded, over a soft gradient with faint scanlines. It appears whenever a VM has
  no image the viewer may see. It must look deliberate, since it is what many cards will show.
- **Emulator names** and VM identities use a monospace face. Everything else uses Bootstrap's system font stack.
- **Empty states** have the mascot, one heading, one sentence and at most one action, in a dashed outline.

## Using the marks

- Leave clear space around the mark of at least a quarter of its width.
- Do not recolor outside the palette, stretch, rotate, add effects or redraw it.
- Prefer the mark at 16 pixels or larger, and the full mascot at 64 pixels or larger, since its whiskers and moods
  do not read below that.
- EmuCat is written with a capital E and C, and is one word.

## Adding artwork

Keep it original vector work, with no third-party characters or downloaded art. Draw it by hand or with a tool
whose output you can license. Do not add illustration libraries or other runtime dependencies for artwork.

## Outstanding work

- **Designer review.** The artwork was written directly as SVG, and no designer has refined it. Replacing it means
  replacing the files here and keeping their variables.
- **Raster icons.** Only an SVG favicon exists. Browsers without SVG favicon support show a generic icon, and
  there is no `apple-touch-icon` or social preview image.
- **Wordmark on its own.** The letters are simple rounded strokes that have only been tested beside the mark.
