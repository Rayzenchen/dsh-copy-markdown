/**
 * Client half of `@local/dsh-copy-markdown`.
 *
 * Two things, one serializer:
 *
 *  1. A capture-phase `copy` listener: a selection inside a transcript row is
 *     re-serialized to Markdown source and put on the clipboard, replacing the
 *     rendered plain text the browser would have copied.
 *  2. A `markdownSource` client service, so other plugins (the quote-annotate
 *     plugin) can ask for the same projection without duplicating it.
 *
 * The serializer walks the cloned DOM rather than the app state, because a
 * selection is an arbitrary DOM range and the rendered tree is the only thing
 * that still knows its boundaries. What makes it accurate:
 *
 *  - KaTeX: DSH renders TeX through `katex.renderToString`, so every formula
 *    carries its source in `<annotation encoding="application/x-tex">` inside
 *    the MathML arm. That arm is read; the visual `.katex-html` arm is
 *    `aria-hidden` and skipped, so a formula never double-counts. Because the
 *    pointer drags over the VISUAL arm (the source arm is clipped to 1px), an
 *    endpoint that lands inside a formula is pushed out onto the formula's own
 *    edge, so any overlap with a formula comes back as one `$…$`.
 *  - Code: highlighted code is nested spans, so `textContent` IS the source.
 *  - Chrome: buttons, icons (svg), and anything `aria-hidden` are skipped.
 *
 * Two further rules make the output paste back as the same content:
 *
 *  - Literal prose is escaped (`*args`, `# ` at a line start, `$5 … $10`,
 *    a stray backtick), so text that merely LOOKS like Markdown is not
 *    re-parsed into emphasis, headings or math on the way back in.
 *  - Blocks whose source is not their text are reassembled from the shell's
 *    own rendering: diff cards (```diff), terminal blocks (command + output)
 *    and footnotes (`[^1]` + definitions).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-copy-markdown',
  factory() {
    /** Service name other plugins look up with `ctx.get(...)`. */
    const SERVICE = 'markdownSource'
    /** Transcript rows (installed shell: ui-chat flow item / turn-process seat). */
    const ROW_SELECTOR = '[data-chat-flow-key], [data-chat-turn], [data-chat-flow]'
    /** The per-session conversation pane. */
    const PANE_SELECTOR = '[data-conversation-session]'
    /** The composer seat inside the same scroll body. */
    const COMPOSER_SELECTOR = '[data-composer-seat]'

    /* ---------------------------------------------------------------- *
     * DOM shape helpers
     * ---------------------------------------------------------------- */

    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : (node.parentElement ?? null)
    }

    function tagOf(el) {
      return el.tagName === undefined ? '' : el.tagName.toLowerCase()
    }

    /**
     * The transcript row an element belongs to, or null when it is not part of a
     * conversation transcript (composer, sidebar, our own cards, …).
     */
    function transcriptRowOf(el) {
      if (el === null) return null
      if (typeof el.closest !== 'function') return null
      const row = el.closest(ROW_SELECTOR)
      if (row === null) return null
      if (row.closest(COMPOSER_SELECTOR) !== null) return null
      if (row.closest(PANE_SELECTOR) === null) return null
      return row
    }

    /** Whether both ends of a range sit in transcript rows. */
    function rangeInTranscript(range) {
      return transcriptRowOf(elementOf(range.startContainer)) !== null
        && transcriptRowOf(elementOf(range.endContainer)) !== null
    }

    /* ---------------------------------------------------------------- *
     * Markdown serializer
     * ---------------------------------------------------------------- */

    /** Elements that are pure chrome: never part of the copied source. */
    const SKIPPED_TAGS = new Set([
      'button', 'svg', 'script', 'style', 'noscript', 'template', 'canvas', 'video', 'audio', 'iframe',
    ])

    /** Tags that start a new block when they appear in block context. */
    const BLOCK_TAGS = new Set([
      'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt', 'fieldset',
      'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
      'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
    ])

    /** Nodes that are slices of one table; consecutive ones form a single table. */
    const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr'])

    function isSkipped(el) {
      const tag = tagOf(el)
      if (SKIPPED_TAGS.has(tag)) return true
      if (typeof el.getAttribute !== 'function') return false
      if (el.getAttribute('aria-hidden') === 'true') return true
      if (el.getAttribute('hidden') !== null) return true
      // Visually hidden text is accessibility scaffolding, not content — the
      // shell labels its footnote list with an `sr-only` heading.
      const list = classListOf(el)
      if (list !== null && list.contains('sr-only')) return true
      // The code block's own banner / toolbar: language chip, filename, copy and
      // wrap buttons — chrome, and its text would otherwise leak into the fence.
      if (el.hasAttribute('data-code-block-banner')) return true
      return false
    }

    function classListOf(el) {
      return el.classList === undefined ? null : el.classList
    }

    function isKatex(el) {
      const list = classListOf(el)
      if (list === null) return false
      return list.contains('katex') || list.contains('katex-display') || list.contains('katex-error')
    }

    /**
     * The math an element carries, and whether it is a block.
     *
     * Three shapes reach the serializer:
     *  - our own placeholder (a live-range splice): it carries the TeX in an
     *    attribute, and its tag decides inline vs block;
     *  - a formula ROOT (`.katex` / `.katex-display` / `.katex-error`): the TeX is
     *    read from the MathML annotation, and `.katex-display` decides block;
     *  - a KaTeX ARM (`.katex-html`, `.katex-mathml`, or any node inside them):
     *    it belongs to a root that is emitted separately, so it says nothing. A
     *    range that was snapped onto a formula clones to exactly one arm, which is
     *    why this case cannot rely on finding the parent root.
     * @param el - candidate element.
     * @returns { tex, display } or null when the element carries no math of its own.
     */
    function mathOf(el) {
      if (isMathPlaceholder(el)) {
        const tex = el.getAttribute(MATH_ATTR) ?? ''
        return tex === '' ? null : { tex, display: tagOf(el) === 'div' }
      }
      if (isKatex(el)) {
        const tex = texSourceOf(el).trim()
        return tex === '' ? null : { tex, display: isDisplayMath(el) }
      }
      if (isKatexPart(el)) return null
      return undefined
    }

    /** Whether an element is part of a KaTeX tree without being one of its roots. */
    function isKatexPart(el) {
      const list = classListOf(el)
      if (list !== null && (list.contains('katex-html') || list.contains('katex-mathml'))) return true
      if (typeof el.closest !== 'function') return false
      if (el.closest('.katex, .katex-display, .katex-error') !== null) return true
      return el.closest('.katex-html, .katex-mathml') !== null
    }

    /** Render one { tex, display } pair as Markdown. */
    function mathMarkdownOf(math) {
      return math.display ? `\n\n$$\n${math.tex}\n$$\n\n` : `$${math.tex}$`
    }

    function isDisplayMath(el) {
      const list = classListOf(el)
      if (list !== null && list.contains('katex-display')) return true
      const parent = el.parentElement
      if (parent === null || parent === undefined) return false
      const parentList = classListOf(parent)
      return parentList !== null && parentList.contains('katex-display')
    }

    /** The TeX source of one KaTeX tree (MathML annotation first). */
    function texSourceOf(el) {
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
      if (annotation !== null && annotation.textContent !== null && annotation.textContent !== '') {
        return annotation.textContent
      }
      const math = el.querySelector('math')
      const inner = math === null ? null : math.querySelector('annotation')
      if (inner !== null && inner.textContent !== null && inner.textContent !== '') return inner.textContent
      const title = typeof el.getAttribute === 'function' ? el.getAttribute('title') : null
      if (title !== null && title !== '') return el.textContent ?? ''
      return el.textContent ?? ''
    }

    /** The exact TeX a placeholder carries (filled by the live-range pass). */
    const MATH_ATTR = 'data-dsh-qa-math'

    function isMathPlaceholder(el) {
      return typeof el.getAttribute === 'function' && el.getAttribute(MATH_ATTR) !== null
    }

    /** Markdown for one element known to carry math ('' when it carries none). */
    function mathMarkdown(el) {
      const math = mathOf(el)
      return math === null || math === undefined ? '' : mathMarkdownOf(math)
    }

    /* ---------------------------------------------------------------- *
     * Literal text escaping
     *
     * What goes on the clipboard is SOURCE, so prose that merely looks like
     * Markdown must not be re-parsed when it is pasted back: a message holding
     * `*args`, a line starting with `- `, or a pair of dollar signs around an
     * amount would otherwise come back as emphasis, a bullet list or math.
     *
     * Only text nodes are escaped. Everything the serializer generates itself
     * (block markers, fences, `**`, formulas) is added afterwards and is never
     * touched by this pass.
     * ---------------------------------------------------------------- */

    /** `_` can only open/close emphasis when it is not intraword (CommonMark). */
    function escapeUnderscores(value) {
      return value.replace(/_/gu, (match, offset, whole) => {
        const before = offset === 0 ? '' : whole.charAt(offset - 1)
        const after = whole.charAt(offset + 1)
        return /[0-9A-Za-z]/u.test(before) && /[0-9A-Za-z]/u.test(after) ? match : '\\_'
      })
    }

    /**
     * `<` only matters when it would open a tag, an autolink or a comment.
     *
     * Linear on purpose: testing a regex against `whole.slice(offset)` for every
     * `<` was quadratic, and a long run of `<` in a pasted log froze the copy.
     * The next `>`, newline, whitespace and `@` are precomputed instead, and each
     * `<` only looks at its own tag-name / scheme run (which never overlap).
     */
    function escapeAngles(value) {
      if (!value.includes('<')) return value
      const n = value.length
      const nextGt = new Int32Array(n + 1)
      const nextNl = new Int32Array(n + 1)
      const nextWs = new Int32Array(n + 1)
      const nextAt = new Int32Array(n + 1)
      nextGt[n] = nextNl[n] = nextWs[n] = nextAt[n] = n
      for (let i = n - 1; i >= 0; i -= 1) {
        const char = value.charAt(i)
        nextGt[i] = char === '>' ? i : nextGt[i + 1]
        nextNl[i] = char === '\n' ? i : nextNl[i + 1]
        nextWs[i] = /\s/u.test(char) ? i : nextWs[i + 1]
        nextAt[i] = char === '@' ? i : nextAt[i + 1]
      }
      const isAlpha = (char) => /[A-Za-z]/u.test(char)
      const markupAt = (i) => {
        if (value.startsWith('<!--', i)) return true
        let j = i + 1
        if (value.charAt(j) === '/') j += 1
        // Tag: name, then `>` or whitespace + attributes (no newline) + `>`.
        if (isAlpha(value.charAt(j))) {
          let k = j + 1
          while (k < n && /[A-Za-z0-9-]/u.test(value.charAt(k))) k += 1
          if (value.charAt(k) === '>') return true
          if (k < n && /\s/u.test(value.charAt(k)) && nextGt[k + 1] < n && nextGt[k + 1] < nextNl[k + 1]) return true
        }
        // Autolink: scheme `:` then no whitespace / `>` until the closing `>`.
        if (isAlpha(value.charAt(i + 1))) {
          let k = i + 2
          while (k < n && /[A-Za-z0-9+.-]/u.test(value.charAt(k))) k += 1
          if (value.charAt(k) === ':' && nextGt[k + 1] < n && nextGt[k + 1] <= nextWs[k + 1]) return true
        }
        // Email autolink: local part, `@`, domain, `>` — no whitespace anywhere.
        const at = nextAt[i + 1]
        if (at > i + 1 && at < n && at < nextGt[i + 1] && at < nextWs[i + 1]) {
          const close = nextGt[at + 1]
          if (close > at + 1 && close < n && close <= nextWs[at + 1]) return true
        }
        return false
      }
      let out = ''
      for (let i = 0; i < n; i += 1) {
        const char = value.charAt(i)
        out += char === '<' && markupAt(i) ? '\\<' : char
      }
      return out
    }

    /** `&amp;` in prose would render as `&`; an entity-looking run is escaped. */
    function escapeAmpersands(value) {
      return value.replace(/&(?=[A-Za-z][A-Za-z0-9]{1,31};|#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};)/gu, '\\&')
    }

    /**
     * `$…$` is inline math in this renderer (micromark-extension-math with
     * `singleDollarTextMath` on, which — unlike pandoc — does NOT require the
     * content to hug the dollars: `$5 and $10` renders `5 and ` as math). A
     * pair can also straddle formatting (`$5 **and** $10`), so every dollar is
     * escaped; `\$` renders as a plain `$`.
     */
    function escapeDollars(value) {
      return value.replace(/\$/gu, '\\$')
    }

    /**
     * One run of literal text → the source form that renders back to the same
     * characters. `label` mode is stricter: inside a link/image label a bare
     * `[`/`]` breaks the surrounding construct, so both are always escaped and
     * the link-oriented heuristic is skipped.
     * @param value - literal text.
     * @param options - `{ label: true }` while serializing a label.
     * @returns escaped source text.
     */
    function escapeInlineText(value, options) {
      const label = options !== undefined && options.label === true
      let out = String(value)
        .replace(/\\/gu, '\\\\')
        .replace(/`/gu, '\\`')
        .replace(/\*/gu, '\\*')
        // GFM strikethrough here accepts a SINGLE tilde (`~a~` → <del>), so
        // every tilde is escaped, not only `~~`.
        .replace(/~/gu, '\\~')
      out = escapeUnderscores(out)
      out = escapeDollars(out)
      out = escapeAngles(out)
      out = escapeAmpersands(out)
      if (label) return out.replace(/[[\]]/gu, '\\$&')
      return out
        .replace(/\[\^/gu, '\\[^')
        .replace(/!?\[[^\]\n]*\]\s*[(\[]/gu, (match) => match.replace('[', '\\['))
    }

    /**
     * A line start that would turn literal prose into a block construct:
     * headings, quotes, bullets, ordered items, thematic breaks, fences, and
     * four-space indentation (which would read as an indented code block).
     */
    function escapeLineStart(line) {
      if (line === '') return line
      const indent = /^[ \t]+/u.exec(line)
      if (indent !== null && (indent[0].includes('\t') || indent[0].length >= 4)) {
        // `&#32;`/`&#9;` keeps the character without the block meaning.
        return (line.charAt(0) === '\t' ? '&#9;' : '&#32;') + line.slice(1)
      }
      // Up to three leading spaces do not stop a block construct.
      const lead = indent === null ? '' : indent[0]
      const rest = line.slice(lead.length)
      if (/^#{1,6}(?:\s|$)/u.test(rest)) return `${lead}\\${rest}`
      if (/^>/u.test(rest)) return `${lead}\\${rest}`
      if (/^[-+](?:\s|$)/u.test(rest)) return `${lead}\\${rest}`
      const ordered = /^(\d{1,9})([.)])(?:\s|$)/u.exec(rest)
      if (ordered !== null) return lead + rest.replace(ordered[2], `\\${ordered[2]}`)
      // Setext underlines (a single `=`/`-` is enough after a hard break) and
      // `-` thematic breaks. `*`, `_`, `` ` `` and `~` are NOT tested here:
      // literal text already escapes every one of them, so a run at a line start
      // can only be markup the serializer generated (`***x***`, a code span
      // ```` ```` ```` …) and escaping it corrupted that markup.
      if (/^(?:=+|-+)[ \t]*$/u.test(rest) || /^(?:-[ \t]*){3,}$/u.test(rest)) return `${lead}\\${rest}`
      // A link reference definition would vanish from the paste and swallow
      // the line; escaping the colon keeps the label (and any `[^n]`) intact.
      const definition = /^(!?\[(?:\\.|[^\]\\])*\]):/u.exec(rest)
      if (definition !== null) return `${lead}${definition[1]}\\:${rest.slice(definition[0].length)}`
      return line
    }

    /** Literal text spanning lines → source whose every line start stays literal. */
    function escapeBlockText(value) {
      return String(value).split('\n').map(escapeLineStart).join('\n')
    }

    /** Inline-code fence that survives backticks in the content. */
    function inlineCode(text) {
      // The fence must differ from EVERY backtick run inside, not just the first.
      let longest = 0
      for (const run of String(text).match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
      const fence = '`'.repeat(longest + 1)
      // CommonMark strips one space from each side when both are present, and a
      // content backtick next to the fence would merge with it.
      const pad = text.startsWith('`') || text.endsWith('`')
        || (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '')
        ? ' ' : ''
      return `${fence}${pad}${text}${pad}${fence}`
    }

    /**
     * A fence long enough to survive the content. A pasted code block containing
     * ``` would otherwise close the fence early and emit unparseable Markdown.
     */
    function fenceFor(text) {
      let longest = 0
      // A closing fence may be indented up to three spaces.
      for (const run of String(text).matchAll(/^ {0,3}(`{3,})/gmu)) longest = Math.max(longest, run[1].length)
      // A closing fence may not be longer than its opener, so one backtick more.
      return '`'.repeat(Math.max(3, longest + 1))
    }

    /**
     * A link destination that survives the characters which would end it early:
     * a space, a parenthesis, or an angle bracket wraps the URL in `<…>`.
     */
    function linkDestination(href) {
      // A backslash before punctuation is an escape in a destination, so a
      // literal one is doubled (`a\_b` would otherwise come back as `a_b`).
      const url = String(href ?? '').replace(/\\/gu, '\\\\')
      if (url === '') return ''
      if (!/[\s()<>]/u.test(url)) return url
      const encoded = url.replace(/</gu, '%3C').replace(/>/gu, '%3E')
        .replace(/\s/gu, (char) => encodeURIComponent(char))
      return `<${encoded}>`
    }

    /** `[label](target)`, or the image form when `image` is true. */
    function linkMarkdown(label, href, image) {
      return `${image === true ? '!' : ''}[${label}](${linkDestination(href)})`
    }

    /** A `<br>` inside a paragraph: backslash + newline (a bare `\n` is a soft break). */
    const HARD_BREAK = '\\\n'

    /**
     * Cloned text nodes whose LIVE originals sit in a `white-space: pre*`
     * container. The copy path serializes a detached clone, where class-based
     * CSS (DSH's user bubble is `MessageText.module.css`) no longer resolves, so
     * the decision is made on the live tree and carried over here.
     */
    let preWrapTexts = new WeakSet()

    /**
     * Whether a text node's literal newlines are real line breaks. `white-space`
     * inherits, but a computed style may not report it (jsdom does not), so the
     * nearest ancestor that declares one decides. Code has its own serializer.
     */
    function isPreWrapText(node) {
      if (preWrapTexts.has(node)) return true
      const view = node.ownerDocument?.defaultView
      const live = node.isConnected === true && view !== null && view !== undefined
        && typeof view.getComputedStyle === 'function'
      for (let el = node.parentElement; el !== null && el !== undefined; el = el.parentElement) {
        const tag = tagOf(el)
        if (tag === 'pre' || tag === 'code') return false
        // Detached markup (an HTML string) has no stylesheet: inline style only.
        const value = live ? view.getComputedStyle(el).whiteSpace : el.style?.whiteSpace
        if (typeof value === 'string' && value !== '' && value !== 'inherit') return /^(?:pre|break-spaces)/u.test(value)
      }
      return false
    }

    /**
     * A text node → inline source. In a pre-wrap container a literal newline is
     * a visible line break, so it becomes a hard break; in normal flow it stays
     * a soft newline (rendered as a space). A continuation line's leading
     * whitespace would be stripped after the break, so its first character is
     * written as an entity, and its block-start is escaped like any other line.
     */
    function textSource(node, context) {
      const value = node.nodeValue ?? ''
      if (!value.includes('\n') || !isPreWrapText(node)) return escapeInlineText(value, context)
      return value.split('\n').map((line, index) => {
        const text = escapeInlineText(line, context)
        if (index === 0) return text
        if (text.trim() === '') return ''
        const lead = /^[ \t]/u.exec(text)
        if (lead === null) return escapeLineStart(text)
        return (lead[0] === '\t' ? '&#9;' : '&#32;') + escapeLineStart(text.slice(1))
      }).join(HARD_BREAK)
    }

    /**
     * Where a node sits relative to a range's two boundary points, in constant
     * time per node. Blink's `intersectsNode` (and jsdom's whole Range) costs
     * time proportional to the selection, so asking it per node made large
     * selections quadratic; `compareDocumentPosition` against the boundary
     * nodes does not.
     */
    function rangeBounds(range) {
      // A boundary point as (container, offset) → the node right after it, or
      // the container itself when the point is at its end.
      const boundary = (container, offset) => {
        if (container.nodeType === 3 || container.nodeType === 4 || container.nodeType === 8) return { text: container, offset }
        return { after: container.childNodes[offset] ?? null, container }
      }
      const start = boundary(range.startContainer, range.startOffset)
      const end = boundary(range.endContainer, range.endOffset)
      // Node entirely before the start point (it neither is nor contains the
      // start's text / the node right after the start point).
      const beforeStart = (node) => {
        if (start.text !== undefined) {
          // The boundary's own text node always intersects (its clone may be empty).
          if (node === start.text) return false
          const pos = node.compareDocumentPosition(start.text)
          return (pos & 4) !== 0 && (pos & 16) === 0
        }
        if (start.after !== null) {
          if (node === start.after) return false
          const pos = node.compareDocumentPosition(start.after)
          return (pos & 4) !== 0 && (pos & 16) === 0
        }
        // Point at the container's end: everything inside or before it.
        if (start.container.contains(node)) return node !== start.container
        const pos = node.compareDocumentPosition(start.container)
        return (pos & 4) !== 0 && (pos & 16) === 0
      }
      // Node entirely after the end point (it starts at or after it).
      const afterEnd = (node) => {
        if (end.text !== undefined) {
          if (node === end.text) return false
          const pos = node.compareDocumentPosition(end.text)
          return (pos & 2) !== 0 && (pos & 8) === 0
        }
        if (end.after !== null) {
          if (node === end.after || end.after.contains(node)) return true
          const pos = node.compareDocumentPosition(end.after)
          return (pos & 2) !== 0 && (pos & 8) === 0
        }
        if (end.container.contains(node)) return false
        const pos = node.compareDocumentPosition(end.container)
        return (pos & 2) !== 0 && (pos & 8) === 0
      }
      return { start, end, beforeStart, afterEnd }
    }

    /**
     * The live text nodes a range intersects, in document order — the same
     * set `range.intersectsNode` would accept, but linear.
     */
    function liveTextsInRange(range) {
      const root = range.commonAncestorContainer
      if (root === null || root === undefined) return []
      if (root.nodeType === 3) return [root]
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return []
      const owner = root.nodeType === 9 ? root : (root.ownerDocument ?? document)
      const { beforeStart, afterEnd } = rangeBounds(range)
      const out = []
      const walker = owner.createTreeWalker(root, 4)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (afterEnd(node)) break
        if (!beforeStart(node)) out.push(node)
      }
      return out
    }

    /** `range.toString()`, linear (jsdom's is quadratic in the selection). */
    function rangeText(range) {
      const sc = range.startContainer
      const ec = range.endContainer
      if (sc === ec && sc.nodeType === 3) return (sc.nodeValue ?? '').slice(range.startOffset, range.endOffset)
      let out = ''
      for (const node of liveTextsInRange(range)) {
        const value = node.nodeValue ?? ''
        const from = node === sc ? range.startOffset : 0
        const to = node === ec ? range.endOffset : value.length
        out += value.slice(from, to)
      }
      return out
    }

    /**
     * `range.cloneContents()`, linear: the spec's clone algorithm, but only the
     * ancestors of the two boundary points are descended into; every other
     * child is either skipped or deep-cloned whole.
     */
    function cloneRangeContents(range) {
      const sc = range.startContainer
      const ec = range.endContainer
      const so = range.startOffset
      const eo = range.endOffset
      const root = range.commonAncestorContainer
      const owner = root.nodeType === 9 ? root : (root.ownerDocument ?? document)
      const fragment = owner.createDocumentFragment()
      if (range.collapsed) return fragment
      const isData = (node) => node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 7 || node.nodeType === 8
      const sliced = (node) => {
        const copy = node.cloneNode(false)
        const value = node.data ?? ''
        copy.data = value.slice(node === sc ? so : 0, node === ec ? eo : value.length)
        return copy
      }
      if (isData(root)) {
        fragment.appendChild(sliced(root))
        return fragment
      }
      // Inclusive ancestors of the boundary containers: the only partially
      // contained nodes.
      const partial = new Set()
      for (const node of [sc, ec]) {
        for (let cursor = node; cursor !== null && cursor !== root; cursor = cursor.parentNode) partial.add(cursor)
      }
      const { beforeStart, afterEnd } = rangeBounds(range)
      const fill = (parent, target) => {
        for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
          if (beforeStart(child)) continue
          if (afterEnd(child)) break
          if (isData(child)) {
            target.appendChild(sliced(child))
          } else if (partial.has(child)) {
            const shallow = child.cloneNode(false)
            target.appendChild(shallow)
            fill(child, shallow)
          } else {
            target.appendChild(child.cloneNode(true))
          }
        }
      }
      fill(root, fragment)
      return fragment
    }

    /**
     * Pair the range's live text nodes with the clone's (same document order)
     * and record which clones are pre-wrap, then run `run`. Any mismatch in the
     * pairing marks nothing: the clone then falls back to inline styles.
     */
    function withPreWrap(range, cloned, run) {
      const previous = preWrapTexts
      preWrapTexts = new WeakSet()
      try {
        const owner = cloned.ownerDocument ?? document
        const clones = []
        const cloneWalker = owner.createTreeWalker(cloned, 4)
        for (let node = cloneWalker.nextNode(); node !== null; node = cloneWalker.nextNode()) clones.push(node)
        if (clones.some((node) => (node.nodeValue ?? '').includes('\n'))) {
          const lives = liveTextsInRange(range)
          const paired = lives.length === clones.length
            && clones.every((node, index) => (lives[index].nodeValue ?? '').includes(node.nodeValue ?? ''))
          if (paired) {
            clones.forEach((node, index) => {
              if ((node.nodeValue ?? '').includes('\n') && isPreWrapText(lives[index])) preWrapTexts.add(node)
            })
          }
        }
        return run()
      } finally {
        preWrapTexts = previous
      }
    }

    /** Task-list checkboxes already emitted as an item's marker. */
    let markerCheckboxes = new WeakSet()

    function inlineChildren(el, context) {
      let out = ''
      for (const child of el.childNodes) out += serializeInline(child, context)
      return out
    }

    function serializeInline(node, context) {
      const ctx = context ?? {}
      if (node.nodeType === 3) return textSource(node, ctx)
      if (node.nodeType !== 1) return ''
      const el = node
      if (isSkipped(el)) return ''
      const tag = tagOf(el)
      if (tag === 'br') return HARD_BREAK
      if (tag === 'input') {
        if (markerCheckboxes.has(el)) return ''
        if (el.getAttribute('type') !== 'checkbox') return ''
        return el.hasAttribute('checked') ? '[x] ' : '[ ] '
      }
      if (tag === 'img') {
        const alt = escapeInlineText(el.getAttribute('alt') ?? '', { label: true })
        return linkMarkdown(alt, el.getAttribute('src'), true)
      }
      const math = mathOf(el)
      if (math === null) return ''
      if (math !== undefined) return mathMarkdownOf(math)
      if (tag === 'code') return inlineCode(el.textContent ?? '')
      // A rendered footnote reference is a bare `<sup>1</sup>`; only the shell's
      // own list makes that a reference rather than literal superscript.
      if (tag === 'sup') {
        const reference = footnoteRefOf(el)
        if (reference !== null) return `[^${reference}]`
      }
      const inner = inlineChildren(el, ctx)
      if (inner.trim() === '') return ''
      // Known limit: `**“注意”**是` is not right-flanking in CommonMark, so the
      // paste shows literal asterisks. There is no fallback — DSH's renderer
      // prints inline HTML (`<strong>`) as text, which would be worse.
      switch (tag) {
        case 'strong':
        case 'b':
          return `**${inner}**`
        case 'em':
        case 'i':
          return `*${inner}*`
        case 'del':
        case 's':
        case 'strike':
          return `~~${inner}~~`
        // No Markdown syntax exists for these, so they round-trip as the inline
        // HTML that produced them — dropping the markers would silently flatten
        // the text.
        case 'mark':
          return `<mark>${inner}</mark>`
        case 'u':
          return `<u>${inner}</u>`
        case 'kbd':
          return `<kbd>${inner}</kbd>`
        case 'sup':
          return `<sup>${inner}</sup>`
        case 'sub':
          return `<sub>${inner}</sub>`
        case 'a':
          // The label is the one place where a bare `[`/`]` would end the link,
          // so its text is escaped in label mode.
          return linkMarkdown(inlineChildren(el, { ...ctx, label: true }), el.getAttribute('href'))
        default:
          return inner
      }
    }

    /**
     * Every hard break (`\` + newline whose backslash is not itself escaped)
     * replaced by `replacement`. Literal backslashes are always doubled by
     * `escapeInlineText`, so parity tells the two apart.
     */
    function replaceHardBreaks(text, replacement) {
      return text.replace(/(?<!\\)((?:\\\\)*)\\\n/gu, (_match, pairs) => `${pairs}${replacement}`)
    }

    /**
     * Trim a run of inline source. A `<br>` at either edge of a block has no
     * meaning in Markdown, and once the newline is trimmed away its backslash
     * would be left dangling as a literal `\`.
     */
    function trimInline(text) {
      // DSH renders a break as `<br>` + "\n", so the text after it often starts
      // with a newline; `\` + "\n" + "\n" would end the paragraph instead.
      let out = text.replace(/(?<!\\)((?:\\\\)*)\\\n\s*/gu, (_match, pairs) => `${pairs}${HARD_BREAK}`).trim()
      for (;;) {
        const before = out
        while (out.startsWith(HARD_BREAK)) out = out.slice(HARD_BREAK.length).trim()
        const trailing = /\\+$/u.exec(out)
        if (trailing !== null && trailing[0].length % 2 === 1) out = out.slice(0, -1).trim()
        if (out === before) return out
      }
    }

    function serializeBlocks(nodes, joiner) {
      const out = []
      let buffer = ''
      const flush = () => {
        const text = escapeBlockText(trimInline(buffer))
        if (text !== '') out.push(text)
        buffer = ''
      }
      const list = Array.from(nodes)
      for (let index = 0; index < list.length; index += 1) {
        const node = list[index]
        if (node.nodeType === 3) {
          buffer += textSource(node, {})
          continue
        }
        if (node.nodeType !== 1) continue
        const el = node
        // Math is settled before the chrome filter: KaTeX arms carry aria-hidden.
        const math = mathOf(el)
        if (math === null) continue
        if (math !== undefined) {
          if (math.display) {
            flush()
            out.push(mathMarkdownOf(math).trim())
          } else {
            buffer += mathMarkdownOf(math)
          }
          continue
        }
        // Blocks whose source is not their text — diff cards, terminal output,
        // footnote lists — are reassembled by their own serializer.
        const special = specialBlock(el)
        if (special !== null) {
          flush()
          if (special !== '') out.push(special)
          continue
        }
        if (isSkipped(el)) continue
        const tag = tagOf(el)
        if (TABLE_PARTS.has(tag)) {
          flush()
          const rows = []
          while (index < list.length) {
            const part = list[index]
            const partTag = part.nodeType === 1 ? tagOf(part) : ''
            if (!TABLE_PARTS.has(partTag)) {
              // Whitespace between structural nodes belongs to the group.
              if (part.nodeType === 3 && (part.nodeValue ?? '').trim() === '') {
                index += 1
                continue
              }
              break
            }
            if (partTag === 'tr') rows.push(part)
            else rows.push(...part.querySelectorAll('tr'))
            index += 1
          }
          index -= 1
          const block = serializeRows(rows)
          if (block !== '') out.push(block)
          continue
        }
        if (tag === 'br') {
          buffer += HARD_BREAK
          continue
        }
        if (tag === 'hr') {
          flush()
          out.push('---')
          continue
        }
        if (BLOCK_TAGS.has(tag) || tag === 'math') {
          flush()
          const block = serializeBlock(el)
          if (block !== '') out.push(block)
          continue
        }
        buffer += serializeInline(el, {})
      }
      flush()
      return out.join(joiner ?? '\n\n')
    }

    /** A heading is one line: breaks become spaces, a closing `#` run stays text. */
    function headingText(el) {
      const inline = replaceHardBreaks(trimInline(inlineChildren(el, {})), ' ').replace(/\n+/gu, ' ').trim()
      // `## C# rocks #` would lose its last `#` as an optional closing sequence.
      return escapeLineStart(inline).replace(/(^|[ \t])(#+)$/u, '$1\\$2')
    }

    function serializeBlock(el) {
      const tag = tagOf(el)
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          return `${'#'.repeat(Number(tag.charAt(1)))} ${headingText(el)}`
        case 'p':
        case 'summary':
          return escapeBlockText(trimInline(inlineChildren(el, {})))
        case 'ul':
        case 'ol':
          return serializeList(el)
        case 'blockquote': {
          const inner = serializeBlocks([...el.childNodes])
          return inner.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')
        }
        case 'pre':
          return serializeCodeBlock(el)
        case 'table':
          return serializeTable(el)
        default:
          return serializeBlocks([...el.childNodes])
      }
    }

    function serializeList(list) {
      const ordered = tagOf(list) === 'ol'
      let index = Number.parseInt(list.getAttribute('start') ?? '1', 10)
      if (!Number.isFinite(index)) index = 1
      const items = [...list.children].filter((item) => tagOf(item) === 'li')
      // A list renders loose (items wrapped in <p>) exactly when its source had
      // blank lines between items; a tight list must stay tight, or a nested
      // list would turn every parent item into a paragraph on paste.
      const loose = items.some((item) => [...item.children].some((child) => tagOf(child) === 'p'))
      const lines = []
      for (const item of items) {
        // Only the item's OWN checkbox (direct, or in its leading <p>) is its
        // marker; `querySelector` would also find a nested task item's box.
        const checkbox = ownCheckboxOf(item)
        const number = ordered ? `${index}. ` : '- '
        if (ordered) index += 1
        let marker = number
        if (checkbox !== null) {
          marker = `${number}${checkbox.hasAttribute('checked') ? '[x] ' : '[ ] '}`
          markerCheckboxes.add(checkbox)
        }
        // Continuation lines align with the content after the list marker
        // (the `[ ] ` is content, not part of the marker).
        const pad = ' '.repeat(number.length)
        const parts = []
        for (const child of item.childNodes) {
          if (child === checkbox) continue
          parts.push(child)
        }
        const content = serializeBlocks(parts, loose ? '\n\n' : '\n')
        lines.push(content.split('\n').map((line, i) => {
          if (i === 0) return marker + line
          return line === '' ? '' : pad + line
        }).join('\n'))
      }
      return lines.join(loose ? '\n\n' : '\n')
    }

    function isCheckbox(node) {
      return node !== null && node !== undefined && node.nodeType === 1
        && tagOf(node) === 'input' && node.getAttribute('type') === 'checkbox'
    }

    /** The checkbox leading one list item, or null. */
    function ownCheckboxOf(item) {
      for (const child of item.childNodes) {
        if (child.nodeType === 3 && (child.nodeValue ?? '').trim() === '') continue
        if (isCheckbox(child)) return child
        if (child.nodeType === 1 && tagOf(child) === 'p') {
          const first = [...child.childNodes].find((node) => !(node.nodeType === 3 && (node.nodeValue ?? '').trim() === ''))
          return isCheckbox(first) ? first : null
        }
        return null
      }
      return null
    }

    /**
     * Languages that DSH substitutes for a label when highlighting is
     * unavailable (`supportsHighlighting(lang) ? lang : labels.codeLabel`), so a
     * banner reading "Code"/"代码" must not become a fence language.
     */
    const GENERIC_CODE_LABELS = new Set([
      'code', 'Code', 'CODE', '代码',
      'code block', 'Code block', '代码块',
      'codeblock', 'Codeblock',
      'bloc de code', 'Bloc de code',
      'コードブロック',
      'Блок кода',
      'bloque de código', 'Bloque de código',
      'bloco de código', 'Bloco de código',
      'codeblock',
    ])

    /** The `.md-code-block` root around a `<pre>`, when there is one. */
    function codeRootOf(pre) {
      if (typeof pre.closest !== 'function') return null
      const content = pre.closest('[data-code-block-content]')
      if (content !== null) return content.parentElement ?? null
      return pre.closest('.md-code-block')
    }

    /** Best-effort fence language: DSH banner first, then conventional classes. */
    function languageOf(pre, code) {
      const root = codeRootOf(pre)
      if (root !== null) {
        const banner = root.querySelector('[data-code-block-banner]')
        if (banner !== null) {
          const holder = banner.firstElementChild
          const cell = holder === null ? null : (holder.firstElementChild ?? holder)
          const text = cell === null ? '' : (cell.textContent ?? '').trim()
          if (text !== '' && !GENERIC_CODE_LABELS.has(text)) return text
        }
      }
      const className = typeof code.getAttribute === 'function' ? (code.getAttribute('class') ?? '') : ''
      const matched = /language-([\w+#.-]+)/u.exec(className)
      return matched === null ? '' : matched[1]
    }

    function serializeCodeBlock(pre) {
      const code = pre.querySelector('code') ?? pre
      const language = languageOf(pre, code)
      const text = (code.textContent ?? '').replace(/\n$/u, '')
      const fence = fenceFor(text)
      return `${fence}${language}\n${text}\n${fence}`
    }

    /**
     * A GFM cell is one line. A `<br>` there has no Markdown form DSH renders
     * (its renderer prints inline HTML as text), so breaks become spaces — and
     * a hard break's backslash must go with its newline, or it would be left
     * as a literal `\`.
     */
    function cellText(cell) {
      const source = serializeBlocks([...cell.childNodes])
      return replaceHardBreaks(source, ' ')
        .replace(/[\r\n]+/gu, ' ')
        .replace(/\|/gu, '\\|')
        .trim()
    }

    /** Column alignment of one rendered cell: `align="…"` or `text-align: …`. */
    function alignOf(cell) {
      if (typeof cell.getAttribute !== 'function') return ''
      const attribute = cell.getAttribute('align')
      if (attribute === 'left' || attribute === 'center' || attribute === 'right') return attribute
      const style = cell.getAttribute('style') ?? ''
      const matched = /text-align\s*:\s*(left|center|right)/iu.exec(style)
      return matched === null ? '' : matched[1].toLowerCase()
    }

    /** The delimiter cell carrying one column's alignment. */
    function alignMarker(align) {
      if (align === 'center') return ':---:'
      if (align === 'right') return '---:'
      if (align === 'left') return ':---'
      return '---'
    }

    /**
     * A selection can land on a whole table or on one of its structural slices
     * (`tbody`, a single `tr`); both have to come back as a GFM table, so the
     * rows are collected first and serialized together.
     */
    function serializeRows(rows) {
      if (rows.length === 0) return ''
      const cellsOf = (row) => [...row.children].filter((cell) => {
        const tag = tagOf(cell)
        return tag === 'td' || tag === 'th'
      })
      const head = cellsOf(rows[0])
      if (head.length === 0) return ''
      const lines = [
        `| ${head.map(cellText).join(' | ')} |`,
        `| ${head.map((cell) => alignMarker(alignOf(cell))).join(' | ')} |`,
      ]
      for (const row of rows.slice(1)) lines.push(`| ${cellsOf(row).map(cellText).join(' | ')} |`)
      return lines.join('\n')
    }

    function serializeTable(table) {
      return serializeRows([...table.querySelectorAll('tr')])
    }

    /* ---------------------------------------------------------------- *
     * Blocks the shell renders as something other than their source
     *
     * Diff cards and terminal output are line-oriented widget trees (the text is
     * split across spans, the `+`/`-` markers only exist as a class), and a
     * footnote list is numbered by rendering order. Each has to be reassembled
     * into the Markdown that reproduces it instead of being flattened into
     * paragraphs.
     * ---------------------------------------------------------------- */

    /** Roots whose source is not their text. */
    const WIDGET_SELECTOR = '[data-diff], [data-terminal], [data-footnotes]'

    /**
     * The widget a range covers completely, or null.
     *
     * A drag across a diff card or a terminal block starts and ends INSIDE it, so
     * the clone holds the widget's lines but not the widget: the meaning (line
     * kinds, one line per `div`, footnote numbering) lives on the root. When both
     * ends sit in the same widget and the selection is all of it, the root is what
     * gets serialized; a partial selection stays the plain lines it is.
     */
    function widgetRootOf(range) {
      const start = elementOf(range.startContainer)
      const end = elementOf(range.endContainer)
      if (start === null || end === null || typeof start.closest !== 'function') return null
      if (typeof end.closest !== 'function') return null
      const root = start.closest(WIDGET_SELECTOR)
      if (root === null || root !== end.closest(WIDGET_SELECTOR)) return null
      const selected = normalizeText(rangeText(range))
      if (selected === '' || selected !== normalizeText(root.textContent ?? '')) return null
      return root
    }

    /**
     * Whether a class token carries a given CSS-module local name. The shell's
     * bundles hash class names (`_line_17vb8_13`), so the local part is matched
     * between separators rather than the whole token.
     */
    const LOCAL_CLASS_PATTERNS = new Map()

    function hasLocalClass(el, name) {
      if (typeof el.getAttribute !== 'function') return false
      let pattern = LOCAL_CLASS_PATTERNS.get(name)
      if (pattern === undefined) {
        pattern = new RegExp(`(?:^|[_-])${name}(?:[_-]|$)`, 'iu')
        LOCAL_CLASS_PATTERNS.set(name, pattern)
      }
      const attribute = el.getAttribute('class') ?? ''
      for (const token of attribute.split(/\s+/u)) {
        if (token === '') continue
        if (token === name || pattern.test(token)) return true
      }
      return false
    }

    /** Line kinds of a rendered diff, and how each one is written back out. */
    const DIFF_KINDS = new Map([
      ['path', (text) => text],
      ['gap', (text) => text],
      ['del', (text) => `- ${text}`],
      ['add', (text) => `+ ${text}`],
      ['context', (text) => `  ${text}`],
    ])

    /** The kind of one diff line: `data-diff-line`, else the class local name. */
    function diffKindOf(el) {
      const explicit = typeof el.getAttribute === 'function' ? el.getAttribute('data-diff-line') : null
      if (explicit !== null && DIFF_KINDS.has(explicit)) return explicit
      for (const kind of DIFF_KINDS.keys()) {
        if (hasLocalClass(el, kind)) return kind
      }
      return ''
    }

    function isDiffCard(el) {
      return typeof el.hasAttribute === 'function' && el.hasAttribute('data-diff')
    }

    /**
     * A rendered diff card → one ```diff fence.
     *
     * The card keeps the hunk lines without their `+`/`-` markers (the kind is
     * only a class) and puts the path in its own line, so the source is rebuilt
     * the same way the shell's own copy button does it: path verbatim, then
     * `- `/`+ `/`  ` per line. The banner (language chip, filename, copy and wrap
     * buttons) and the expand button are chrome and contribute nothing.
     */
    function serializeDiffCard(el) {
      const lines = []
      for (const line of el.querySelectorAll('[data-diff-line], [class]')) {
        if (isSkipped(line) || tagOf(line) === 'button') continue
        const kind = diffKindOf(line)
        if (kind === '') continue
        lines.push(DIFF_KINDS.get(kind)(line.textContent ?? ''))
      }
      if (lines.length === 0) return ''
      const text = lines.join('\n')
      const fence = fenceFor(text)
      return `${fence}diff\n${text}\n${fence}`
    }

    function isTerminal(el) {
      return typeof el.hasAttribute === 'function' && el.hasAttribute('data-terminal')
    }

    /** One terminal line: its spans joined with the space the layout implies. */
    function terminalLineText(el) {
      let out = ''
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          out += child.nodeValue ?? ''
          continue
        }
        if (child.nodeType !== 1 || isSkipped(child)) continue
        const text = child.textContent ?? ''
        if (text === '') continue
        if (out !== '' && !/\s$/u.test(out) && !/^\s/u.test(text)) out += ' '
        out += text
      }
      return out.trim()
    }

    /**
     * A terminal block → one fence holding the command line(s) and the output.
     *
     * Every line is its own `div` (spans carry the ANSI styling), so a plain DOM
     * walk would either glue the lines together or put a blank line between each
     * pair. The run-state label, exit status and the expand/copy buttons are
     * chrome; the prompt and the output lines are the payload.
     */
    function serializeTerminal(el) {
      const header = el.firstElementChild
      const body = header === null ? null : header.nextElementSibling
      const lines = []
      const prompt = header === null ? null : header.firstElementChild
      if (prompt !== null) {
        for (const line of prompt.children) {
          if (tagOf(line) !== 'div') continue
          const text = terminalLineText(line)
          if (text !== '') lines.push(text)
        }
      }
      if (body !== null && tagOf(body) === 'div' && !hasLocalClass(body, 'empty')) {
        for (const line of body.children) {
          if (tagOf(line) !== 'div') continue
          lines.push(line.textContent ?? '')
        }
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      if (lines.length === 0) return ''
      const text = lines.join('\n')
      const fence = fenceFor(text)
      return `${fence}\n${text}\n${fence}`
    }

    /** The shell labels its footnote list with this attribute. */
    function isFootnoteSection(el) {
      return typeof el.hasAttribute === 'function' && el.hasAttribute('data-footnotes')
    }

    /**
     * A rendered footnote reference, or null.
     *
     * The renderer numbers references by order of first use and writes only that
     * number into the DOM (`<sup>1</sup>`), so the number IS the identifier a
     * round-tripped `[^1]`/`[^1]: …` pair needs. A `<sup>2</sup>` in prose is
     * left alone unless the same message actually carries a footnote list, which
     * is what keeps a literal superscript from turning into a dangling reference.
     */
    function footnoteRefOf(el) {
      const text = (el.textContent ?? '').trim()
      if (!/^\d{1,3}$/u.test(text)) return null
      const host = serializationScope
      if (host === null || typeof host.querySelector !== 'function') return null
      // Counted once per serialization: re-querying the scope for every numeric
      // `<sup>` made a long message with many superscripts quadratic.
      if (footnoteCount === undefined) {
        const section = host.querySelector('section[data-footnotes], [data-footnotes]')
        footnoteCount = section === null ? 0 : section.querySelectorAll('li').length
      }
      const count = footnoteCount
      const index = Number.parseInt(text, 10)
      return count > 0 && index <= count ? index : null
    }

    /** Whether an element is left with nothing to serialize. */
    function isEmptyWrapper(el) {
      if ((el.textContent ?? '') !== '') return false
      return el.querySelector('img, math, .katex, .katex-display') === null
    }

    /**
     * Drop the backlink run that follows a `↩` marker: repeat markers are `<sup>`
     * elements, and the separator spaces between them are part of the run.
     */
    function stripTrailingMarkers(container, from) {
      let node = from
      while (node !== null) {
        if (node.nodeType === 1 && tagOf(node) === 'sup') {
          const following = node.nextSibling
          container.removeChild(node)
          node = following
          continue
        }
        if (node.nodeType === 3 && (node.nodeValue ?? '').trim() === '') {
          const following = node.nextSibling
          container.removeChild(node)
          node = following
          continue
        }
        break
      }
    }

    /** The `↩` backlink the renderer appends to every definition. */
    function stripFootnoteBacklinks(fragment) {
      const owner = fragment.ownerDocument ?? document
      const marks = []
      const walker = owner.createTreeWalker(fragment, 1 | 4)
      let node = walker.nextNode()
      while (node !== null) {
        const value = node.textContent ?? node.nodeValue ?? ''
        if (value.trim() === '↩') marks.push({ node, truncate: false })
        // React merges adjacent strings, so the marker can also be the tail of
        // the definition's own text node.
        else if (node.nodeType === 3 && /↩\s*$/u.test(value)) marks.push({ node, truncate: true })
        node = walker.nextNode()
      }
      // Innermost first: a marker may be wrapped in a link, and dropping the
      // wrapper must not invalidate the marks collected inside it.
      marks.reverse()
      for (const mark of marks) {
        const target = mark.node
        const parent = target.parentNode
        if (parent === null) continue
        if (mark.truncate) {
          target.nodeValue = (target.nodeValue ?? '').replace(/\s*↩\s*$/u, '')
          stripTrailingMarkers(parent, target.nextSibling)
          if ((target.nodeValue ?? '') !== '') continue
          const following = target.nextSibling
          parent.removeChild(target)
          stripTrailingMarkers(parent, following)
          continue
        }
        const next = target.nextSibling
        parent.removeChild(target)
        stripTrailingMarkers(parent, next)
        let wrapper = parent
        while (wrapper !== null && wrapper !== fragment && isEmptyWrapper(wrapper)) {
          const outer = wrapper.parentNode
          if (outer === null) break
          const trailing = wrapper.nextSibling
          outer.removeChild(wrapper)
          stripTrailingMarkers(outer, trailing)
          wrapper = outer
        }
      }
    }

    /**
     * A rendered footnote list → `[^n]: …` definitions.
     *
     * Definitions are numbered in list order, which is exactly the numbering the
     * references used, so `[^1]` binds back to the same footnote after a paste.
     */
    function serializeFootnoteSection(section) {
      const out = []
      const items = [...section.querySelectorAll('ol > li')]
      items.forEach((item, index) => {
        const clone = item.cloneNode(true)
        stripFootnoteBacklinks(clone)
        const body = serializeBlocks([...clone.childNodes])
        if (body === '') return
        const lines = body.split('\n')
        // Continuation lines belong to the definition: four spaces, blank lines
        // left blank.
        const rest = lines.slice(1).map((line) => (line === '' ? '' : `    ${line}`))
        out.push([`[^${index + 1}]: ${lines[0]}`, ...rest].join('\n'))
      })
      return out.join('\n\n')
    }

    /** The reassembled source of a widget block, or null when it is ordinary DOM. */
    function specialBlock(el) {
      if (isFootnoteSection(el)) return serializeFootnoteSection(el)
      if (isDiffCard(el)) return serializeDiffCard(el)
      if (isTerminal(el)) return serializeTerminal(el)
      return null
    }

    /* ---------------------------------------------------------------- *
     * Part of a formula
     *
     * A formula's TeX source exists only on its root (the MathML annotation), so
     * a selection covering PART of one has no source of its own. What the shell
     * does keep is structure: the MathML arm is the parse tree, and the visual
     * arm lays that same tree out. Rebuilding a part therefore means mapping the
     * selected glyphs onto MathML leaves, growing them into the smallest
     * complete sub-expressions, and writing those back out as TeX.
     *
     * The mapping is done on TEXT, not on elements: the visual arm is read as
     * one string, each MathML node is laid out over a slice of it in the order
     * the layout uses (a fraction puts its denominator first, a root its index,
     * a matrix its columns), and every leaf has to match the characters it was
     * given. That check is what makes the result trustworthy — a wrong order
     * simply fails to line up and the whole extraction gives up, leaving the
     * caller to fall back to the whole formula, whose source is exact.
     *
     * The write-back reconstructs rather than recovers, so a fragment can differ
     * from the original source in style (`\dfrac` comes back as `\frac`) while
     * rendering the same math.
     * ---------------------------------------------------------------- */

    /** Characters that render as nothing: they never take part in alignment. */
    const INVISIBLE_CHARS = /[\u200b-\u200f\u2061-\u2064\ufe00-\ufe0f\u0300-\u036f\u20d0-\u20ff]/gu
    /** Decorations drawn as rules or SVG: present in MathML, invisible in layout. */
    const DECORATION_ONLY = /^[\u203e\u23de\u23df\u0332\u2192\u02c9]+$/u
    const MATHML_LEAF_TAGS = new Set(['mi', 'mo', 'mn', 'mtext', 'ms'])

    /**
     * MathML character → the TeX macro the shell rendered it from.
     *
     * DERIVED from KaTeX's own macro list (`tools/gen-unicode-tex.mjs` renders
     * every macro KaTeX defines and keeps one canonical name per character),
     * not hand-written: a character that came from a macro has no source left to
     * copy, and a hand-kept list is exactly why `\Longrightarrow` first came
     * back as a bare `⟹`. Regenerate after a KaTeX upgrade.
     */
    const TEX_OF_CHAR = new Map(Object.entries({
      // GENERATED:START — do not edit by hand; run tools/gen-unicode-tex.mjs
      // Derived from KaTeX 0.16.47 (tools/gen-unicode-tex.mjs).
      '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '\\': '\\backslash', '_': '\\_', '{': '\\{',
      '}': '\\}', ' ': '\\space', '£': '\\pounds', '¥': '\\yen', '§': '\\S', '©': '\\copyright',
      '¬': '\\neg', '®': '\\circledR', '°': '\\degree', '±': '\\pm', '¶': '\\P', 'Æ': '\\text{\\AE}',
      '×': '\\times', 'Ø': '\\text{\\O}', 'ß': '\\text{\\ss}', 'æ': '\\text{\\ae}', 'ð': '\\eth',
      '÷': '\\div', 'ø': '\\text{\\o}', 'ı': '\\text{\\i}', 'Œ': '\\text{\\OE}', 'œ': '\\text{\\oe}',
      'ȷ': '\\text{\\j}', 'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi',
      'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
      'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon', 'ζ': '\\zeta',
      'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
      'ν': '\\nu', 'ξ': '\\xi', 'ο': '\\omicron', 'π': '\\pi', 'ρ': '\\rho', 'ς': '\\varsigma',
      'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi', 'χ': '\\chi', 'ψ': '\\psi',
      'ω': '\\omega', 'ϑ': '\\thetasym', 'ϕ': '\\phi', 'ϖ': '\\varpi', 'ϝ': '\\digamma', 'ϰ': '\\varkappa',
      'ϱ': '\\varrho', 'ϵ': '\\epsilon', ' ': '\\medspace', ' ': '\\thinspace',
      '–': '\\text{\\textendash}', '—': '\\text{\\textemdash}', '‘': '\\text{\\textquoteleft}',
      '’': '\\text{\\textquoteright}', '“': '\\text{\\textquotedblleft}',
      '”': '\\text{\\textquotedblright}', '†': '\\dag', '‡': '\\ddag', '…': '\\dotsc', '′': '\\prime',
      '‵': '\\backprime', ' ': '\\negmedspace', 'ℏ': '\\hbar', 'ℑ': '\\Im', 'ℓ': '\\ell', '℘': '\\wp',
      'ℜ': '\\Re', '℧': '\\mho', 'Ⅎ': '\\Finv', 'ℵ': '\\aleph', 'ℶ': '\\beth', 'ℷ': '\\gimel',
      'ℸ': '\\daleth', '⅁': '\\Game', '←': '\\gets', '↑': '\\uparrow', '→': '\\to', '↓': '\\downarrow',
      '↔': '\\leftrightarrow', '↕': '\\updownarrow', '↖': '\\nwarrow', '↗': '\\nearrow', '↘': '\\searrow',
      '↙': '\\swarrow', '↚': '\\nleftarrow', '↛': '\\nrightarrow', '↞': '\\twoheadleftarrow',
      '↠': '\\twoheadrightarrow', '↢': '\\leftarrowtail', '↣': '\\rightarrowtail', '↦': '\\mapsto',
      '↩': '\\hookleftarrow', '↪': '\\hookrightarrow', '↫': '\\looparrowleft', '↬': '\\looparrowright',
      '↭': '\\leftrightsquigarrow', '↮': '\\nleftrightarrow', '↰': '\\Lsh', '↱': '\\Rsh',
      '↶': '\\curvearrowleft', '↷': '\\curvearrowright', '↺': '\\circlearrowleft',
      '↻': '\\circlearrowright', '↼': '\\leftharpoonup', '↽': '\\leftharpoondown', '↾': '\\restriction',
      '↿': '\\upharpoonleft', '⇀': '\\rightharpoonup', '⇁': '\\rightharpoondown',
      '⇂': '\\downharpoonright', '⇃': '\\downharpoonleft', '⇄': '\\rightleftarrows',
      '⇆': '\\leftrightarrows', '⇇': '\\leftleftarrows', '⇈': '\\upuparrows', '⇉': '\\rightrightarrows',
      '⇊': '\\downdownarrows', '⇋': '\\leftrightharpoons', '⇌': '\\rightleftharpoons', '⇍': '\\nLeftarrow',
      '⇎': '\\nLeftrightarrow', '⇏': '\\nRightarrow', '⇐': '\\Leftarrow', '⇑': '\\Uparrow',
      '⇒': '\\Rightarrow', '⇓': '\\Downarrow', '⇔': '\\Leftrightarrow', '⇕': '\\Updownarrow',
      '⇚': '\\Lleftarrow', '⇛': '\\Rrightarrow', '⇝': '\\leadsto', '⇠': '\\dashleftarrow',
      '⇢': '\\dashrightarrow', '∀': '\\forall', '∁': '\\complement', '∂': '\\partial', '∃': '\\exists',
      '∄': '\\nexists', '∅': '\\emptyset', '∇': '\\nabla', '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
      '∌': '\\notni', '∍': '\\backepsilon', '∏': '\\prod', '∐': '\\coprod', '∑': '\\sum', '−': '-',
      '∓': '\\mp', '∔': '\\dotplus', '∖': '\\setminus', '∗': '\\ast', '∗': '*', '∘': '\\circ',
      '∙': '\\bullet', '√': '\\surd', '∝': '\\propto', '∞': '\\infin', '∠': '\\angle',
      '∡': '\\measuredangle', '∢': '\\sphericalangle', '∣': '\\mid', '∤': '\\nmid', '∥': '\\Vert',
      '∦': '\\nparallel', '∧': '\\land', '∨': '\\lor', '∩': '\\cap', '∪': '\\cup', '∫': '\\int',
      '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '∯': '\\oiint', '∰': '\\oiiint', '∴': '\\therefore',
      '∵': '\\because', '∷': '\\dblcolon', '∹': '\\eqcolon', '∼': '\\sim', '∽': '\\backsim', '≀': '\\wr',
      '≁': '\\nsim', '≂': '\\eqsim', '≃': '\\simeq', '≅': '\\cong', '≆': '\\ncong', '≈': '\\approx',
      '≊': '\\approxeq', '≍': '\\asymp', '≎': '\\Bumpeq', '≏': '\\bumpeq', '≐': '\\doteq', '≑': '\\Doteq',
      '≒': '\\fallingdotseq', '≓': '\\risingdotseq', '≔': '\\coloneqq', '≕': '\\eqqcolon', '≖': '\\eqcirc',
      '≗': '\\circeq', '≜': '\\triangleq', '≠': '\\ne', '≡': '\\equiv', '≤': '\\le', '≥': '\\ge',
      '≦': '\\leqq', '≧': '\\geqq', '≨': '\\lneqq', '≩': '\\gneqq', '≪': '\\ll', '≫': '\\gg',
      '≬': '\\between', '≮': '\\nless', '≯': '\\ngtr', '≰': '\\nleq', '≱': '\\ngeq', '≲': '\\lesssim',
      '≳': '\\gtrsim', '≶': '\\lessgtr', '≷': '\\gtrless', '≺': '\\prec', '≻': '\\succ',
      '≼': '\\preccurlyeq', '≽': '\\succcurlyeq', '≾': '\\precsim', '≿': '\\succsim', '⊀': '\\nprec',
      '⊁': '\\nsucc', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
      '⊈': '\\nsubseteq', '⊉': '\\nsupseteq', '⊊': '\\subsetneq', '⊋': '\\supsetneq', '⊎': '\\uplus',
      '⊏': '\\sqsubset', '⊐': '\\sqsupset', '⊑': '\\sqsubseteq', '⊒': '\\sqsupseteq', '⊓': '\\sqcap',
      '⊔': '\\sqcup', '⊕': '\\oplus', '⊖': '\\ominus', '⊗': '\\otimes', '⊘': '\\oslash', '⊙': '\\odot',
      '⊚': '\\circledcirc', '⊛': '\\circledast', '⊝': '\\circleddash', '⊞': '\\boxplus', '⊟': '\\boxminus',
      '⊠': '\\boxtimes', '⊡': '\\boxdot', '⊢': '\\vdash', '⊣': '\\dashv', '⊤': '\\top', '⊥': '\\bot',
      '⊨': '\\vDash', '⊩': '\\Vdash', '⊪': '\\Vvdash', '⊬': '\\nvdash', '⊭': '\\nvDash', '⊮': '\\nVdash',
      '⊯': '\\nVDash', '⊲': '\\lhd', '⊳': '\\rhd', '⊴': '\\unlhd', '⊵': '\\unrhd', '⊶': '\\origof',
      '⊷': '\\imageof', '⊸': '\\multimap', '⊺': '\\intercal', '⊻': '\\veebar', '⊼': '\\barwedge',
      '⋀': '\\bigwedge', '⋁': '\\bigvee', '⋂': '\\bigcap', '⋃': '\\bigcup', '⋄': '\\diamond',
      '⋅': '\\cdot', '⋆': '\\star', '⋇': '\\divideontimes', '⋈': '\\Join', '⋉': '\\ltimes',
      '⋊': '\\rtimes', '⋋': '\\leftthreetimes', '⋌': '\\rightthreetimes', '⋍': '\\backsimeq',
      '⋎': '\\curlyvee', '⋏': '\\curlywedge', '⋐': '\\Subset', '⋑': '\\Supset', '⋒': '\\Cap', '⋓': '\\Cup',
      '⋔': '\\pitchfork', '⋖': '\\lessdot', '⋗': '\\gtrdot', '⋘': '\\lll', '⋙': '\\ggg',
      '⋚': '\\lesseqgtr', '⋛': '\\gtreqless', '⋞': '\\curlyeqprec', '⋟': '\\curlyeqsucc', '⋠': '\\npreceq',
      '⋡': '\\nsucceq', '⋦': '\\lnsim', '⋧': '\\gnsim', '⋨': '\\precnsim', '⋩': '\\succnsim',
      '⋪': '\\ntriangleleft', '⋫': '\\ntriangleright', '⋬': '\\ntrianglelefteq', '⋭': '\\ntrianglerighteq',
      '⋮': '\\varvdots', '⋯': '\\cdots', '⋱': '\\ddots', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor',
      '⌋': '\\rfloor', '⌜': '\\ulcorner', '⌝': '\\urcorner', '⌞': '\\llcorner', '⌟': '\\lrcorner',
      '⌢': '\\frown', '⌣': '\\smile', '⎰': '\\lmoustache', '⎱': '\\rmoustache', 'Ⓢ': '\\circledS',
      '╱': '\\diagup', '╲': '\\diagdown', '■': '\\blacksquare', '□': '\\Box', '▲': '\\blacktriangle',
      '△': '\\triangle', '▶': '\\blacktriangleright', '▹': '\\triangleright', '▼': '\\blacktriangledown',
      '▽': '\\triangledown', '◀': '\\blacktriangleleft', '◃': '\\triangleleft', '◊': '\\Diamond',
      '◯': '\\bigcirc', '★': '\\bigstar', '♠': '\\spadesuit', '♡': '\\heartsuit', '♢': '\\diamondsuit',
      '♣': '\\clubsuit', '♭': '\\flat', '♮': '\\natural', '♯': '\\sharp', '✓': '\\checkmark',
      '✠': '\\maltese', '⟦': '\\llbracket', '⟧': '\\rrbracket', '⟨': '\\langle', '⟩': '\\rangle',
      '⟮': '\\lgroup', '⟯': '\\rgroup', '⟵': '\\longleftarrow', '⟶': '\\longrightarrow',
      '⟷': '\\longleftrightarrow', '⟸': '\\Longleftarrow', '⟹': '\\Longrightarrow',
      '⟺': '\\Longleftrightarrow', '⟼': '\\longmapsto', '⦃': '\\lBrace', '⦄': '\\rBrace', '⦵': '\\minuso',
      '⧫': '\\blacklozenge', '⨀': '\\bigodot', '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨄': '\\biguplus',
      '⨆': '\\bigsqcup', '⨿': '\\amalg', '⩞': '\\doublebarwedge', '⩽': '\\leqslant', '⩾': '\\geqslant',
      '⪅': '\\lessapprox', '⪆': '\\gtrapprox', '⪇': '\\lneq', '⪈': '\\gneq', '⪉': '\\lnapprox',
      '⪊': '\\gnapprox', '⪋': '\\lesseqqgtr', '⪌': '\\gtreqqless', '⪕': '\\eqslantless',
      '⪖': '\\eqslantgtr', '⪯': '\\preceq', '⪰': '\\succeq', '⪵': '\\precneqq', '⪶': '\\succneqq',
      '⪷': '\\precapprox', '⪸': '\\succapprox', '⪹': '\\precnapprox', '⪺': '\\succnapprox',
      '⫅': '\\subseteqq', '⫆': '\\supseteqq', '⫋': '\\subsetneqq', '⫌': '\\supsetneqq',
      // GENERATED:END
    }))

    /**
     * MathML node signature (`tag|mathvariant|text`) → the macro that produces
     * exactly that node. Some macros carry their identity in the NODE, not in a
     * character: `\bmod` is `<mo>mod</mo>`, `\plim` is an operator holding an
     * upright `plim`, so reading their text would come back as italic letters.
     * GENERATED by `tools/gen-unicode-tex.mjs` together with the table above.
     */
    const TEX_OF_NODE = new Map(Object.entries({
      // SIGNATURES:START — do not edit by hand; run tools/gen-unicode-tex.mjs

      "mi||α|": '\\alpha', "mi||β|": '\\beta', "mi||γ|": '\\gamma', "mi||Γ|": '\\varGamma',
      "mi||δ|": '\\delta', "mi||Δ|": '\\varDelta', "mi||ε|": '\\varepsilon', "mi||ϵ|": '\\epsilon',
      "mi||ζ|": '\\zeta', "mi||η|": '\\eta', "mi||θ|": '\\theta', "mi||ϑ|": '\\vartheta',
      "mi||Θ|": '\\varTheta', "mi||ι|": '\\iota', "mi||κ|": '\\kappa', "mi||λ|": '\\lambda',
      "mi||Λ|": '\\varLambda', "mi||μ|": '\\mu', "mi||ν|": '\\nu', "mi||ξ|": '\\xi', "mi||Ξ|": '\\varXi',
      "mi||ο|": '\\omicron', "mi||π|": '\\pi', "mi||ϖ|": '\\varpi', "mi||Π|": '\\varPi', "mi||ρ|": '\\rho',
      "mi||ϱ|": '\\varrho', "mi||σ|": '\\sigma', "mi||Σ|": '\\varSigma', "mi||ς|": '\\varsigma',
      "mi||τ|": '\\tau', "mi||υ|": '\\upsilon', "mi||Υ|": '\\varUpsilon', "mi||φ|": '\\varphi',
      "mi||ϕ|": '\\phi', "mi||Φ|": '\\varPhi', "mi||χ|": '\\chi', "mi||ψ|": '\\psi', "mi||Ψ|": '\\varPsi',
      "mi||ω|": '\\omega', "mi||Ω|": '\\varOmega', "mi|double-struck|C|": '\\cnums',
      "mi|double-struck|k|": '\\Bbbk', "mi|double-struck|N|": '\\N', "mi|double-struck|R|": '\\R',
      "mi|double-struck|Z|": '\\Z', "mi|normal|‘|": '\\lq', "mi|normal|§|": '\\S', "mi|normal|¶|": '\\P',
      "mi|normal|\\|": '\\backslash', "mi|normal|†|": '\\dag', "mi|normal|‡|": '\\ddag',
      "mi|normal|‵|": '\\backprime', "mi|normal|°|": '\\degree', "mi|normal|©|": '\\textcopyright',
      "mi|normal|®|": '\\circledR', "mi|normal|℘|": '\\wp', "mi|normal|℧|": '\\mho',
      "mi|normal|⅁|": '\\Game', "mi|normal|∀|": '\\forall', "mi|normal|∁|": '\\complement',
      "mi|normal|∂|": '\\partial', "mi|normal|∃|": '\\exists', "mi|normal|∄|": '\\nexists',
      "mi|normal|∅|": '\\emptyset', "mi|normal|∇|": '\\nabla', "mi|normal|¬|": '\\neg',
      "mi|normal|̸|": '\\not', "mi|normal|√|": '\\surd', "mi|normal|∞|": '\\infty',
      "mi|normal|∠|": '\\angle', "mi|normal|∡|": '\\measuredangle', "mi|normal|∢|": '\\sphericalangle',
      "mi|normal|∣|": '\\vert', "mi|normal|∥|": '\\Vert', "mi|normal|⊤|": '\\top', "mi|normal|⊥|": '\\bot',
      "mi|normal|⋮|": '\\varvdots', "mi|normal|╱|": '\\diagup', "mi|normal|╲|": '\\diagdown',
      "mi|normal|■|": '\\blacksquare', "mi|normal|□|": '\\Box', "mi|normal|▲|": '\\blacktriangle',
      "mi|normal|△|": '\\triangle', "mi|normal|▼|": '\\blacktriangledown',
      "mi|normal|▽|": '\\triangledown', "mi|normal|◊|": '\\Diamond', "mi|normal|★|": '\\bigstar',
      "mi|normal|♠|": '\\spadesuit', "mi|normal|♡|": '\\heartsuit', "mi|normal|♢|": '\\diamondsuit',
      "mi|normal|♣|": '\\clubsuit', "mi|normal|✓|": '\\checkmark', "mi|normal|✠|": '\\maltese',
      "mi|normal|⧫|": '\\blacklozenge', "mi|normal|♭|": '\\flat', "mi|normal|♮|": '\\natural',
      "mi|normal|♯|": '\\sharp', "mi|normal|£|": '\\pounds', "mi|normal|¥|": '\\yen',
      "mi|normal|A|": '\\Alpha', "mi|normal|arg max|": '\\argmax', "mi|normal|arg min|": '\\argmin',
      "mi|normal|B|": '\\Beta', "mi|normal|ð|": '\\eth', "mi|normal|E|": '\\Epsilon',
      "mi|normal|Ⅎ|": '\\Finv', "mi|normal|H|": '\\Eta', "mi|normal|ℏ|": '\\hbar',
      "mi|normal|I|": '\\Iota', "mi|normal|ℑ|": '\\Im', "mi|normal|inj lim|": '\\injlim',
      "mi|normal|ı|": '\\imath', "mi|normal|ȷ|": '\\jmath', "mi|normal|K|": '\\Kappa',
      "mi|normal|ℓ|": '\\ell', "mi|normal|lim inf|": '\\liminf', "mi|normal|lim sup|": '\\limsup',
      "mi|normal|lim‾|mover": '\\varlimsup', "mi|normal|lim‾|munder": '\\varliminf',
      "mi|normal|lim←|munder": '\\varprojlim', "mi|normal|lim→|munder": '\\varinjlim',
      "mi|normal|M|": '\\Mu', "mi|normal|N|": '\\Nu', "mi|normal|O|": '\\Omicron', "mi|normal|P|": '\\Rho',
      "mi|normal|proj lim|": '\\projlim', "mi|normal|ℜ|": '\\Re', "mi|normal|Ⓢ|": '\\circledS',
      "mi|normal|T|": '\\Tau', "mi|normal|X|": '\\Chi', "mi|normal|Z|": '\\Zeta',
      "mi|normal|Γ|": '\\Gamma', "mi|normal|Δ|": '\\Delta', "mi|normal|ϝ|": '\\digamma',
      "mi|normal|Θ|": '\\Theta', "mi|normal|ϰ|": '\\varkappa', "mi|normal|Λ|": '\\Lambda',
      "mi|normal|Ξ|": '\\Xi', "mi|normal|Π|": '\\Pi', "mi|normal|Σ|": '\\Sigma',
      "mi|normal|Υ|": '\\Upsilon', "mi|normal|Φ|": '\\Phi', "mi|normal|Ψ|": '\\Psi',
      "mi|normal|Ω|": '\\Omega', "mi|normal|ℵ|": '\\aleph', "mi|normal|ℶ|": '\\beth',
      "mi|normal|ℷ|": '\\gimel', "mi|normal|ℸ|": '\\daleth', "mo||:|": '\\colon', "mo||:|mo": '\\ratio',
      "mo||:−|mi,mi": '\\coloneq', "mo||:∼|mi,mi": '\\colonsim', "mo||:≈|mi,mi": '\\colonapprox',
      "mo||…|": '\\ldots', "mo||.|": '\\ldotp', "mo||(|": '\\lparen', "mo||)|": '\\rparen',
      "mo||[|": '\\lbrack', "mo||]|": '\\rbrack', "mo||{|": '\\lbrace', "mo||}|": '\\rbrace',
      "mo||⌈|": '\\lceil', "mo||⌉|": '\\rceil', "mo||⌊|": '\\lfloor', "mo||⌋|": '\\rfloor',
      "mo||⟨|": '\\langle', "mo||⟩|": '\\rangle', "mo||⟮|": '\\lgroup', "mo||⟯|": '\\rgroup',
      "mo||&|": '\\And', "mo||†|": '\\dagger', "mo||‡|": '\\ddagger', "mo||←|": '\\gets',
      "mo||↚|": '\\nleftarrow', "mo||→|": '\\to', "mo||↛|": '\\nrightarrow', "mo||↑|": '\\uparrow',
      "mo||↓|": '\\downarrow', "mo||↔|": '\\leftrightarrow', "mo||↮|": '\\nleftrightarrow',
      "mo||↕|": '\\updownarrow', "mo||↖|": '\\nwarrow', "mo||↗|": '\\nearrow', "mo||↘|": '\\searrow',
      "mo||↙|": '\\swarrow', "mo||↞|": '\\twoheadleftarrow', "mo||↠|": '\\twoheadrightarrow',
      "mo||↢|": '\\leftarrowtail', "mo||↣|": '\\rightarrowtail', "mo||↦|": '\\mapsto',
      "mo||↩|": '\\hookleftarrow', "mo||↪|": '\\hookrightarrow', "mo||↫|": '\\looparrowleft',
      "mo||↬|": '\\looparrowright', "mo||↭|": '\\leftrightsquigarrow', "mo||↰|": '\\Lsh',
      "mo||↱|": '\\Rsh', "mo||↶|": '\\curvearrowleft', "mo||↷|": '\\curvearrowright',
      "mo||↺|": '\\circlearrowleft', "mo||↻|": '\\circlearrowright', "mo||↼|": '\\leftharpoonup',
      "mo||↽|": '\\leftharpoondown', "mo||↾|": '\\restriction', "mo||↿|": '\\upharpoonleft',
      "mo||⇀|": '\\rightharpoonup', "mo||⇁|": '\\rightharpoondown', "mo||⇂|": '\\downharpoonright',
      "mo||⇃|": '\\downharpoonleft', "mo||⇄|": '\\rightleftarrows', "mo||⇆|": '\\leftrightarrows',
      "mo||⇇|": '\\leftleftarrows', "mo||⇈|": '\\upuparrows', "mo||⇉|": '\\rightrightarrows',
      "mo||⇊|": '\\downdownarrows', "mo||⇋|": '\\leftrightharpoons', "mo||⇌|": '\\rightleftharpoons',
      "mo||⇐|": '\\Leftarrow', "mo||⇍|": '\\nLeftarrow', "mo||⇑|": '\\Uparrow', "mo||⇒|": '\\Rightarrow',
      "mo||⇏|": '\\nRightarrow', "mo||⇓|": '\\Downarrow', "mo||⇔|": '\\Leftrightarrow',
      "mo||⇎|": '\\nLeftrightarrow', "mo||⇕|": '\\Updownarrow', "mo||⇚|": '\\Lleftarrow',
      "mo||⇛|": '\\Rrightarrow', "mo||⇝|": '\\leadsto', "mo||⇠|": '\\dashleftarrow',
      "mo||⇢|": '\\dashrightarrow', "mo||∈|": '\\in', "mo||∋|": '\\ni', "mo||∍|": '\\backepsilon',
      "mo||∏|": '\\prod', "mo||∐|": '\\coprod', "mo||∑|": '\\sum', "mo||±|": '\\pm', "mo||÷|": '\\div',
      "mo||×|": '\\times', "mo||<|": '\\lt', "mo||≮|": '\\nless', "mo||=∷|mi,mi": '\\Eqqcolon',
      "mo||>|": '\\gt', "mo||≯|": '\\ngtr', "mo||−∷|mi,mi": '\\Eqcolon', "mo||∓|": '\\mp',
      "mo||∔|": '\\dotplus', "mo||∖|": '\\setminus', "mo||∗|": '\\ast', "mo||∘|": '\\circ',
      "mo||∙|": '\\bullet', "mo||∝|": '\\propto', "mo||∣|": '\\mid', "mo||∤|": '\\nmid',
      "mo||∥|": '\\lVert', "mo||∦|": '\\nparallel', "mo||∧|": '\\land', "mo||∨|": '\\lor',
      "mo||∩|": '\\cap', "mo||∪|": '\\cup', "mo||∫|": '\\int', "mo||∬|": '\\iint', "mo||∭|": '\\iiint',
      "mo||∮|": '\\oint', "mo||∯|": '\\oiint', "mo||∰|": '\\oiiint', "mo||∴|": '\\therefore',
      "mo||∵|": '\\because', "mo||∷=|mi,mi": '\\Coloneqq', "mo||∷|mi": '\\dblcolon',
      "mo||∷−|mi,mi": '\\Coloneq', "mo||∷∼|mi,mi": '\\Colonsim', "mo||∷≈|mi,mi": '\\Colonapprox',
      "mo||∹|mi": '\\eqcolon', "mo||∼:|mo,mo,mo": '\\simcolon', "mo||∼|": '\\sim', "mo||≁|": '\\nsim',
      "mo||∼∷|mo,mo,mo": '\\simcoloncolon', "mo||∽|": '\\backsim', "mo||≀|": '\\wr', "mo||≂|": '\\eqsim',
      "mo||≃|": '\\simeq', "mo||≅|": '\\cong', "mo||≆|": '\\ncong', "mo||≈:|mo,mo,mo": '\\approxcolon',
      "mo||≈|": '\\approx', "mo||≈∷|mo,mo,mo": '\\approxcoloncolon', "mo||≊|": '\\approxeq',
      "mo||≍|": '\\asymp', "mo||≎|": '\\Bumpeq', "mo||≏|": '\\bumpeq', "mo||≐|": '\\doteq',
      "mo||≑|": '\\Doteq', "mo||≒|": '\\fallingdotseq', "mo||≓|": '\\risingdotseq',
      "mo||≔|mi": '\\coloneqq', "mo||≕|mi": '\\eqqcolon', "mo||≖|": '\\eqcirc', "mo||≗|": '\\circeq',
      "mo||≜|": '\\triangleq', "mo||≡|": '\\equiv', "mo||≤|": '\\le', "mo||≰|": '\\nleq', "mo||≥|": '\\ge',
      "mo||≱|": '\\ngeq', "mo||≦|": '\\leqq', "mo||≧|": '\\geqq', "mo||≨|": '\\lneqq', "mo||≩|": '\\gneqq',
      "mo||≪|": '\\ll', "mo||≫|": '\\gg', "mo||≬|": '\\between', "mo||≲|": '\\lesssim',
      "mo||≳|": '\\gtrsim', "mo||≶|": '\\lessgtr', "mo||≷|": '\\gtrless', "mo||≺|": '\\prec',
      "mo||⊀|": '\\nprec', "mo||≻|": '\\succ', "mo||⊁|": '\\nsucc', "mo||≼|": '\\preccurlyeq',
      "mo||⋠|": '\\npreceq', "mo||≽|": '\\succcurlyeq', "mo||⋡|": '\\nsucceq', "mo||≾|": '\\precsim',
      "mo||≿|": '\\succsim', "mo||⊂|": '\\subset', "mo||⊃|": '\\supset', "mo||⊆|": '\\subseteq',
      "mo||⊈|": '\\nsubseteq', "mo||⊇|": '\\supseteq', "mo||⊉|": '\\nsupseteq', "mo||⊊|": '\\subsetneq',
      "mo||⊋|": '\\supsetneq', "mo||⊎|": '\\uplus', "mo||⊏|": '\\sqsubset', "mo||⊐|": '\\sqsupset',
      "mo||⊑|": '\\sqsubseteq', "mo||⊒|": '\\sqsupseteq', "mo||⊓|": '\\sqcap', "mo||⊔|": '\\sqcup',
      "mo||⊕|": '\\oplus', "mo||⊖|": '\\ominus', "mo||⊗|": '\\otimes', "mo||⊘|": '\\oslash',
      "mo||⊙|": '\\odot', "mo||⊚|": '\\circledcirc', "mo||⊛|": '\\circledast', "mo||⊝|": '\\circleddash',
      "mo||⊞|": '\\boxplus', "mo||⊟|": '\\boxminus', "mo||⊠|": '\\boxtimes', "mo||⊡|": '\\boxdot',
      "mo||⊢|": '\\vdash', "mo||⊬|": '\\nvdash', "mo||⊣|": '\\dashv', "mo||⊥|": '\\perp',
      "mo||⊨|": '\\vDash', "mo||⊭|": '\\nvDash', "mo||⊩|": '\\Vdash', "mo||⊮|": '\\nVdash',
      "mo||⊪|": '\\Vvdash', "mo||⊯|": '\\nVDash', "mo||⊲|": '\\lhd', "mo||⋪|": '\\ntriangleleft',
      "mo||⊳|": '\\rhd', "mo||⋫|": '\\ntriangleright', "mo||⊴|": '\\unlhd', "mo||⋬|": '\\ntrianglelefteq',
      "mo||⊵|": '\\unrhd', "mo||⋭|": '\\ntrianglerighteq', "mo||⊶|": '\\origof', "mo||⊷|": '\\imageof',
      "mo||⊸|": '\\multimap', "mo||⊺|": '\\intercal', "mo||⊻|": '\\veebar', "mo||⊼|": '\\barwedge',
      "mo||⋀|": '\\bigwedge', "mo||⋁|": '\\bigvee', "mo||⋂|": '\\bigcap', "mo||⋃|": '\\bigcup',
      "mo||⋄|": '\\diamond', "mo||⋅|": '\\cdot', "mo||⋆|": '\\star', "mo||⋇|": '\\divideontimes',
      "mo||⋈|": '\\Join', "mo||⋉|": '\\ltimes', "mo||⋊|": '\\rtimes', "mo||⋋|": '\\leftthreetimes',
      "mo||⋌|": '\\rightthreetimes', "mo||⋍|": '\\backsimeq', "mo||⋎|": '\\curlyvee',
      "mo||⋏|": '\\curlywedge', "mo||⋐|": '\\Subset', "mo||⋑|": '\\Supset', "mo||⋒|": '\\Cap',
      "mo||⋓|": '\\Cup', "mo||⋔|": '\\pitchfork', "mo||⋖|": '\\lessdot', "mo||⋗|": '\\gtrdot',
      "mo||⋘|": '\\lll', "mo||⋙|": '\\ggg', "mo||⋚|": '\\lesseqgtr', "mo||⋛|": '\\gtreqless',
      "mo||⋞|": '\\curlyeqprec', "mo||⋟|": '\\curlyeqsucc', "mo||⋦|": '\\lnsim', "mo||⋧|": '\\gnsim',
      "mo||⋨|": '\\precnsim', "mo||⋩|": '\\succnsim', "mo||⋯|": '\\cdots', "mo||⋱|": '\\ddots',
      "mo||⌜|mi": '\\ulcorner', "mo||⌝|mi": '\\urcorner', "mo||⌞|mi": '\\llcorner',
      "mo||⌟|mi": '\\lrcorner', "mo||⌢|": '\\frown', "mo||⌣|": '\\smile', "mo||⎰|": '\\lmoustache',
      "mo||⎱|": '\\rmoustache', "mo||△|": '\\vartriangle', "mo||▶|": '\\blacktriangleright',
      "mo||▹|": '\\triangleright', "mo||▽|": '\\bigtriangledown', "mo||◀|": '\\blacktriangleleft',
      "mo||◃|": '\\triangleleft', "mo||◯|": '\\bigcirc', "mo||⟵|": '\\longleftarrow',
      "mo||⟶|": '\\longrightarrow', "mo||⟷|": '\\longleftrightarrow', "mo||⟸|": '\\Longleftarrow',
      "mo||⟹|": '\\Longrightarrow', "mo||⟺|": '\\Longleftrightarrow', "mo||⟼|": '\\longmapsto',
      "mo||⦵|mi": '\\minuso', "mo||⨀|": '\\bigodot', "mo||⨁|": '\\bigoplus', "mo||⨂|": '\\bigotimes',
      "mo||⨄|": '\\biguplus', "mo||⨆|": '\\bigsqcup', "mo||⨿|": '\\amalg', "mo||⩞|": '\\doublebarwedge',
      "mo||⩽|": '\\leqslant', "mo||⩾|": '\\geqslant', "mo||⪅|": '\\lessapprox', "mo||⪆|": '\\gtrapprox',
      "mo||⪇|": '\\lneq', "mo||⪈|": '\\gneq', "mo||⪉|": '\\lnapprox', "mo||⪊|": '\\gnapprox',
      "mo||⪋|": '\\lesseqqgtr', "mo||⪌|": '\\gtreqqless', "mo||⪕|": '\\eqslantless',
      "mo||⪖|": '\\eqslantgtr', "mo||⪯|": '\\preceq', "mo||⪰|": '\\succeq', "mo||⪵|": '\\precneqq',
      "mo||⪶|": '\\succneqq', "mo||⪷|": '\\precapprox', "mo||⪸|": '\\succapprox',
      "mo||⪹|": '\\precnapprox', "mo||⪺|": '\\succnapprox', "mo||⫅|": '\\subseteqq',
      "mo||⫆|": '\\supseteqq', "mo||⫋|": '\\subsetneqq', "mo||⫌|": '\\supsetneqq',
      "mo||mod|mrow": '\\bmod', "mo||plim⁡|mi,mo": '\\plim', "mo|normal|⦃|": '\\lBrace',
      "mo|normal|⦄|": '\\rBrace', "mo|normal|⟦|": '\\llbracket', "mo|normal|⟧|": '\\rrbracket',
      "mo|normal|′|": '\\prime', "mo|normal|∉|": '\\notin', "mo|normal|∌|": '\\notni',
      "mo|normal|≠|": '\\ne',
      // SIGNATURES:END
    }))

    /** Accent character → the macro that draws it. */
    const ACCENT_OF_CHAR = new Map(Object.entries({
      '^': 'hat', 'ˆ': 'hat', '~': 'tilde', '˜': 'tilde', '¯': 'bar', 'ˉ': 'bar',
      '‾': 'overline', '˙': 'dot', '¨': 'ddot', '⃗': 'vec', '→': 'overrightarrow',
      '⏟': 'underbrace', '⏞': 'overbrace', '̂': 'hat', '̃': 'tilde', '̄': 'bar',
      '̇': 'dot', '̈': 'ddot', '̲': 'underline',
    }))

    /** Operators that take limits (`\sum_a^b`) instead of scripts. */
    const LIMIT_OPERATORS = new Set([
      '∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⨁', '⨂', '⨀', '⨄', '⨆',
    ])
    const FUNCTION_NAMES = new Set([
      'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'hom',
      'arg', 'deg', 'gcd', 'Pr', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin',
      'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp',
    ])

    /** The visual text of the formula being planned, and where limits sit in it. */
    let formulaStream = ''
    let limitsSpans = []
    /** Nodes that were laid out with limits, collected while planning. */
    let limitsNodes = new Set()

    function mmlTagOf(node) {
      return node !== null && node !== undefined && node.nodeType === 1 ? tagOf(node) : ''
    }

    function mmlChildren(node) {
      const out = []
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && mmlTagOf(child) !== 'annotation') out.push(child)
      }
      return out
    }

    function mmlParent(node) {
      const parent = node.parentNode
      return parent !== null && parent !== undefined && parent.nodeType === 1 ? parent : null
    }

    /** Text that takes part in the alignment: everything invisible is removed. */
    function alignableText(value) {
      return String(value).replace(INVISIBLE_CHARS, '')
    }

    /** Visible text of one MathML leaf ('' when it renders nothing). */
    function leafTextOf(node) {
      const text = alignableText(node.textContent ?? '')
      return text.trim() === '' ? '' : text
    }

    /**
     * Whether a node is a big operator, or a function name that takes limits.
     * The base of `\lim` arrives wrapped in an `mrow` with an invisible operator
     * next to it, so the text is what decides.
     */
    function isBigOperator(node) {
      if (node === undefined || node === null) return false
      const text = alignableText(node.textContent ?? '').trim()
      return LIMIT_OPERATORS.has(text) || FUNCTION_NAMES.has(text)
    }

    /** The accent a node draws (`^` → hat, `⃗` → vec, `⏟` → underbrace …). */
    function accentNameOf(node) {
      if (node === null || node === undefined) return null
      const name = ACCENT_OF_CHAR.get((node.textContent ?? '').trim())
      return name === undefined ? null : name
    }

    /** How many characters a subtree occupies in the visual arm. */
    function visualLengthOf(node, drop) {
      const tag = mmlTagOf(node)
      if (tag === '') return null
      if (MATHML_LEAF_TAGS.has(tag)) {
        const text = leafTextOf(node)
        if (text === '') return 0
        return drop && DECORATION_ONLY.test(text) ? 0 : text.length
      }
      if (tag === 'mspace' || tag === 'none') return 0
      const kids = mmlChildren(node)
      if (tag === 'math' || tag === 'semantics') {
        return kids.length === 1 ? visualLengthOf(kids[0], drop) : null
      }
      let total = 0
      for (const kid of kids) {
        const part = visualLengthOf(kid, drop)
        if (part === null) return null
        total += part
      }
      return total
    }

    /** Whether a span of the visual text belongs to a limits layout. */
    function inLimitsSpan(start, end) {
      for (const span of limitsSpans) {
        if (start >= span[0] && end <= span[1]) return true
      }
      return false
    }

    /**
     * A node's children in the order the VISUAL arm prints them, or null.
     *
     * Reading order is not layout order: a fraction puts its denominator first,
     * a root its index, a matrix its columns, and under/over constructs put
     * their limits around the operator — but only when the layout says so,
     * which is why the span is checked against the `.op-limits` elements.
     */
    function orderedChildren(node, start, end) {
      const tag = mmlTagOf(node)
      const kids = mmlChildren(node)
      switch (tag) {
        case 'math': case 'semantics':
          return kids.length === 1 ? kids : null
        case 'mrow': case 'mstyle': case 'mpadded': case 'mphantom': case 'merror':
        case 'menclose': case 'mtd': case 'mtr': case 'mlabeledtr':
          return kids
        case 'msub': case 'msup': case 'msubsup': {
          if (kids.length < 2) return null
          const [base, ...scripts] = kids
          if (isBigOperator(base) && inLimitsSpan(start, end)) {
            limitsNodes.add(node)
            return [scripts[0], base, scripts[scripts.length - 1]].filter((child) => child !== undefined)
          }
          return [base, ...scripts]
        }
        case 'munder': case 'mover': case 'munderover': {
          if (kids.length < 2 || kids.length > 3) return null
          const base = kids[0]
          const under = tag === 'mover' ? undefined : kids[1]
          const over = tag === 'mover' ? kids[1] : kids[2]
          if (isBigOperator(base) && inLimitsSpan(start, end)) {
            limitsNodes.add(node)
            return [under, base, over].filter((child) => child !== undefined)
          }
          return tag === 'mover' ? [base, over] : [under, base]
        }
        case 'mfrac':
          return kids.length === 2 ? [kids[1], kids[0]] : null
        case 'msqrt':
          return kids.length === 1 ? [kids[0]] : null
        case 'mroot':
          return kids.length === 2 ? [kids[1], kids[0]] : null
        case 'mtable': {
          const rows = kids.map((row) => mmlChildren(row))
          const width = rows.reduce((max, cells) => Math.max(max, cells.length), 0)
          const ordered = []
          for (let column = 0; column < width; column += 1) {
            for (const cells of rows) {
              if (cells[column] !== undefined) ordered.push(cells[column])
            }
          }
          return ordered
        }
        default:
          return null
      }
    }

    /**
     * Lay one MathML node over the visual text starting at `start`.
     *
     * Every leaf must find exactly its own characters at the position the layout
     * order predicts; anything else is a construct this extractor got wrong, and
     * `null` sends the caller back to the whole formula.
     * @returns `{ leaves, end }` or null.
     */
    function planLeavesIn(node, start, drop) {
      const tag = mmlTagOf(node)
      if (tag === 'mspace' || tag === 'none') return { leaves: [], end: start }
      if (MATHML_LEAF_TAGS.has(tag)) {
        const text = leafTextOf(node)
        if (text === '' || (drop && DECORATION_ONLY.test(text))) return { leaves: [], end: start }
        const end = start + text.length
        if (formulaStream.slice(start, end) !== text) return null
        return { leaves: [{ node, text }], end }
      }
      const length = visualLengthOf(node, drop)
      if (length === null) return null
      const end = start + length
      if (end > formulaStream.length) return null
      const kids = orderedChildren(node, start, end)
      if (kids === null) return null
      const leaves = []
      let cursor = start
      for (const kid of kids) {
        const part = planLeavesIn(kid, cursor, drop)
        if (part === null) return null
        for (const leaf of part.leaves) leaves.push(leaf)
        cursor = part.end
      }
      if (cursor !== end) return null
      return { leaves, end }
    }

    /** The single top row a formula's MathML arm starts from. */
    function topMathNode(mathml) {
      if (mathml === null || typeof mathml.querySelector !== 'function') return null
      const math = mathml.querySelector('math') ?? mathml
      const children = mmlChildren(math)
      const semantics = children.find((child) => mmlTagOf(child) === 'semantics')
      if (semantics === undefined) return children.length === 0 ? null : children[0]
      const inner = mmlChildren(semantics)
      return inner.length === 0 ? null : inner[0]
    }

    /**
     * The plan of one whole formula: its leaves in visual order, plus the runs
     * they were read from. Null when the layout and the structure disagree.
     *
     * Two passes: one where decorations count as glyphs (they usually are: `\bar`
     * draws a bar as text) and one where they do not (an `\overline` is drawn as
     * a rule, so it occupies no character).
     */
    function formulaPlanOf(root) {
      const html = root.querySelector('.katex-html')
      const mathml = root.querySelector('.katex-mathml')
      if (html === null || mathml === null) return null
      const top = topMathNode(mathml)
      if (top === null) return null
      const runs = visualRunsOf(html)
      formulaStream = runs.map((run) => run.text).join('')
      if (formulaStream === '') return null
      for (const drop of [false, true]) {
        limitsNodes = new Set()
        const planned = planLeavesIn(top, 0, drop)
        if (planned === null) continue
        if (planned.end !== formulaStream.length || planned.leaves.length === 0) continue
        return { leaves: planned.leaves, runs }
      }
      return null
    }

    /**
     * Text that is in the DOM but not on screen: `\phantom` and friends are
     * rendered with a transparent colour, `\mathstrut` is a hidden `(`.
     */
    function isVisuallyHidden(el) {
      let node = el
      while (node !== null && node !== undefined && node.nodeType === 1) {
        const style = typeof node.getAttribute === 'function' ? (node.getAttribute('style') ?? '') : ''
        if (/visibility\s*:\s*hidden|display\s*:\s*none|color\s*:\s*transparent|opacity\s*:\s*0(?![.\d])/iu.test(style)) {
          return true
        }
        node = node.parentElement
      }
      return false
    }

    /** One text node of the visual arm, with its place in the alignment. */
    function visualRunsOf(scope) {
      const runs = []
      limitsSpans = []
      let cursor = 0
      const walk = (el) => {
        const isLimits = typeof el.getAttribute === 'function'
          && (el.getAttribute('class') ?? '').split(/\s+/u).includes('op-limits')
        const opened = isLimits ? cursor : -1
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            const raw = child.nodeValue ?? ''
            const text = alignableText(raw)
            if (text.trim() === '') continue
            runs.push({
              node: child,
              text,
              start: cursor,
              // Only needed when the text node carries invisible characters.
              map: text === raw ? null : rawSurvival(raw),
            })
            cursor += text.length
            continue
          }
          if (child.nodeType !== 1) continue
          const tag = tagOf(child)
          if (tag === 'svg' || tag === 'annotation' || tag === 'script' || tag === 'style') continue
          if (isVisuallyHidden(child)) continue
          walk(child)
        }
        if (isLimits) limitsSpans.push([opened, cursor])
      }
      walk(scope)
      return runs
    }

    /** Per-character flags saying whether a raw text node survives alignment. */
    function rawSurvival(raw) {
      const map = []
      for (const char of raw) map.push(char.replace(INVISIBLE_CHARS, '') === '' ? 0 : 1)
      return map
    }

    /** A raw offset inside one run → its offset in the aligned text. */
    function alignedOffset(run, rawOffset) {
      if (run.map === null) return Math.max(0, Math.min(rawOffset, run.text.length))
      let count = 0
      for (let index = 0; index < rawOffset && index < run.map.length; index += 1) {
        if (run.map[index] === 1) count += 1
      }
      return count
    }

    /** Whether a range covers a node completely. */
    function rangeCoversNode(range, node) {
      const probe = range.cloneRange()
      try {
        probe.selectNode(node)
      } catch {
        return false
      }
      return range.compareBoundaryPoints(range.START_TO_START, probe) <= 0
        && range.compareBoundaryPoints(range.END_TO_END, probe) >= 0
    }

    /** The slice of the plan a range covers, as `[first, last]` leaf indices. */
    function coveredLeaves(range, runs, leaves) {
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      for (const run of runs) {
        if (!range.intersectsNode(run.node)) continue
        let start = run.start
        let end = run.start + run.text.length
        if (run.node === range.startContainer) start += alignedOffset(run, range.startOffset)
        if (run.node === range.endContainer) end = run.start + alignedOffset(run, range.endOffset)
        if (start < from) from = start
        if (end > to) to = end
      }
      if (!Number.isFinite(from) || to <= from) return null
      let cursor = 0
      let first = -1
      let last = -1
      for (let index = 0; index < leaves.length; index += 1) {
        const leafStart = cursor
        const leafEnd = cursor + leaves[index].text.length
        if (leafEnd > from && leafStart < to) {
          if (first === -1) first = index
          last = index
        }
        cursor = leafEnd
      }
      return first === -1 ? null : [first, last]
    }

    /**
     * The smallest complete sub-expressions covering the selected leaves.
     *
     * A leaf grows into the highest ancestor whose leaves are all selected, so
     * picking `m`, `c` and `2` out of `E = mc^2` yields `m` and `c^{2}` rather
     * than the whole row.
     */
    function coveringNodes(leaves, first, last, top) {
      // Leaves under one ancestor are NOT always a contiguous slice of the plan
      // (a matrix is laid out column by column, so a row's cells are far apart),
      // so membership is tracked per node instead of a min/max span.
      const members = new Map()
      for (let index = 0; index < leaves.length; index += 1) {
        let node = leaves[index].node
        while (node !== null && node !== undefined) {
          const list = members.get(node)
          if (list === undefined) members.set(node, [index])
          else list.push(index)
          const parent = mmlParent(node)
          if (parent === null || parent === top) break
          node = parent
        }
      }
      const inside = (list) => list.every((index) => index >= first && index <= last)
      const done = new Set()
      const nodes = []
      let index = first
      while (index <= last) {
        if (done.has(index)) {
          index += 1
          continue
        }
        let node = leaves[index].node
        for (;;) {
          const parent = mmlParent(node)
          if (parent === null || parent === top) break
          const list = members.get(parent)
          if (list === undefined || !inside(list)) break
          node = parent
        }
        nodes.push(node)
        for (const member of members.get(node) ?? [index]) done.add(member)
        index += 1
      }
      return nodes
    }

    /** Whether a node sits inside a matrix table rather than being one of its parts. */
    function insideMatrix(node, top) {
      if (mmlTagOf(node) === 'mtd' || mmlTagOf(node) === 'mtr') return true
      let cursor = mmlParent(node)
      while (cursor !== null && cursor !== top) {
        if (mmlTagOf(cursor) === 'mtable') return true
        cursor = mmlParent(cursor)
      }
      return false
    }

    function escapeTexText(text) {
      return String(text).replace(/[\\{}$&#%_^~]/gu, (char) => `\\${char}`)
    }

    /** MathML characters → the TeX the shell rendered them from. */
    function texOfChars(text) {
      let out = ''
      for (const char of alignableText(text)) out += TEX_OF_CHAR.get(char) ?? char
      return out
    }

    /**
     * One whole MathML leaf → TeX. A leaf that is nothing but an accent glyph
     * (the hat a user selected on its own) has no bare TeX form: `^` alone is a
     * superscript marker and `~` a non-breaking space, so it is written as the
     * accent macro over an empty group, which draws the same mark.
     */
    function texOfLeafChars(text) {
      const named = TEX_OF_CHAR.get(text)
      if (named !== undefined) return named
      const accent = ACCENT_OF_CHAR.get(text)
      if (accent !== undefined) return `\\${accent}{}`
      return texOfChars(text)
    }

    /**
     * `mathvariant` → the macro that produced it (checked against KaTeX 0.16.47:
     * `\mathbf` → `bold`, `\boldsymbol` → `bold-italic`, …). The variant lives in
     * an ATTRIBUTE, not in the text, so ignoring it is what made a partial copy of
     * `\mathbb{R}` come back as a bare `R`.
     */
    const FONT_OF_VARIANT = new Map(Object.entries({
      'normal': 'mathrm',
      'bold': 'mathbf',
      'italic': 'mathit',
      'bold-italic': 'boldsymbol',
      'double-struck': 'mathbb',
      'fraktur': 'mathfrak',
      'script': 'mathcal',
      'sans-serif': 'mathsf',
      'sans-serif-italic': 'mathsfit',
      'monospace': 'mathtt',
    }))

    function variantOf(node) {
      if (typeof node.getAttribute !== 'function') return ''
      return node.getAttribute('mathvariant') ?? ''
    }

    /** Wrap a reconstructed piece in the font macro its variant came from. */
    function withVariant(tex, variant) {
      const macro = FONT_OF_VARIANT.get(variant)
      return macro === undefined || tex === '' ? tex : `\\${macro}{${tex}}`
    }

    /** A matrix body: cells joined by `&`, rows by `\\`. */
    function matrixBody(table, variant) {
      const rows = mmlChildren(table).map((row) => mmlChildren(row))
      return rows
        .map((cells) => cells.map((cell) => mmlToTex(cell, variant) ?? '').join(' & '))
        .join(' \\\\ ')
    }

    /**
     * One matrix recognised as an environment: `(…)` pairs and the brace that
     * opens `cases`. Returns the TeX and the index of the last node it consumed.
     */
    function matrixEnvironmentAt(kids, index, variant) {
      const open = kids[index]
      const table = kids[index + 1]
      if (open === undefined || table === undefined) return null
      if (mmlTagOf(open) !== 'mo' || mmlTagOf(table) !== 'mtable') return null
      const openText = (open.textContent ?? '').trim()
      const close = kids[index + 2]
      const closeText = close === undefined ? '' : (close.textContent ?? '').trim()
      const environments = [
        ['(', ')', 'pmatrix'], ['[', ']', 'bmatrix'], ['{', '}', 'Bmatrix'],
        ['|', '|', 'vmatrix'], ['‖', '‖', 'Vmatrix'], ['{', '', 'cases'],
      ]
      for (const [left, right, name] of environments) {
        if (openText !== left) continue
        if (right !== '' && closeText !== right) continue
        const end = right === '' ? index + 1 : index + 2
        return { tex: `\\begin{${name}}${matrixBody(table, variant)}\\end{${name}}`, end }
      }
      return null
    }

    /**
     * One MathML node → TeX, or null for a construct the writer does not know.
     * This reconstructs rather than recovers: it emits what renders the same
     * math, not necessarily what the author typed. `variant` carries the font
     * inherited from an enclosing `mstyle`.
     */
    function mmlToTex(node, variant = '') {
      const tag = mmlTagOf(node)
      if (tag === 'mi' || tag === 'mo' || tag === 'mn') {
        const own = variantOf(node)
        // Operators carry their identity in the node (`\neq`, `\bmod`, `.` the
        // operator rather than `.` the letter), so the signature table decides.
        // For letters a font IS expressible as a macro, and `\mathbb{R}` beats
        // KaTeX's shortcut `\R`: the variant rule below is asked instead.
        // `normal` is special: macros like `\mid` or `\lq` ARE an upright
        // letter, so the node signature knows them better than a redundant
        // `\mathrm{…}` wrapper would.
        const fontExpressible = tag !== 'mo' && own !== 'normal'
          && FONT_OF_VARIANT.get(own) !== undefined
        if (!fontExpressible) {
          const kids = [...node.children].map((child) => tagOf(child)).join(',')
          const named = TEX_OF_NODE.get(`${tag}|${own}|${(node.textContent ?? '').trim()}|${kids}`)
          if (named !== undefined && (variant === '' || variant === own)) return named
        }
      }
      switch (tag) {
        case 'math': case 'semantics': {
          const kids = mmlChildren(node)
          return kids.length === 1 ? mmlToTex(kids[0], variant) : null
        }
        case 'mstyle': {
          // The variant applies to everything inside it.
          const next = variantOf(node) || variant
          const parts = []
          for (const kid of mmlChildren(node)) {
            const part = mmlToTex(kid, next)
            if (part === null) return null
            parts.push(part)
          }
          return joinTexParts(parts)
        }
        case 'mrow': case 'mpadded': case 'mphantom': case 'merror':
        case 'menclose': case 'mtd': case 'mtr': case 'mlabeledtr': {
          const kids = mmlChildren(node)
          const parts = []
          for (let index = 0; index < kids.length; index += 1) {
            const environment = matrixEnvironmentAt(kids, index, variant)
            if (environment !== null) {
              parts.push(environment.tex)
              index = environment.end
              continue
            }
            const part = mmlToTex(kids[index], variant)
            if (part === null) return null
            parts.push(part)
          }
          return joinTexParts(parts)
        }
        case 'mi': {
          const text = (node.textContent ?? '').trim()
          if (text === '') return ''
          const own = variantOf(node) || variant
          if (FUNCTION_NAMES.has(text)) return withVariant(`\\${text}`, own)
          if (text.length > 1) {
            const named = `\\mathrm{${escapeTexText(text)}}`
            return own === 'normal' ? named : withVariant(named, own)
          }
          return withVariant(texOfChars(text), own)
        }
        case 'mo': case 'mn':
          return withVariant(texOfLeafChars((node.textContent ?? '').trim()), variantOf(node) || variant)
        case 'mtext': case 'ms':
          return withVariant(
            `\\text{${escapeTexText((node.textContent ?? '').trim())}}`,
            variantOf(node) || variant,
          )
        case 'msub': case 'msup': case 'msubsup': {
          const [base, ...scripts] = mmlChildren(node)
          const baseTex = mmlToTex(base, variant)
          if (baseTex === null || scripts.length === 0) return null
          const limits = limitsNodes.has(node) ? '\\limits' : ''
          if (scripts.length === 1) {
            const script = mmlToTex(scripts[0], variant)
            if (script === null) return null
            return tag === 'msub'
              ? `${baseTex}${limits}_{${script}}`
              : `${baseTex}${limits}^{${script}}`
          }
          const sub = mmlToTex(scripts[0], variant)
          const sup = mmlToTex(scripts[1], variant)
          if (sub === null || sup === null) return null
          return `${baseTex}${limits}_{${sub}}^{${sup}}`
        }
        case 'munder': case 'mover': case 'munderover': {
          const kids = mmlChildren(node)
          const baseTex = mmlToTex(kids[0], variant)
          if (baseTex === null) return null
          if (!limitsNodes.has(node)) {
            const mark = kids[1]
            const markTex = mark === undefined ? null : mmlToTex(mark, variant)
            if (markTex === null || markTex === '') return baseTex
            const accent = accentNameOf(mark)
            if (accent !== null) return `\\${accent}{${baseTex}}`
            return tag === 'mover'
              ? `\\overset{${markTex}}{${baseTex}}`
              : `\\underset{${markTex}}{${baseTex}}`
          }
          const under = tag === 'mover' || kids[1] === undefined ? null : mmlToTex(kids[1], variant)
          const over = tag === 'mover'
            ? (kids[1] === undefined ? null : mmlToTex(kids[1], variant))
            : (kids[2] === undefined ? null : mmlToTex(kids[2], variant))
          if (under === null && over === null) return null
          let out = `${baseTex}\\limits`
          if (under !== null) out += `_{${under}}`
          if (over !== null) out += `^{${over}}`
          return out
        }
        case 'mfrac': {
          const [numerator, denominator] = mmlChildren(node)
          const above = mmlToTex(numerator, variant)
          const below = mmlToTex(denominator, variant)
          if (above === null || below === null) return null
          return `\\frac{${above}}{${below}}`
        }
        case 'msqrt': {
          const [body] = mmlChildren(node)
          const inside = body === undefined ? null : mmlToTex(body, variant)
          return inside === null ? null : `\\sqrt{${inside}}`
        }
        case 'mroot': {
          const [body, index] = mmlChildren(node)
          const inside = body === undefined ? null : mmlToTex(body, variant)
          const radical = index === undefined ? null : mmlToTex(index, variant)
          if (inside === null || radical === null) return null
          return `\\sqrt[${radical}]{${inside}}`
        }
        case 'mtable':
          return `\\begin{matrix}${matrixBody(node, variant)}\\end{matrix}`
        case 'mspace': case 'none':
          return ''
        default:
          return null
      }
    }

    /**
     * Join the fragments of one selection.
     *
     * Two things can go wrong when fragments meet: a fragment can end with a
     * control word (`\sum`) while the next starts with a letter, and TeX would
     * read both as one unknown command (`\sumi`); and a fragment can start with
     * `^` or `_`, which would attach itself to whatever came before. An empty
     * group separates the first, and gives the second something to attach to —
     * that is how the shell renders a lone accent too.
     */
    function joinTexParts(parts) {
      let out = ''
      for (const part of parts) {
        if (out !== '' && /\\[A-Za-z]+$/u.test(out) && /^[A-Za-z]/u.test(part)) out += ' '
        out += /^[_^]/u.test(part) ? `{}${part}` : part
      }
      return out
    }

    /**
     * The Markdown source of the part of ONE formula the range covers, or null.
     *
     * Null means "not this path": the selection may not be inside a single
     * formula, may already cover all of it (where the exact source from the
     * annotation beats a reconstruction), or may hit a construct the extractor
     * does not understand. The caller then falls back to the whole formula.
     */
    function partialFormulaMarkdown(range) {
      const root = katexRootAround(range.startContainer)
      if (root === null || root !== katexRootAround(range.endContainer)) return null
      if (rangeCoversNode(range, root)) return null
      const plan = formulaPlanOf(root)
      if (plan === null) return null
      const covered = coveredLeaves(range, plan.runs, plan.leaves)
      if (covered === null) return null
      // Everything is selected: the annotation holds the author's own source.
      if (covered[0] === 0 && covered[1] === plan.leaves.length - 1) return null
      const mathml = root.querySelector('.katex-mathml')
      const top = topMathNode(mathml)
      const nodes = coveringNodes(plan.leaves, covered[0], covered[1], top)
      for (const node of nodes) {
        if (!insideMatrix(node, top)) continue
        // A slice of a matrix is not an expression of its own — several cells
        // would come out as their product — so only one whole cell is emitted,
        // and anything else falls back to the whole formula.
        if (nodes.length > 1 || mmlTagOf(node) !== 'mtd') return null
      }
      const parts = []
      for (const node of nodes) {
        // A node that draws nothing (a strut, a phantom) is not a fragment.
        if (alignableText(node.textContent ?? '').trim() === '') return null
        const tex = mmlToTex(node)
        if (tex === null) return null
        parts.push(tex)
      }
      const tex = joinTexParts(parts)
      if (tex === '') return null
      return mathMarkdownOf({ tex, display: isDisplayMath(root) }).trim()
    }

    /**
     * Inline elements whose *markers* live outside the DOM: selecting the entire
     * bold run must yield `**…**`, not the bare text, or the Markdown source is
     * silently downgraded. A selection that covers exactly such an element's
     * text is snapped outward onto the element itself.
     */
    const FORMATTING_TAGS = new Set(['strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'a', 'mark', 'u', 'sub', 'sup'])

    function normalizeText(value) {
      return String(value).replace(/\s+/gu, ' ').trim()
    }

    /**
     * A range copy widened onto any formatting element the selection covers
     * exactly, or onto a whole KaTeX formula when an endpoint landed inside one.
     * KaTeX renders each formula twice and clips the arm that carries the TeX
     * source to 1px, so a drag across a formula selects the VISUAL arm; widening
     * to the formula root is what keeps the `$…$` from silently degrading to the
     * rendered glyphs — or to nothing at all.
     */
    function snappedRange(range) {
      let clone = range.cloneRange()
      const text = normalizeText(rangeText(range))
      if (text === '') return clone
      const katex = katexRootOf(range, text)
      if (katex !== null) {
        clone = range.cloneRange()
        clone.selectNode(katex)
        return clone
      }
      // A selection that merely grazes a formula still comes back as its source;
      // that is settled before the formatting snap.
      const widened = widenedOverFormulas(range)
      if (widened !== null) return widened
      let cursor = elementOf(range.commonAncestorContainer)
      let outermost = null
      while (cursor !== null && cursor !== undefined) {
        if (!FORMATTING_TAGS.has(tagOf(cursor))) break
        if (normalizeText(cursor.textContent ?? '') !== text) break
        outermost = cursor
        cursor = cursor.parentElement
      }
      // `selectNode` (not `selectNodeContents`): cloning a contents-only range
      // leaves the wrapper out, which is exactly how the markers get lost.
      if (outermost !== null) clone.selectNode(outermost)
      return clone
    }

    /** The outermost KaTeX root a live node sits in, or null. */
    function katexRootAround(node) {
      const el = elementOf(node)
      if (el === null || typeof el.closest !== 'function') return null
      const root = el.closest('.katex, .katex-display, .katex-error')
      if (root === null) return null
      return root.closest('.katex-display') ?? root
    }

    /**
     * The range widened outwards onto every formula an endpoint sits in, or null.
     *
     * The TeX source exists ONLY on the formula root (`annotation` in the MathML
     * arm), while the pointer drags over the rendered arm — a different subtree of
     * that same root. So a selection that grazes the glyphs, or stops halfway
     * through a formula, clones a fragment that carries no source at all: what
     * came out was either nothing or the rendered `E=mc2`. Pushing each endpoint
     * out onto the formula's own edge is what turns "any overlap with a formula"
     * into `$…$` — including a selection of only the first term of a longer
     * formula, whose partial source cannot be recovered anyway, so the whole
     * formula is the honest answer.
     *
     * A selection that already spans the formula from the outside is left alone.
     */
    function widenedOverFormulas(range) {
      const start = katexRootAround(range.startContainer)
      const end = katexRootAround(range.endContainer)
      if (start === null && end === null) return null
      const widened = range.cloneRange()
      if (start !== null && start.parentNode !== null) widened.setStartBefore(start)
      if (end !== null && end.parentNode !== null) widened.setEndAfter(end)
      return widened
    }

    /**
     * The KaTeX root the selection sits inside, or null.
     *
     * Snapping matters because KaTeX clips the MathML arm — the only place the TeX
     * source exists — to a 1px box, so a drag across a formula hits the VISUAL arm
     * and the clone would hold no source at all.
     *
     * The test is on the range's own endpoints, not on geometric containment:
     * `comparePoint` reports 0 both for a boundary that merely touches a formula
     * and for one that wraps it, so a whole-paragraph selection would look
     * "inside" and swallow the line. A boundary counts as inside when the range
     * starts or ends at an ELEMENT position within the formula's subtree, or when
     * the endpoint's text node lives inside it — which is exactly how a real drag
     * behaves (it starts on a character and ends somewhere in the formula).
     */
    function katexRootOf(range, text) {
      const start = elementOf(range.startContainer)
      const end = elementOf(range.endContainer)
      const insideStart = start === null ? null : start.closest('.katex, .katex-display, .katex-error')
      const insideEnd = end === null ? null : end.closest('.katex, .katex-display, .katex-error')
      // The selection must be one formula's content, not a wider strip that only
      // touches it: both endpoints have to land in the SAME KaTeX subtree, and the
      // selected text must be that subtree's own text. (Testing the whole root
      // would not do: a KaTeX root also carries the TeX `annotation`, so its
      // textContent reads `EE = mc^2E=mc2`.)
      if (insideStart === null || insideStart !== insideEnd) return null
      if (normalizeText(insideStart.textContent) !== normalizeText(text)) return null
      return insideStart.closest('.katex-display') ?? insideStart
    }

    /**
     * Scope of the material currently being serialized. A rendered footnote
     * reference is only a reference because its list is part of the SAME
     * material, and the serializer walks a clone (whose nodes have no ancestry),
     * so the scope is carried explicitly instead of guessed from the document.
     */
    let serializationScope = null

    /** Footnote count of the current scope; undefined until first needed. */
    let footnoteCount

    function withScope(scope, run) {
      const previous = serializationScope
      const previousCount = footnoteCount
      const previousMarkers = markerCheckboxes
      serializationScope = scope
      footnoteCount = undefined
      markerCheckboxes = new WeakSet()
      try {
        return run()
      } finally {
        serializationScope = previous
        footnoteCount = previousCount
        markerCheckboxes = previousMarkers
      }
    }

    /** The nearest ancestor that can answer `querySelector`, when there is one. */
    function scopeOfNodes(nodes) {
      for (const node of nodes) {
        const parent = node.nodeType === 1 ? node : node.parentNode
        if (parent !== null && parent !== undefined && typeof parent.querySelector === 'function') return parent
      }
      return null
    }

    function markdownFromNodes(nodes, scope) {
      // Blocks are already joined by exactly one blank line; no global newline
      // collapsing here, so blank lines INSIDE a fenced code block survive.
      const list = Array.from(nodes)
      return withScope(scope ?? scopeOfNodes(list), () => serializeBlocks(list).trim())
    }

    /** One detached fragment / node list → Markdown source. */

    /**
     * Serialize a range that lives in the LIVE document.
     *
     * Cloning alone is not enough for math: KaTeX renders each formula twice —
     * the MathML arm (which carries the TeX source in `<annotation>`) is clipped
     * to a 1px box, and the visible `.katex-html` arm is `aria-hidden`. A user
     * selecting a formula therefore selects the *visual* arm, and the clone has
     * no TeX in it at all. So formulas are resolved from the live tree by
     * geometry (every KaTeX root that intersects the range contributes its
     * `annotation`) and spliced into the clone, where the serializer's
     * `mathMarkdown` rule then consumes each formula exactly once.
     * @param range - a range in the live document.
     * @returns Markdown source.
     */
    function markdownFromLiveRange(range) {
      const cloned = cloneRangeContents(range)
      // Pre-wrap is decided before the formula splice changes the clone's text.
      return withPreWrap(range, cloned, () => markdownFromLiveClone(range, cloned))
    }

    function markdownFromLiveClone(range, cloned) {
      const formulas = collectFormulas(range, cloned)
      if (formulas.length === 0) return markdownFromNodes(cloned.childNodes, cloned)
      // Splice into the CLONE, and REPLACE each formula there: the clone is what
      // gets serialized, so the live document must not be touched at all. Doing it
      // in place also means the formula's `$…$` cannot be duplicated by its own
      // rendered arms — they are removed together with the node.
      for (let index = formulas.length - 1; index >= 0; index -= 1) {
        const formula = formulas[index]
        const placeholder = (cloned.ownerDocument ?? document)
          .createElement(formula.display ? 'div' : 'span')
        placeholder.setAttribute(MATH_ATTR, formula.tex)
        formula.node.parentNode.replaceChild(placeholder, formula.node)
      }
      return markdownFromNodes(cloned.childNodes, cloned)
    }

    /**
     * Every KaTeX root the range touches (live side) paired with the cloned node
     * standing for it.
     *
     * Correspondence: both sides are walked in document order counting ONLY KaTeX
     * roots, so the i-th live formula is the i-th cloned one. Both walks start at
     * the range's common ancestor, which is exactly the clone's root.
     * @param range - the live range.
     * @param cloned - that range's clone.
     * @returns splice instructions { index, tex, display }.
     */
    function collectFormulas(range, cloned) {
      // The search must run over the SAME extent the clone represents. Searching
      // the common ancestor's whole subtree and filtering by `intersectsNode`
      // pulls in formulas the clone does not contain (a range can touch an element
      // it does not cover), and the pairing then drifts: the second call over one
      // document spliced an extra formula, which duplicated `$…$` in the output.
      // Walk the CLONE for the roots (that is the extent being serialized) and the
      // LIVE tree only to read each root's TeX, pairing them in document order.
      const clonedRoots = outermostRoots(katexRootsOf(cloned, () => true))
      if (clonedRoots.length === 0) return []
      // Pair by document order: the live roots the range actually covers are read
      // for their TeX, the cloned roots are the nodes to replace.
      const scope = rootElementOf(range.commonAncestorContainer)
      if (scope === null || typeof scope.querySelectorAll !== 'function') return []
      const live = outermostRoots(katexRootsOf(scope, () => true)).filter((el) => {
        try {
          return range.intersectsNode(el)
        } catch {
          return false
        }
      })
      const limit = Math.min(live.length, clonedRoots.length)
      const out = []
      for (let i = 0; i < limit; i += 1) {
        const tex = texSourceOf(live[i]).trim()
        if (tex === '') continue
        out.push({ node: clonedRoots[i], tex, display: isDisplayMath(live[i]) })
      }
      return out
    }

    /**
     * The KaTeX roots under one node, outermost only — `.katex-display > .katex`
     * is one formula, not two.
     */
    function katexRootsOf(scope, accept) {
      const found = []
      if (scope.querySelectorAll !== undefined) {
        for (const el of scope.querySelectorAll('.katex, .katex-display, .katex-error')) {
          if (isMathPlaceholder(el)) continue
          // Nested root: keep only the outermost of each formula.
          if (el.parentElement !== null && el.parentElement.closest('.katex-display, .katex') !== null) continue
          if (!accept(el)) continue
          found.push(el)
        }
      }
      // The scope element itself can be the root (a selection exactly on `.katex`).
      if (isKatex(scope) && accept(scope)) found.unshift(scope)
      return found
    }

    /**
     * Pair the KaTeX roots the range touches (live) with their clones, outermost
     * root per formula. The clone may contain only the INNER root when the user
     * wrapped the visible arm rather than the whole `.katex`, so depth is
     * normalised on both sides before pairing — otherwise the i-th live root and
     * the i-th cloned root would drift apart.
     */
    function outermostRoots(elements) {
      const out = []
      for (const el of elements) out.push(el.closest('.katex-display') ?? el)
      return out
    }

    /** The element a node belongs to (the node itself when it is one). */
    function rootElementOf(node) {
      return node.nodeType === 1 ? node : (node.parentElement ?? null)
    }

    /** One live or cloned DOM range → Markdown source. */
    function markdownFromRange(range) {
      if (range === null || range === undefined || typeof range.cloneContents !== 'function') return ''
      // A selection inside one formula is reconstructed from the part it covers,
      // before any widening can turn it into the whole formula.
      const partial = partialFormulaMarkdown(range)
      if (partial !== null) return partial
      const code = codeSelectionMarkdown(range)
      if (code !== null) return code
      const literal = userTextSelection(range)
      if (literal !== null) return literal
      const snapped = snappedRange(range)
      if (!isInDocument(snapped)) {
        const cloned = cloneRangeContents(snapped)
        return withPreWrap(snapped, cloned, () => markdownFromNodes(cloned.childNodes, cloned))
      }
      const widget = widgetRootOf(snapped)
      if (widget !== null) return markdownFromNodes([widget], widget)
      return markdownFromLiveRange(snapped)
    }

    /**
     * A selection that lies entirely inside one code block or one inline code
     * span is CODE, not prose: escaping it (`*p = a_b;` → `\*p = a\_b;`) broke
     * every paste into an editor. Part of it comes back verbatim; all of it
     * comes back as the fence / code span it was. Widgets (diff, terminal)
     * keep their own serializers.
     * @returns Markdown source, or null when the range is not inside code.
     */
    function codeSelectionMarkdown(range) {
      const start = elementOf(range.startContainer)
      const end = elementOf(range.endContainer)
      if (start === null || end === null || typeof start.closest !== 'function' || typeof end.closest !== 'function') return null
      const text = rangeText(range)
      if (text === '') return null
      const pre = start.closest('pre')
      if (pre !== null && pre === end.closest('pre') && pre.closest(WIDGET_SELECTOR) === null) {
        const code = pre.querySelector('code') ?? pre
        if (normalizeText(code.textContent ?? '') === normalizeText(text)) return serializeCodeBlock(pre)
        return text
      }
      const span = start.closest('code')
      if (span !== null && span === end.closest('code') && span.closest(WIDGET_SELECTOR) === null) {
        const whole = span.textContent ?? ''
        return normalizeText(whole) === normalizeText(text) ? inlineCode(whole) : text
      }
      return null
    }

    /** Chat rows whose text DSH renders literally (`MessageText`), never as Markdown. */
    const LITERAL_ROW_SELECTOR = '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'

    /** Whether an element is block-level (computed style when live, tag otherwise). */
    function isBlockElement(el) {
      const view = el.ownerDocument?.defaultView
      if (el.isConnected && view !== null && view !== undefined && typeof view.getComputedStyle === 'function') {
        const display = view.getComputedStyle(el).display ?? ''
        if (display !== '') return !display.startsWith('inline') && display !== 'contents' && display !== 'none'
      }
      return BLOCK_TAGS.has(tagOf(el))
    }

    /** Marks a pre-wrap newline until the hard-break pass decides its form. */
    const LINE_MARK = '\uE000'

    /**
     * A selection that lies entirely inside one user / steering row is the
     * user's own typed text: DSH shows it literally and its source IS that
     * text, so it comes back unescaped (`**` stays `**`, decision A). Its
     * layout still survives: a pre-wrap newline between two non-blank lines
     * becomes a hard break written as two trailing spaces (invisible in a
     * plain-text paste, unlike `\`), and separate blocks (the text, a JSON
     * card, …) are separated by a blank line. `@` / `/` chips split the text
     * into several block `MessageText`s but are inline in the sentence, so
     * their parent counts as one block. Buttons and hidden chrome are left out.
     * @returns the literal text, or null when the range is not inside one such row.
     */
    function userTextSelection(range) {
      const start = elementOf(range.startContainer)
      const end = elementOf(range.endContainer)
      if (start === null || end === null || typeof start.closest !== 'function' || typeof end.closest !== 'function') return null
      const row = start.closest(LITERAL_ROW_SELECTOR)
      if (row === null || row !== end.closest(LITERAL_ROW_SELECTOR)) return null
      const blockCache = new Map()
      const blockOf = (el) => {
        if (blockCache.has(el)) return blockCache.get(el)
        let block = row
        for (let cursor = el; cursor !== null && cursor !== row; cursor = cursor.parentElement) {
          if (isBlockElement(cursor)) {
            block = cursor
            break
          }
        }
        const parent = block === row ? null : block.parentElement
        if (parent !== null && Array.from(parent.children).some((child) => child.hasAttribute('data-ref-chip'))) block = parent
        blockCache.set(el, block)
        return block
      }
      const blocks = []
      for (const node of liveTextsInRange(range)) {
        const parent = node.parentElement
        if (parent === null) continue
        let hidden = false
        let raw = false
        for (let el = parent; el !== null && el !== row; el = el.parentElement) {
          if (tagOf(el) === 'button' || isSkipped(el)) hidden = true
          if (tagOf(el) === 'pre') raw = true
        }
        if (hidden) continue
        const value = node.nodeValue ?? ''
        let text = value.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : value.length)
        if (text === '') continue
        const kept = raw || isPreWrapText(node)
        if (!raw) text = kept ? text.replace(/\r?\n/gu, LINE_MARK) : text.replace(/[ \t\n\r\f]+/gu, ' ')
        const key = blockOf(parent)
        let last = blocks[blocks.length - 1]
        if (last === undefined || last.key !== key) {
          last = { key, text: '', collapsedHead: !kept, collapsedTail: false }
          blocks.push(last)
        }
        last.text += text
        last.collapsedTail = !kept
      }
      const out = blocks.map((block) => {
        let text = block.text
        // Collapsed whitespace at a block's edge is not rendered.
        if (block.collapsedHead) text = text.replace(/^ +/u, '')
        if (block.collapsedTail) text = text.replace(/ +$/u, '')
        const lines = text.split(LINE_MARK).map((line) => (line.trim() === '' ? '' : line))
        return lines.reduce((acc, line, index) => {
          if (index === 0) return line
          const hard = lines[index - 1] !== '' && line !== ''
          return acc + (hard ? '  \n' : '\n') + line
        }, '')
      }).filter((text) => text.trim() !== '').join('\n\n')
      return out === '' ? null : out
    }

    /** Whether a node sits in an editable field (input, textarea, contenteditable). */
    function isEditableNode(node) {
      const el = elementOf(node)
      if (el === null || typeof el.closest !== 'function') return false
      const tag = tagOf(el)
      if (tag === 'input' || tag === 'textarea') return true
      const host = el.closest('[contenteditable]')
      return host !== null && host.getAttribute('contenteditable') !== 'false'
    }

    /** Whether a range's root is attached to the live document. */
    function isInDocument(range) {
      const root = rootElementOf(range.commonAncestorContainer)
      if (root === null) return false
      const owner = root.ownerDocument
      if (owner === null || owner === undefined || owner.body === null) return false
      return owner.body.contains(root)
    }

    /** An HTML string → Markdown source (used by tests and other plugins). */
    function markdownFromHtml(html) {
      const template = document.createElement('template')
      template.innerHTML = String(html)
      return markdownFromNodes(template.content.childNodes, template.content)
    }

    function markdownFromSelection() {
      const selection = document.getSelection()
      if (selection === null || selection.rangeCount === 0) return ''
      return markdownFromRange(selection.getRangeAt(0))
    }

    /* ---------------------------------------------------------------- *
     * Copy interception + the service
     * ---------------------------------------------------------------- */

    function installCopyListener() {
      // `writeClipboard()` falls back to `document.execCommand('copy')` when the
      // async clipboard API is unavailable (insecure context, denied permission),
      // and DSH's own copy buttons — code blocks, read/diff/terminal blocks — go
      // through it. Those synthesized copies carry text the user explicitly asked
      // for, so they must never be replaced by whatever happens to be selected.
      let synthesizing = false
      const ownerDocument = document
      const hadOwnExec = Object.prototype.hasOwnProperty.call(ownerDocument, 'execCommand')
      const previousExec = ownerDocument.execCommand
      const originalExec = typeof previousExec === 'function'
        ? previousExec.bind(ownerDocument)
        : null
      let wrapper = null
      if (originalExec !== null) {
        wrapper = (...args) => {
          synthesizing = true
          try {
            return originalExec(...args)
          } finally {
            synthesizing = false
          }
        }
        ownerDocument.execCommand = wrapper
      }
      const onCopy = (event) => {
        if (synthesizing) return
        try {
          // An editable field (a rename box, an inline editor inside a row)
          // owns its own copy; its selection is not transcript prose.
          if (isEditableNode(event.target) || isEditableNode(document.activeElement)) return
          const selection = document.getSelection()
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return
          const range = selection.getRangeAt(0)
          if (!rangeInTranscript(range)) return
          if (isEditableNode(range.startContainer) || isEditableNode(range.endContainer)) return
          const markdown = markdownFromRange(range)
          if (markdown === '') return
          const clipboard = event.clipboardData
          if (clipboard === null || clipboard === undefined) return
          event.preventDefault()
          // 0.2.2 added a shipped copy handler on assistant markdown containers:
          // it checks `defaultPrevented` first, so preventing is enough today, but
          // stopping propagation keeps that a fact instead of a convention.
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          // Plain-text only on purpose: the point of the plugin is that the
          // clipboard carries source, not rendered markup.
          clipboard.setData('text/plain', markdown)
        } catch (error) {
          console.warn('[dsh-copy-markdown] copy interception failed', error)
        }
      }
      ownerDocument.addEventListener('copy', onCopy, true)
      return () => {
        ownerDocument.removeEventListener('copy', onCopy, true)
        // Only undo our own patch: if something wrapped it after us, leave theirs.
        if (wrapper === null || ownerDocument.execCommand !== wrapper) return
        if (hadOwnExec) ownerDocument.execCommand = previousExec
        else delete ownerDocument.execCommand
      }
    }

    function provideService(ctx) {
      const api = {
        /** Markdown source of a DOM range. */
        fromRange: (range) => markdownFromRange(range),
        /** Markdown source of a node list (e.g. a fragment's childNodes). */
        fromNodes: (nodes) => markdownFromNodes(nodes),
        /** Markdown source of an HTML string. */
        fromHtml: (html) => markdownFromHtml(html),
        /** Markdown source of the current browser selection ('' when none). */
        fromSelection: () => markdownFromSelection(),
        /** Whether a range sits in a transcript row (not the composer/sidebar). */
        isTranscriptRange: (range) => rangeInTranscript(range),
      }
      if (typeof ctx.provide !== 'function') return () => {}
      return ctx.provide(SERVICE, api)
    }

    /** Run one fiber-owned effect, tolerating a ctx without `effect` (tests). */
    function effectOf(ctx, run, label) {
      if (typeof ctx.effect === 'function') return ctx.effect(run, label)
      const disposer = run()
      return typeof disposer === 'function' ? disposer : () => {}
    }

    return {
      inject: [],
      apply(ctx) {
        effectOf(ctx, installCopyListener, 'copy-markdown: copy listener')
        effectOf(ctx, () => provideService(ctx), 'copy-markdown: markdownSource service')
      },
      /**
       * Pure logic exposed for `tools/verify-core.mjs`. Cordis ignores unknown
       * members on a plugin object, and the browser never reads this.
       */
      internals: {
        SERVICE,
        rangeText,
        cloneRangeContents,
        markdownFromNodes,
        markdownFromRange,
        markdownFromHtml,
        markdownFromSelection,
        rangeInTranscript,
        transcriptRowOf,
        serializeTable,
        serializeList,
        serializeCodeBlock,
        partialFormulaMarkdown,
        formulaPlanOf,
        coveringNodes,
        topMathNode,
        mmlToTex,
        TEX_OF_CHAR,
      },
    }
  },
})
