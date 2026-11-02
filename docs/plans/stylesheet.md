# Plan: tidying the stylesheet

## Why this plan exists

The stylesheet at `app/src/styles.css` has grown in layers, and each layer restyled the one before it without removing what it replaced. The first layer set the original square, ruled look. A second layer, headed "Finish", tried to unify controls. A third added the phone and touch rules. The last layer, headed "Design, from 0.29", is the look the design skill describes. Because each layer only overrides the earlier ones, the file now holds a large number of declarations that never reach the screen. Several `!important` flags exist only to beat rules that are themselves dead. A few phone rules are silently cancelled by later desktop rules, so the phone looks different from what their authors intended.

None of this is visible to someone using the app today, which is why it has gone unnoticed. The cost falls on whoever changes the interface next, because they cannot tell which of three rules for `.button` is the real one without tracing the cascade by hand. That uncertainty is how the same thing ends up styled differently in two places, which the design skill asks us to avoid.

## What we are aiming for

The goal is a stylesheet where each component is defined once, in the "Design, from 0.29" look, so that reading a rule tells you what the screen shows. Tokens should be declared in one block for each theme, and the components should use only those tokens. `!important` should remain only where it overrides inline styles, third-party styles or the reduced-motion preference, and each remaining use should carry a comment saying why.

## How the work is split

The work is split into four phases, ordered so that the risky changes come only after the safe ones have made the file easier to read.

### Phase 1: remove what never applies

This phase deletes duplicate rules, declarations overridden later by an equal or stronger selector, and `!important` flags that no longer win anything. Every edit in this phase must leave every computed style unchanged across all viewports, themes and input types. The line-by-line map for this phase is kept alongside this plan. It should land as one commit with no other changes, so that a reviewer can check it against the computed-style snapshot described below.

### Phase 2: decide on the rules that are dead by accident

Some declarations never apply, but only because a later rule cancels them by mistake. Deleting these would change nothing on screen, yet it would also throw away what their authors meant. Each one needs a decision, made by looking at the screen on a phone and on a laptop, before anyone changes it:

- The phone type scale (`--fs-2xl` and `--fs-xl` below 34rem) is redefined later for all widths, so phones never get the smaller titles.
- The sheet versions of menus and dialogs on a phone set a top-only border, their own padding and an upward shadow. The later "things that float" rules replace all three, so sheets show a full border and the desktop padding.
- On a phone, menu items use the desktop padding rather than the larger sheet padding, because the `role="menuitem"` rule is more specific than the phone rule.
- The phone row gap for section heads, and the phone padding for this week's tiles, are both overridden by later rules for all widths.
- The soft hover surfaces for `.button`, `.button.primary`, `.icon-button` and `.menu-button` only reach disabled controls. This happens because the older `:hover:not(:disabled)` rules are more specific, so enabled buttons still use the older tinted hover.
- The search box keeps the strong ink border from the first layer, because that rule's selector outranks the later softer one.

Each item should be fixed by moving the intended rule into the right place, or by removing it if the current look turns out to be the better one. The fix should be checked against `docs/design/` before it is merged.

### Phase 3: one definition for each component

Once the dead rules are gone, each component's surviving declarations can be gathered into a single rule placed with the rest of its section. This applies to buttons, fields, menus, dialogs, lists, the week grid, the reader and the job search. The two touch blocks that share the condition `(pointer: coarse), (max-width: 48rem)` should become one block, and the repeated hover rules in the top bar should become one selector list. Moving a rule changes its place in the cascade, so each move must be checked against the snapshot, not assumed safe.

### Phase 4: bring the remaining styles onto the tokens

Several colours are still written directly instead of through tokens. These are the amber of soon key dates (`#8A5A00`, `#E0B25B`), the recording pill's reds and yellows (`#FF8A7A`, `#FFD27A`), the white on slide arrows, the theme preview chips, and many `rgba()` shadows. The older tokens `--wash`, `--shadow` and `--chrome` overlap with `--accent-soft`, `--surface` and `--shadow-float`, and each should be either retired or given a single clear use. The leftover square corners in the notes editor (the selected-quotation outline and `--bn-border-radius-large`) and the comments that still describe a square, ruled look should be brought in line with the skill. The theme preview chips are the one place where literal colours are correct, because they show other themes, and they should say so in a comment.

## How each phase is checked

Phases 1 and 3 are checked by a computed-style snapshot rather than by eye, because small cascade changes are easy to miss on screen. A browser test should open the home, module, week, session, reader, search and job search pages. It should record `getComputedStyle` for every element, including `::before` and `::after`, in each of these conditions:

- At widths of 390px, 700px, 768px, 960px and 1280px, which lie either side of each breakpoint the file uses.
- In the light, sepia and dark themes, and with no theme set while the system prefers dark.
- With a fine pointer and with a coarse pointer emulated.
- At rest, and while hovering, focusing and pressing a representative button, row, field and menu item.
- With reduced motion both on and off.

The snapshot taken before the change and the one taken after must match exactly. Phases 2 and 4 change what people see on purpose, so they are checked against the screenshots in `docs/design/`. They also go through the full list under "Before finishing any change to the interface" in the design skill, including `npm run test:all` and the browser tests the change touches.

## What is out of scope

This plan does not change the design itself, add tokens, or touch the markup, apart from the checks that Phase 2 needs. Any change to the look that comes up along the way belongs in a separate change, reviewed against the design skill.
