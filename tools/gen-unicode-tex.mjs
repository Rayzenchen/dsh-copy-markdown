#!/usr/bin/env node
/**
 * Generate the MathML-character → TeX-macro table for `@local/dsh-copy-markdown`.
 *
 * A fragment of a formula is written back as TeX, and a character that came from
 * a macro (`\Longrightarrow` → `⟹`) has no source to copy: it has to be mapped
 * back. Hand-listing those characters is how `⟹` first came out as a bare glyph,
 * so the list is DERIVED from KaTeX itself instead:
 *
 *   1. every macro KaTeX defines is read out of its own source
 *      (`src/symbols.ts`, `src/macros.ts`);
 *   2. each one is rendered with KaTeX and its single visible character noted;
 *   3. one canonical macro per character is kept — the primitive over an alias,
 *      then the shortest name, then alphabetical, so the result is deterministic.
 *
 * Usage:
 *   node tools/gen-unicode-tex.mjs            # print the table
 *   node tools/gen-unicode-tex.mjs --write    # splice it into client.js
 *   node tools/gen-unicode-tex.mjs --stats    # just report the counts
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const ANCHORS = [
  join(pluginDir, 'package.json'),
  fileURLToPath(import.meta.url),
]
/**
 * Characters whose TeX form is not produced by any macro (or whose canonical
 * macro is not the one KaTeX happens to define): ASCII stays literal, except for
 * TeX's own syntax characters, which have to be escaped to survive.
 */
const OVERRIDES = new Map(Object.entries({
  '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_',
  '{': '\\{', '}': '\\}', '\\': '\\backslash',
  '−': '-', '∗': '*',
}))

const SIGNATURE_START = '      // SIGNATURES:START — do not edit by hand; run tools/gen-unicode-tex.mjs'
const SIGNATURE_END = '      // SIGNATURES:END'

const START = '      // GENERATED:START — do not edit by hand; run tools/gen-unicode-tex.mjs'
const END = '      // GENERATED:END'

/** The package directory of a resolved module (its main entry may sit in dist/). */
function packageRootOf(required) {
  try {
    return dirname(required.resolve('katex/package.json'))
  } catch {
    // A copy whose `exports` hides package.json: walk up from the entry point.
    const entry = dirname(required.resolve('katex'))
    for (let root = entry; ; root = dirname(root)) {
      if (existsSync(join(root, 'package.json'))) return root
      if (dirname(root) === root) return entry
    }
  }
}

/** KaTeX, from a direct dependency or from a package store next to one. */
function loadKatex() {
  for (const anchor of ANCHORS) {
    try {
      const required = createRequire(anchor)
      const mod = required('katex')
      if (mod !== undefined && typeof mod.renderToString === 'function') return { katex: mod, root: packageRootOf(required) }
    } catch {
      // try the next anchor
    }
    try {
      const store = join(dirname(anchor), 'node_modules', '.pnpm')
      for (const entry of readdirSync(store)) {
        if (!entry.startsWith('katex@')) continue
        const folder = join(store, entry, 'node_modules', 'katex')
        try {
          const mod = createRequire(join(folder, 'package.json'))(folder)
          if (mod !== undefined && typeof mod.renderToString === 'function') return { katex: mod, root: folder }
        } catch {
          // not a usable copy
        }
      }
    } catch {
      // no store here
    }
  }
  throw new Error('katex not found — the table is derived from its own sources')
}

