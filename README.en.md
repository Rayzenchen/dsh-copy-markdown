# Copy enhancement (`@local/dsh-copy-markdown`)

English | [中文](README.md)

Select text in a DeepSeek Harness transcript and press Cmd/Ctrl+C: the clipboard receives the
**Markdown source** of the selection instead of its rendered appearance — formulas come back as
`$E=mc^2$`, code blocks as fenced code, tables as GFM tables, diff cards as ```` ```diff ````,
terminal blocks as fences, footnotes as `[^1]` plus their definitions.

Pasting it back yields the same content: prose that merely *looks* like Markdown (`*args`, a line
starting with `- `, a stray `$5 … $10`) is escaped, so it is not re-parsed into emphasis, lists or math.

<p><img src="icon.svg" width="72" height="72" alt="Copy enhancement icon: two stacked sheets with an M on the front one"></p>

## Install

**Requires** DeepSeek Harness `0.2.2-rc.3` or newer — the manifest declares an `engines.dsh` range and
older releases refuse the install. The plugin is plain JavaScript with no build step, so installing
from git needs no `allowBuilds` permission.

From GitHub (`v1.0.0` is a tag; omit it to track `main`):

```sh
dsh plugin --profile <profile> add github:Rayzenchen/dsh-copy-markdown#v1.0.0
```

From a local checkout:

```sh
dsh plugin --profile <profile> add /path/to/dsh-copy-markdown
```

In the Desktop app you can also ask the agent to call `plugin_manager` `install_bundle` with the same
spec. Refresh the page afterwards — every part runs in the browser. Remove it with
`dsh plugin --profile <profile> remove @local/dsh-copy-markdown`.

## Usage

There is one rule: **select inside the transcript and press Cmd/Ctrl+C**.

- The clipboard receives source, not rendered text, so it drops straight into an editor, an issue or
  a note.
- The composer, sidebar and settings pages are never touched; neither are Harness' own copy buttons
  on code blocks, diffs and terminals.
- Any failed check falls back to the browser's default copy, so copying never breaks outright.

## What lands on the clipboard

| Rendered form | Clipboard content |
|---|---|
| Whole formula | The author's source, `$…$` / `$$…$$` |
| Part of a formula | Structurally equivalent source of just that part, e.g. `$\sum_{i=1}^{n}$` |
| Code block | Fence plus language (taken from Harness' own banner) |
| Table | GFM table, with alignment written back as `:---:` / `---:` / `:---` |
| Diff card | ```` ```diff ```` fence, lines prefixed `- ` / `+ ` / `  ` |
| Terminal block | Fence with the command line and every output line; blank lines preserved |
| Footnote | `[^1]` reference plus `[^1]: …` definition (when both are selected) |
| Headings, lists, quotes, bold, inline code | The matching Markdown markers |
| Buttons, icons and other chrome | Skipped |

## Other plugins can consume it

The browser side provides a `markdownSource` service so sibling plugins do not have to reimplement the
same projection:

```js
const source = ctx.get('markdownSource')
source.fromRange(range)           // DOM Range → Markdown ('' when empty)
source.fromNodes(nodeList)        // node list → Markdown
source.fromHtml(htmlString)       // HTML string → Markdown
source.fromSelection()            // current browser selection → Markdown
source.isTranscriptRange(range)   // whether the range sits in a transcript row
```

When the service is missing, fall back to plain text — nothing breaks.

## How it works

The serializer walks a **cloned DOM**, because a selection is an arbitrary DOM range and the rendered
tree is the only thing that still knows its boundaries. Precision comes from a handful of structural
facts in the rendered tree (all re-checked against the installed `0.2.2-rc.5` build):

