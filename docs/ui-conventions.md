# UI conventions

How EmuCat's web interface presents actions, navigation, metadata and status. They were set by Archive Explorer
([decision 0058](decisions/0058-browser-local-nested-archives.md)) and Version History
([decision 0059](decisions/0059-version-history-icon-toolbars.md)); new areas follow them, and older areas move to them
as they are reworked. The components are in [`apps/web/src/components/ui/`](../apps/web/src/components/ui/).

## Icons

- **Lucide** (`lucide-react`) is the only icon library. Import each icon by name
  (`import { Trash2 } from 'lucide-react'`), never the whole set, so that only used icons are bundled. Before choosing
  one, check it exists in the installed version (`node -e "import('lucide-react').then(L => console.log(!!L.Name))"`
  from `apps/web`); record a substitute and why in the decision.
- Size `ICON_SIZE` (16 px) in toolbars and navigation, 14 px in status chips, Lucide's default stroke. Icons are
  always `aria-hidden="true"`: the control's own name says what it does.
- Colour comes from the text colour (`currentColor`), which comes from Bootstrap's variables, so both themes work with
  nothing specific. Do not hard-code colours where a Bootstrap variable exists.

## The four rules

| What                | How                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| Operational actions | Icon buttons in a contextual `Toolbar`, grouped, each with a name and a tooltip     |
| Primary navigation  | Icon **and** visible label (`NavItem.icon`); never icon only                        |
| Detailed metadata   | One **Info** button (`InfoPopover`) per subject, at the end of its toolbar          |
| Status              | A `StatusChip`: icon and a few words, the full statement as tooltip and for readers |

Critical errors and warnings that need a person now (a failed deletion, an integrity failure, an inconsistent history)
stay in view as alerts, never only behind Info or a tooltip.

## Actions: `IconButton` and `Toolbar`

- **Name.** `label` is the accessible name and must identify the subject when several cards are on the page:
  "Delete DOS622_202611182136", not "Delete". `tooltip` is the short visual text ("Delete snapshot"). Tests find
  controls by these names.
- **Tooltip.** Rendered by `IconButton` itself, shown on hover and on keyboard focus, hidden from assistive technology
  (it repeats the name). Never rely on the `title` attribute. Use `tooltipPlacement="start"` near the right edge.
- **Groups.** Put related actions in a `ToolbarGroup` with a label, separated by `ToolbarSeparator`; push Info to the
  end with `ToolbarSpacer`. Render no empty group and no separator next to nothing. Keep the same order on every card.
  Version History's order: run and restore, management, lifecycle, information.
- **Keyboard.** `Toolbar` is a WAI-ARIA toolbar: every control keeps its Tab stop, and Left/Right/Home/End also move
  between them.
- **Dialogs.** An action that opens a dialog says so with `aria-haspopup="dialog"`, and opens exactly the dialog it
  always opened. An icon never turns a confirmed action into an immediate one.
- **Destructive actions.** `danger`: neutral at rest, danger colours on hover and focus only. The confirmation dialog
  carries the warning.
- **Busy.** `loading` shows a spinner and sets `aria-busy`.
- **Size.** At least 32 px, 44 px on coarse pointers (`@media (pointer: coarse)`).

### Unavailable actions

- Hide an action that does not apply (no Delete for a master) or that the user may not use. Never show an
  unauthorized action just to draw it disabled.
- Show a temporarily unavailable action disabled, **with its reason**: `disabled` plus `disabledReason`. The button is
  then `aria-disabled`, stays focusable, has its reason as its description, shows "_Action_ unavailable" and the reason
  as its tooltip, and ignores clicks. Also list the reason in the subject's Info panel, which is how a touch user
  reads it.
- A reason states a condition the code already checks. Do not invent a new condition to have something to say.

## Metadata: `InfoPopover`

- One per subject (an archive, a file, a version) and one per page for explanations the page used to print.
- `label` is unique ("Information about _name_"), `tooltip` short ("Version information"), `title` names the subject.
- The panel is a non-modal dialog over the content: it never resizes the card. Escape or the button closes it and the
  focus returns to the button; a click outside closes it. Under 576 px it is a sheet at the bottom of the window.
- Group facts under `info-section` headings in `info-facts` lists. Long identifiers and hashes use `info-copyable`
  (wrapped, selectable in one click). Say what a value rests on when it matters (declared, verified, recorded at
  publication).
- Render the content lazily (`children` as a function) when it is costly. Show only what the data already holds; do not
  add an API request just to fill a panel.

## Status: `StatusChip`

- `label` is a few visible words; `detail` the complete statement (the text the interface used to print).
- `tone`: `success`, `warning`, `danger`, `info` or `neutral`. The icon and the words carry the meaning; colour only
  reinforces it.
- Keep distinct states distinct: one chip per agent's copy, and historical facts ("Verified when published") never
  presented as current ones.

## Responsive behaviour and themes

- Toolbars wrap; groups stay together. On a phone, trim indentation rather than hide actions, and check that nothing
  scrolls sideways (`document.documentElement.scrollWidth <= clientWidth`).
- Check every change in light and dark themes, at a phone width and at 200% zoom. The browser tests do the first two.

## Tests

- Unit tests (`apps/web/test`): find controls by role and name; for an unavailable action assert `aria-disabled` (or
  `disabled`), its description, and that a click does nothing. `test/ui-primitives.test.tsx` covers the primitives.
- Browser tests (`apps/web/e2e`, `pnpm --filter @emucat/web test:browser`): layout, tooltips on hover and focus,
  panels inside the window, themes, narrow layout and the requests made. See [testing.md](testing.md).