/** Macro names KaTeX defines, primitives first so they win ties. */
function macroNames(root) {
  const names = new Map()
  const add = (escaped, primitive) => {
    // The sources spell a control sequence as `"\\equiv"`, i.e. with a doubled
    // backslash; the renderer wants the real one.
    const name = escaped.replace(/\\\\/gu, '\\')
    if (!/^\\[A-Za-z]+$/u.test(name)) return
    const previous = names.get(name)
    if (previous === undefined || (primitive && !previous.primitive)) names.set(name, { primitive })
  }
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8')
  for (const match of symbols.matchAll(/defineSymbol\([^;]*?"(\\\\[A-Za-z]+)"/gu)) add(match[1], true)
  for (const match of symbols.matchAll(/"((?:\\\\[A-Za-z]+))"\s*\)/gu)) add(match[1], true)
  const macros = readFileSync(join(root, 'src', 'macros.ts'), 'utf8')
  for (const match of macros.matchAll(/defineMacro\("(\\\\[A-Za-z]+)"/gu)) add(match[1], false)
  return [...names.entries()].map(([name, info]) => ({ name, primitive: info.primitive }))
}

function main() {
  const { katex, root } = loadKatex()
  let JSDOM = null
  for (const anchor of ANCHORS) {
    try {
      JSDOM = createRequire(anchor)('jsdom').JSDOM
      break
    } catch {
      // try the next anchor
    }
  }
  if (JSDOM === null) throw new Error('jsdom not found — needed to read what a macro renders to')
  const dom = new JSDOM('<!doctype html><body></body>')
  const document = dom.window.document
  const INVISIBLE = /[\u200b-\u200f\u2061-\u2064\ufe00-\ufe0f\u0300-\u036f\u20d0-\u20ff]/gu

  /** The element a macro's MathML reduces to (unwrapping math/semantics/mrow). */
  const rootNodeOf = (candidate) => {
    let html
    const log = console.log
    console.log = () => {}      // `\show` and friends print while rendering
    try {
      html = katex.renderToString(candidate, { throwOnError: true })
    } catch {
      return null
    } finally {
      console.log = log
    }
    const template = document.createElement('template')
    template.innerHTML = html
    let node = template.content.firstElementChild.querySelector('.katex-mathml math')
    const elements = (el) => [...el.childNodes].filter((child) => child.nodeType === 1
      && child.tagName.toLowerCase() !== 'annotation')
    const visible = (el) => el.textContent.replace(INVISIBLE, '').trim()
    for (;;) {
      if (node === null) return null
      const tag = node.tagName.toLowerCase()
      if (tag === 'math' || tag === 'semantics') {
        node = elements(node)[0] ?? null
        continue
      }
      if (tag === 'mrow') {
        const kids = elements(node)
        // A macro's row can hold friends the macro did not author (`\bmod` comes
        // with an invisible operator next to it): the node that carries the text
        // is the one the macro is.
        const carrier = kids.find((kid) => visible(kid) === visible(node)) ?? kids[0]
        node = carrier ?? null
        continue
      }
      return node
    }
  }

  /** The text of every leaf under one node, invisible characters removed. */
  const leafTextOf = (node) => {
    const leaves = []
    const walk = (current) => {
      const tag = current.tagName.toLowerCase()
      if (['mi', 'mo', 'mn', 'mtext', 'ms'].includes(tag)) {
        leaves.push(current.textContent)
        return
      }
      for (const child of current.childNodes) {
        if (child.nodeType !== 1 || child.tagName.toLowerCase() === 'annotation') continue
        walk(child)
      }
    }
    walk(node)
    return leaves.join('').replace(INVISIBLE, '')
  }

  /**
   * The single character a macro renders to, and the TeX that produces it — a
   * plain macro in math mode, or the same macro inside `\\text{…}` for the ones
   * that only exist in text mode (`\\AA` is how `˚` is reachable at all).
   */
  const mappingOf = (name) => {
    const direct = rootNodeOf(name)
    if (direct !== null) {
      const characters = [...leafTextOf(direct)]
      const signature = signatureOf(direct)
      const character = characters.length === 1 ? characters[0] : null
      if (character !== null || signature !== null) return { character, tex: name, signature }
    }
    const inText = rootNodeOf(`\\text{${name}}`)
    if (inText !== null) {
      const characters = [...leafTextOf(inText)]
      if (characters.length === 1) return { character: characters[0], tex: `\\text{${name}}`, signature: null }
    }
    return null
  }

  /**
   * The signature of a node that IS the macro: `\bmod` is `<mo>mod</mo>` and
   * `\plim` is `<mo><mi mathvariant="normal">plim</mi></mo>`, so reading their
   * text loses the operator. Multi-character names and fonts are recorded by
   * signature as well as by character.
   */
  const signatureOf = (node) => {
    const tag = node.tagName.toLowerCase()
    if (!['mi', 'mo', 'mn'].includes(tag)) return null
    const variant = node.getAttribute('mathvariant') ?? ''
    const text = node.textContent.trim()
    // Every node is recorded, single characters included: `\varDelta` and
    // `\Delta` both render `Δ` but with different fonts, and `.` the operator
    // (`\ldotp`) spaces differently from `.` the letter — the NODE is the
    // ground truth, the character alone is not.
    const kids = [...node.children].map((child) => child.tagName.toLowerCase()).join(',')
    return `${tag}|${variant}|${text}|${kids}`
  }

  const best = new Map()
  const signatures = new Map()
  let tried = 0
  for (const { name, primitive } of macroNames(root)) {
    tried += 1
    const mapping = mappingOf(name)
    if (mapping === null) continue
    const candidate = { name, primitive, tex: mapping.tex }
    if (mapping.signature !== null) {
      // One winner per node: the primitive over an alias, then the shortest name.
      const previous = signatures.get(mapping.signature)
      const better = previous === undefined
        || (candidate.primitive && previous !== undefined && !previous.primitive)
        || (previous !== undefined && candidate.primitive === previous.primitive
          && mapping.tex.length < previous.tex.length)
        || (previous !== undefined && candidate.primitive === previous.primitive
          && mapping.tex.length === previous.tex.length && mapping.tex < previous.tex)
      if (better) signatures.set(mapping.signature, { ...candidate, primitive: candidate.primitive })
    }
    const character = mapping.character
    if (character === null) continue
    // ASCII renders as itself: KaTeX also has macros that DRAW a plain letter in
    // an upright font (`\Epsilon` → `E`, `\angln` → `n`), and mapping a plain
    // `E` onto one of those would silently change the font of ordinary text.
    if (character.codePointAt(0) < 0x80) continue
    const previous = best.get(character)
    if (previous === undefined
      || (candidate.primitive && !previous.primitive)
      || (candidate.primitive === previous.primitive && candidate.name.length < previous.name.length)
      || (candidate.name.length === previous.name.length && candidate.name < previous.name)) {
      best.set(character, candidate)
    }
  }

  const entries = [...best.entries(), ...OVERRIDES.entries()]
    .sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0))
  const stats = process.argv.includes('--stats')
  if (stats) {
    console.log(`KaTeX ${katex.version}: ${tried} macros tried, ${entries.length} characters, ${signatures.size} node signatures`)
    return
  }
  const lines = []
  let line = '      '
  for (const [character, value] of entries) {
    const name = typeof value === 'string' ? value : value.tex
    const key = JSON.stringify(character).replace(/^"|"$/gu, "'").replace(/'/gu, "'")
    const pair = `${key}: '${name.replace(/\\/gu, '\\\\')}', `
    if (line.length + pair.length > 108) {
      lines.push(line.trimEnd())
      line = '      '
    }
    line += pair
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  const table = [`      // Derived from KaTeX ${katex.version} (tools/gen-unicode-tex.mjs).`,
    ...lines].join('\n')

  const signatureLines = []
  let signatureLine = '      '
  for (const [signature, entry] of [...signatures.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pair = `${JSON.stringify(signature)}: '${entry.tex.replace(/\\/gu, '\\\\')}', `
    if (signatureLine.length + pair.length > 108) {
      signatureLines.push(signatureLine.trimEnd())
      signatureLine = '      '
    }
    signatureLine += pair
  }
  if (signatureLine.trim() !== '') signatureLines.push(signatureLine.trimEnd())
  const signatureTable = signatures.size === 0 ? '' : `\n${signatureLines.join('\n')}`

  if (!process.argv.includes('--write')) {
    console.log(`${START}\n${table}\n${END}`)
    console.log(`\n${SIGNATURE_START}\n      // ${signatures.size} signatures\n${signatureTable}\n${SIGNATURE_END}`)
    return
  }
  const clientPath = join(pluginDir, 'client.js')
  let source = readFileSync(clientPath, 'utf8')
  for (const [open, close, body] of [
    [START, END, table],
    [SIGNATURE_START, SIGNATURE_END, signatureTable.trim() === '' ? '      ' : signatureTable],
  ]) {
    const from = source.indexOf(open)
    const to = source.indexOf(close)
    if (from === -1 || to === -1 || to < from) throw new Error(`markers not found: ${open}`)
    source = source.slice(0, from) + open + '\n' + body + '\n' + source.slice(to)
  }
  writeFileSync(clientPath, source)
  console.log(`wrote ${entries.length} character mappings and ${signatures.size} node signatures into client.js`)
}

main()