| Rendered form | DOM fact | Reconstruction |
|---|---|---|
| Math | KaTeX emits `<annotation encoding="application/x-tex">` inside the MathML arm; the visual `.katex-html` arm is `aria-hidden` | Read the annotation for the TeX; skip the visual arm so a formula never counts twice |
| Code block | Highlighting is just nested `<span>`s; the language lives in the `[data-code-block-banner]` banner | `textContent` is the source; skip the banner |
| Diff card | Root `[data-diff]`, rows carry `data-diff-line` | Rebuild `- `/`+ `/`  ` by row kind, wrap in a ```` ```diff ```` fence |
| Terminal block | Root `[data-terminal]`: a prompt header plus one `div` per output line | One fence with the command and output lines; blank lines preserved |
| Footnotes | Bare `<sup>1</sup>` references, definitions in `section[data-footnotes] > ol > li` | `[^1]` references and `[^1]: …` definitions; `↩` backlinks and `sr-only` text dropped |
| Everything else | Headings, lists, tables, quotes and inline styles are semantic tags | Rebuilt from the tags; buttons, icons, svg and `aria-hidden` nodes skipped |

Notable choices:

- Inline code that contains backticks upgrades its fence; fenced code that contains a run of backticks
  upgrades too, so the produced Markdown always parses.
- A selection that touches only part of a bold run is widened to the whole node, so `**` is not lost.
- Blank lines inside code blocks are preserved; blocks are joined with a single blank line.
- When a selection covers only part of a formula, the fragment is **reconstructed** by walking the
  MathML tree in layout order and slicing the visual text — never by guessing character offsets. Unknown
  constructs fall back to the whole formula, which is always correct.

### Escaping: text nodes only

Because the clipboard carries source, prose that looks like Markdown is escaped: `*args` → `\*args`,
line-leading `#`/`-`/`+`/`>`/`1.` → `\#`/`\-`/…, any `$` → `\$`, backticks and `~` escaped, a leading
`[1]: x` → `[1]\: x`, leading four spaces or a tab → `&#32;`/`&#9;`, trailing `\` → `\\`, `[x](y)` →
`\[x](y)`. Markers the serializer generates itself are added *after* escaping, so they are never
mangled, and `<code>`/`<pre>` content is left untouched.

### The character → macro table is generated

Hand-written maps miss cases (`\Longrightarrow` once came out as a bare `⟹`), so the table is derived
from KaTeX itself: `tools/gen-unicode-tex.mjs` reads KaTeX' `src/symbols.ts` and `src/macros.ts`,
renders all 774 macros and records the canonical macro per character (429 mappings) and the node
signatures (478, covering font attributes such as `\mathbf`). Re-run
`node tools/gen-unicode-tex.mjs --write` after a KaTeX upgrade.

## Known limitations

- Only copies inside the transcript are intercepted; editable fields, the sidebar and settings pages are not.
- A formula selected in full yields the author's source; a partial selection yields reconstructed but
  equivalent source. Constructs the walker cannot verify (`\underbrace`, macro-built shapes, and the
  ~10% of macros whose glyphs are assembled from several pieces, such as `\neq`) fall back to the whole formula.
- Mermaid diagrams and image previews are treated as plain images or skipped; their definitions are not restored.
- Footnote references become `[^n]` only when the definition list is selected too; otherwise they stay inline HTML.
- Terminal blocks and diff cards are recognised by full coverage; selecting one or two lines gives those
  lines verbatim, without inventing `+`/`-`.
- `<mark>`, `<u>`, `<kbd>`, `<sup>` and `<sub>` fall back to inline HTML, which Harness renders as literal
  text when pasted back (GitHub renders it correctly).
- Hard breaks become `\` + newline; inside headings and table cells they become spaces.
- A selection entirely inside a user or steering bubble copies the original input verbatim (no escaping),
  preserving its line breaks with two trailing spaces.
- Selecting only part of a code block yields the raw text, without a fence — convenient for editors and
  terminals, but a Markdown target will re-parse it.

## Verification

```sh
npm install
node --check client.js && node --check index.js
node tools/verify-core.mjs      # 152 assertions
```

The suite covers inline and display math, KaTeX error fallback, partial-formula reconstruction, fragment
equivalence (re-rendered with KaTeX and compared node by node against the source MathML subtree), many
selection edge cases, headings/lists/quotes/tables/inline styles/task lists, code-block banners and
languages, fence upgrades, table escaping, bold snapping, transcript-versus-composer detection, every
escaping rule, links and images, table alignment, `mark`/`u`/`sup`/`sub`, diff cards, terminal blocks,
footnotes, the end-to-end copy event, and linear timing on large selections.

`jsdom` and `katex` are devDependencies: the former supplies a real DOM, the latter backs the fragment
equivalence check (kept at the same version as the KaTeX shipped in Harness).

## Compatibility

| Item | Value |
|---|---|
| Declared support | DSH `>=0.2.2-rc.3 <0.3.0` (`engines.dsh`) |
| Last checked | DSH `0.2.2-rc.5` |
| Transcript | `data-conversation-session`, `data-composer-seat`, `data-chat-flow-key`, `data-chat-turn`, `data-chat-flow`, `data-chat-flow-kind` (`user` / `steering`) |
| Content blocks | `data-code-block-banner`, `data-code-block-content`, `data-diff` / `data-diff-line`, `data-terminal`, `data-footnotes` |
| Math | KaTeX `.katex-mathml annotation[encoding="application/x-tex"]`; `.katex-html` is `aria-hidden` |

These seams carry no compatibility promise: if a Harness release renames them, copying silently falls
back to the browser default. After upgrading Harness, run the suite and copy one answer that contains a
formula, a code block and a table.

## License

[MIT](LICENSE) © 2026 Rayzenchen
