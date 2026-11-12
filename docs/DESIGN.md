# Design

> **Direction: "Ordina calm"** (founder, 12 Nov 2026: soft, calm, smooth, well branded). Light surfaces only, Ordina's own logo and type (Outfit for headings, Inter for text), the logo's slate and teal, soft shadows instead of borders, sentence-case labels (no uppercase, no monospace), slow soft motion. Customer surfaces use 20px cards and 10px controls; the business app keeps Ordina's 6px owner rule. Assistants are shown with their own marks (web/marks.ts, from Simple Icons). Where the tables below say otherwise, this note wins.

One product, five surfaces, one visual language. The tokens and shared pieces live in `web/system.css`
(loaded last) and `web/ui.tsx`; each surface has its own stylesheet.

## The idea

The product is a **handshake**: a customer's assistant and a business's Secretary agree something, the
server checks it, and the customer approves one PayPal payment. The design shows that handshake
honestly, as a live sequence, and gives the thing being approved one unmistakable shape, **the pass**.

- **The pass** is the payment offer: what, where, when, the amount, a notch, then the customer's decision
  (PayPal's buttons). It is the same object on the front door, in the chat and on the hosted pay page.
  When PayPal confirms the capture it **seals**: a ring and a check draw themselves and the words appear.
  Nothing else in the product looks like a pass.
- **The handshake** (front door hero) plays the whole exchange as a sequence between four lanes: you,
  your assistant, the business's Secretary, PayPal.
- Everything else stays quiet so those two things carry the page.

## Tokens

| Role | Token | Value |
|---|---|---|
| Night (stages: hero, pay page) | `--night` | `#061e1b` |
| Deep teal | `--teal-900` / `--teal-800` | `#0d3b35` / `#1a4d4a` |
| Actions | `--teal-700` | `#155951` |
| Live accent, on night | `--teal-400` | `#2ebfae` |
| Subtle brand ground | `--teal-50` / `--teal-100` | `#eef6f4` / `#d7efea` |
| Text | `--ink`, `--ink-2`, `--muted`, `--faint` | `#0b1f1c` and lighter |
| Surfaces | `--bg`, `--canvas`, `--line`, `--line-2`, `--hover` | white, `#f3f6f5`, hairlines |
| Confirmed money | `--green`, `--green-soft` | `#0f7a62` |
| A hold running out, something to finish | `--amber`, `--amber-soft` | `#9a6a0b` |
| Errors | `--red`, `--red-soft` | `#c4362c` |
| PayPal's button, and only that | `--gold` | `#ffc439` |

Teal is Ordina's own family. Colour carries meaning: teal for actions and live things, green only for
money PayPal confirmed, amber only for a running hold or an unfinished step, gold only on PayPal's button.

**Type.** `--display` Funnel Display (headlines, amounts, names; weight 500 to 600, tight tracking),
`--font` Inter (everything you read or press), `--mono` Geist Mono (money in tables, times, references,
and the small uppercase `.eyebrow` labels that say who is speaking or what a thing is).

**Shape.** Controls and badges are `6px` (`--r`) everywhere: actions are real buttons, never pills.
Cards are `12px` for customers and `6px` inside the business app, where they carry
`--shadow-card` (`0 2px 10px rgba(0,0,0,.06)`) and no border. Only avatars and status dots are round.

**Layout.** Pages fill the screen with a fluid side gutter (`--gutter`); only running text is capped
(about 65 characters). Checked at 390, 1440 and 1920 wide.

**Motion.** One orchestrated moment per surface, and it always means something:

| Surface | The moment |
|---|---|
| Front door | The handshake plays through once, then loops |
| Playground | The agents' steps stream in; the pass arrives; it seals when PayPal confirms |
| Pay page | The pass arrives on a night stage; it seals |
| Business setup | Reading the owner's page, then what it found arrives line by line; going live |
| Business dashboard | The money figures count up; nothing else moves |

Entrances use `rise` (14px, 650ms, `--ease`) with a 70ms stagger. `prefers-reduced-motion` ends every
animation at its final state.

## Shared pieces (`web/ui.tsx`, styled in `system.css`)

`Mark` (Ordina's ring), `Pass`, `Seal`, `HoldClock`, `CountUp`, `SecretaryStar` (the Secretary's icon:
never a chat bubble, never a sparkle), `Icon`. Classes: `.btn-dark` (primary), `.btn-line`, `.btn-ghost`,
`.btn-danger`, `.btn-night` (the bright action on a night stage), `.linkish`, `.field`, `.money-in`,
`.seg-mini`, `.badge` / `.status-pill`, `.eyebrow`, `.num`, `.rise`.

## Words

Sentence case, plain verbs, no em dashes, no contractions. A control says what happens when it is
pressed. A required field that is empty keeps the action grey and says why at the field.
