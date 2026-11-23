#!/usr/bin/env node
/**
 * Verification harness for `@local/dsh-copy-markdown`.
 *
 * Loads the plugin's real client half, then drives the DOM → Markdown serializer
 * and the copy listener against **real DOM** (jsdom), because the serializer's
 * whole job is to walk a live DOM range. Fixtures reproduce the shapes the
 * installed Harness renders: KaTeX (MathML `annotation` + aria-hidden visual
 * arm), highlighted code blocks, GFM tables, task lists, and UI chrome.
 *
 * Run: `node tools/verify-core.mjs`
 */
import { createRequire, createRequire as makeRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

/* ------------------------------------------------------------------ *
 * jsdom (a devDependency: run `npm install` in the plugin directory first)
 * ------------------------------------------------------------------ */

function loadJsdom() {
  const anchors = [
    join(pluginDir, 'package.json'),
    fileURLToPath(import.meta.url),
  ]
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const mod = require('jsdom')
      if (mod !== undefined && mod.JSDOM !== undefined) return mod.JSDOM
    } catch {
      // try the next anchor
    }
  }
  throw new Error('jsdom not found — run `npm install` in the plugin directory first')
}

const JSDOM = loadJsdom()
void makeRequire

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let pass = 0
let fail = 0
const failures = []

function check(name, condition, extra) {
  if (condition) {
    pass += 1
    console.log(`  \u2713 ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.error(`  \u2717 ${name}${extra === undefined ? '' : ` \u2014 ${extra}`}`)
  }
}

function eq(name, actual, expected) {
  const same = Object.is(actual, expected)
  check(name, same, same ? undefined : `expected:\n${JSON.stringify(expected)}\ngot:\n${JSON.stringify(actual)}`)
}

function group(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ *
 * Load the client half exactly as the Web shell would
 * ------------------------------------------------------------------ */

let handoff = null
globalThis.window = { __ModuleLoader__: { load: (next) => { handoff = next } } }

await import(pathToFileURL(join(pluginDir, 'client.js')).href)

check('client half registers itself through window.__ModuleLoader__', handoff !== null)
eq('bundle id', handoff?.id, '@local/dsh-copy-markdown')

const plugin = handoff.factory(() => { throw new Error('this bundle requires no modules') })
const I = plugin.internals
check('plugin exposes apply()', typeof plugin.apply === 'function')
check('plugin exposes its internals for this harness', typeof I?.markdownFromRange === 'function')

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/** Fresh jsdom document; rebinds the globals the plugin reads at call time. */
function withDom(body) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`)
  globalThis.document = dom.window.document
  globalThis.window = {
    __ModuleLoader__: { load: () => {} },
    getSelection: () => dom.window.getSelection(),
  }
  return dom
}

/** Markdown of the contents of the element with the given id. */
function markdownOfSelection(dom, id) {
  const target = dom.window.document.getElementById(id)
  const range = dom.window.document.createRange()
  range.selectNodeContents(target)
  return I.markdownFromRange(range)
}

const KATEX_INLINE =
  '<span class="katex">'
  + '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>'
  + '<mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>'
  + '<annotation encoding="application/x-tex">E = mc^2</annotation>'
  + '</semantics></math></span>'
  + '<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>'
  + '</span>'

const KATEX_DISPLAY =
  '<span class="katex-display"><span class="katex">'
  + '<span class="katex-mathml"><math><semantics>'
  + '<annotation encoding="application/x-tex">\\int_0^1 x^2 dx = \\frac{1}{3}</annotation>'
  + '</semantics></math></span>'
  + '<span class="katex-html" aria-hidden="true">∫</span>'
  + '</span></span>'

/* ------------------------------------------------------------------ *
 * 1. Formulas
 * ------------------------------------------------------------------ */

group('1. 公式：从 KaTeX 的 MathML annotation 还原 $TeX$')

{
  const dom = withDom(`<div id="t"><p>质能关系 ${KATEX_INLINE} 很著名。</p></div>`)
  eq('行内公式还原为 $…$，视觉臂不重复计入', markdownOfSelection(dom, 't'), '质能关系 $E = mc^2$ 很著名。')
}
{
  const dom = withDom(`<div id="t"><p>块级：</p>${KATEX_DISPLAY}</div>`)
  eq('块级公式还原为 $$…$$', markdownOfSelection(dom, 't'), '块级：\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$')
}
{
  const dom = withDom(`<div id="t"><p>${KATEX_DISPLAY}</p></div>`)
  eq('包在段落里的块级公式也单独成块', markdownOfSelection(dom, 't'), '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$')
}
{
  const dom = withDom('<div id="t"><p>非法公式 <span class="katex-error" title="KaTeX parse error">\\bad{</span> 结束</p></div>')
  eq('解析失败的公式仍还原成它的 $…$ 源码', markdownOfSelection(dom, 't'), '非法公式 $\\bad{$ 结束')
}

/* ------------------------------------------------------------------ *
 * 2. Blocks
 * ------------------------------------------------------------------ */

group('2. 块级结构：标题 / 代码 / 列表 / 引用 / 表格')

{
  const dom = withDom(
    '<div id="t">'
    + '<h2>推导</h2>'
    + '<pre><code class="language-ts"><span class="line">const x: number = 1</span></code></pre>'
    + '<ul><li>第一项</li><li>第二项<ul><li>嵌套</li></ul></li></ul>'
    + '<ol start="3"><li>三</li><li>四</li></ol>'
    + '<blockquote><p>引用一<br>引用二</p></blockquote>'
    + '<table><thead><tr><th>列 A</th><th>列 B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    + '<p>链接 <a href="https://x.dev">X</a> 与 <strong>粗</strong> <em>斜</em> <code>a|b</code></p>'
    + '<div><button type="button">复制</button><svg></svg>正文</div>'
    + '<ul><li><input type="checkbox" checked> 已完成</li><li><input type="checkbox"> 未完成</li></ul>'
    + '</div>',
  )
  eq('标题/代码/列表/引用/表格/行内样式/chrome/任务列表', markdownOfSelection(dom, 't'), [
    '## 推导',
    '',
    '```ts',
    'const x: number = 1',
    '```',
    '',
    '- 第一项',
    '- 第二项',
    '  - 嵌套',
    '',
    '3. 三',
    '4. 四',
    '',
    '> 引用一\\',
    '> 引用二',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '链接 [X](https://x.dev) 与 **粗** *斜* `a|b`',
    '',
    '正文',
    '',
    '- [x] 已完成',
    '- [ ] 未完成',
  ].join('\n'))
}
{
  const dom = withDom('<div id="t"><pre><code class="language-md">a\n\n\nb</code></pre></div>')
  eq('代码块里的空行不被压缩', markdownOfSelection(dom, 't'), '```md\na\n\n\nb\n```')
}
{
  const dom = withDom('<div id="t"><pre><code><span class="line">Σ = 1</span></code></pre></div>')
  eq('无语言标注时围栏不带语言', markdownOfSelection(dom, 't'), '```\nΣ = 1\n```')
}
{
  const dom = withDom('<div id="t"><p>代码里有反引号 <code>a`b</code> 结尾</p></div>')
  eq('行内代码含反引号时自动加长围栏', markdownOfSelection(dom, 't'), '代码里有反引号 ``a`b`` 结尾')
}
{
  const dom = withDom('<div id="t"><p>单元格竖线 | 与换行<br>继续</p><table><tr><th>A</th></tr><tr><td>x|y</td></tr></table></div>')
  eq('表格单元格里的竖线被转义（正文里的竖线保持原样）', markdownOfSelection(dom, 't'), '单元格竖线 | 与换行\\\n继续\n\n| A |\n| --- |\n| x\\|y |')
}

{
  const dom = withDom('<div id="t"><div class="md-code-block"><div class="bannerWrap"><div class="banner" data-code-block-banner="true"><div class="infostring">ts</div><div class="action"><button type="button">复制</button></div></div></div><div class="content" data-code-block-content="true"><pre class="shiki css-variables" tabindex="0"><code><span class="line">const x = 1</span></code></pre></div></div></div>')
  eq('安装版代码块：横幅被跳过、语言取自横幅', markdownOfSelection(dom, 't'), '```ts\nconst x = 1\n```')
}
{
  const dom = withDom('<div id="t"><div class="md-code-block"><div class="header" data-code-block-banner="true"><div class="heading"><span class="language">python</span><span class="title">a.py</span></div><div class="actions"><button type="button">拷贝</button></div></div><div class="content" data-code-block-content="true"><pre class="shiki"><code><span class="line">print(1)</span></code></pre></div></div></div>')
  eq('卡片式代码块：文件名不泄漏进语言位', markdownOfSelection(dom, 't'), '```python\nprint(1)\n```')
}
{
  const dom = withDom('<div id="t"><div class="md-code-block"><div class="bannerWrap"><div class="banner" data-code-block-banner="true"><div class="infostring">代码</div></div></div><div class="content" data-code-block-content="true"><pre class="shiki"><code><span class="line">x</span></code></pre></div></div></div>')
  eq('无高亮支持时的通用标签不当作语言', markdownOfSelection(dom, 't'), '```\nx\n```')
}

/* ------------------------------------------------------------------ *
 * 3. Partial selections
 * ------------------------------------------------------------------ */

group('3. 局部选区：不整段选中也要得到正确源码')

{
  const dom = withDom(`<div id="t"><p>前缀 <strong>中间<em>强调</em></strong> 后缀</p></div>`)
  const p = dom.window.document.querySelector('strong')
  const range = dom.window.document.createRange()
  range.selectNodeContents(p)
  eq('选中加粗整段时补回 ** 标记', I.markdownFromRange(range), '**中间*强调***')
}
{
  const dom = withDom(`<div id="t"><p>甲${KATEX_INLINE}乙</p></div>`)
  const katex = dom.window.document.querySelector('.katex')
  const range = dom.window.document.createRange()
  range.selectNode(katex)
  eq('只选中公式本身', I.markdownFromRange(range), '$E = mc^2$')
}

{
  // The real mouse case: the TeX-carrying MathML arm is clipped to 1px, so a drag
  // lands on the VISIBLE arm. The endpoint inside the formula is pushed out onto
  // the formula's own edge, so the clone holds the root that carries the source —
  // and the two arms are never counted twice.
  const dom = withDom(`<div data-chat-flow><p id="t">甲 ${KATEX_INLINE} 乙</p></div>`)
  const p = dom.window.document.getElementById('t')
  const visible = p.querySelector('.katex-html')
  const dragInside = dom.window.document.createRange()
  dragInside.setStartBefore(visible)
  dragInside.setEndAfter(visible)
  eq('只覆盖可见臂（不含两侧间隙）也拿到源码', I.markdownFromRange(dragInside), '$E = mc^2$')

  const dragAcross = dom.window.document.createRange()
  dragAcross.setStart(p.firstChild, 0)
  dragAcross.setEnd(visible, 0)
  eq('从正文拖进公式：保留正文，公式整体还原', I.markdownFromRange(dragAcross), '甲 $E = mc^2$')

  const whole = dom.window.document.createRange()
  whole.selectNodeContents(p)
  eq('整段选中不会把两个渲染臂都算进去', I.markdownFromRange(whole), '甲 $E = mc^2$ 乙')
}
{
  // Every shape a real drag can take over one inline formula, including the ones
  // that do NOT catch the spacing around it. The TeX source lives only on the
  // formula root, so any overlap has to be widened onto that root: otherwise the
  // clone holds a fragment of the rendered arm and the output was the glyphs
  // (`E=mc2`), a single glyph (`E`), or nothing at all.
  const dom = withDom(`<div data-chat-flow><p id="t">甲，${KATEX_INLINE}乙</p></div>`)
  const p = dom.window.document.getElementById('t')
  const katex = p.querySelector('.katex')
  const glyph = p.querySelector('.katex-html .base').firstChild
  const range = () => dom.window.document.createRange()

  const contents = range()
  contents.setStart(katex, 0)
  contents.setEnd(katex, katex.childNodes.length)
  eq('只盖住公式的全部子节点（不含根元素）', I.markdownFromRange(contents), '$E = mc^2$')

  const glyphs = range()
  glyphs.setStart(glyph, 0)
  glyphs.setEnd(glyph, glyph.nodeValue.length)
  eq('从第一个字形拖到最后一个字形', I.markdownFromRange(glyphs), '$E = mc^2$')

  const partial = range()
  partial.setStart(glyph, 0)
  partial.setEnd(glyph, 1)
  eq('只选中公式的一部分时只还原那一部分（E）', I.markdownFromRange(partial), '$E$')

  const partialTail = range()
  partialTail.setStart(glyph, 2)
  partialTail.setEnd(glyph, glyph.nodeValue.length)
  eq('只选中公式的后半段（mc^2）', I.markdownFromRange(partialTail), '$mc^{2}$')

  const operator = range()
  operator.setStart(glyph, 1)
  operator.setEnd(glyph, 2)
  eq('只选中一个运算符（=）', I.markdownFromRange(operator), '$=$')

  const fromProse = range()
  fromProse.setStart(p.firstChild, 0)
  fromProse.setEnd(glyph, 2)
  eq('从正文（逗号后）拖进公式一半：正文保留 + 整条公式', I.markdownFromRange(fromProse), '甲，$E = mc^2$')

  const insideArm = range()
  insideArm.setStart(glyph, 0)
  insideArm.setEnd(p.lastChild, p.lastChild.nodeValue.length)
  eq('从公式里拖到公式后面：公式还原、后文保留', I.markdownFromRange(insideArm), '$E = mc^2$乙')
}
{
  // A display formula behaves the same way, and widening must take the whole
  // `.katex-display` wrapper rather than only its inner `.katex`.
  const dom = withDom(`<div data-chat-flow><div id="t"><p>块级：</p>${KATEX_DISPLAY}</div></div>`)
  const glyph = dom.window.document.querySelector('.katex-display .katex-html').firstChild
  const range = dom.window.document.createRange()
  range.setStart(glyph, 0)
  range.setEnd(glyph, 1)
  eq('块级公式只选中一部分也还原成 $$…$$', I.markdownFromRange(range), '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$')
}
{
  // Two formulas in one paragraph: the live/clone walk must pair them by order.
  const dom = withDom(`<div data-chat-flow><p id="t">${KATEX_INLINE} 与 ${KATEX_INLINE} 并列</p></div>`)
  eq('同一段里两个公式各自还原', markdownOfSelection(dom, 't'), '$E = mc^2$ 与 $E = mc^2$ 并列')
}
{
  const dom = withDom('<div data-chat-flow><p id="t">只有文字，没有公式。</p></div>')
  const text = dom.window.document.getElementById('t').firstChild
  const partial = dom.window.document.createRange()
  partial.setStart(text, 0)
  partial.setEnd(text, 3)
  eq('没有公式时仍按字符精确截取', I.markdownFromRange(partial), '只有文')
}

/* ------------------------------------------------------------------ *
 * 4. Region guards
 * ------------------------------------------------------------------ */

group('4. 区域判定：只在对话正文里生效')

const TRANSCRIPT = (inner, id = 't') =>
  '<div data-conversation-session="s1" data-conversation-region="chat"><div data-conversation-scroll="">'
  + `<div data-chat-flow-key="3:assistant-step" data-chat-turn="1" data-chat-flow-kind="assistant-step">${inner}</div>`
  + '<div data-composer-seat=""><div id="composer">草稿里的字</div></div>'
  + '</div></div>'

function rangeOver(dom, id) {
  const el = dom.window.document.getElementById(id)
  const range = dom.window.document.createRange()
  range.selectNodeContents(el)
  return range
}

{
  const dom = withDom(TRANSCRIPT('<p id="t">正文里的字</p>'))
  eq('正文行内 → 是', I.rangeInTranscript(rangeOver(dom, 't')), true)
  eq('输入框内 → 否', I.rangeInTranscript(rangeOver(dom, 'composer')), false)
}
{
  const dom = withDom('<div><p id="t">侧栏里的字</p></div>')
  eq('对话区之外 → 否', I.rangeInTranscript(rangeOver(dom, 't')), false)
}
{
  const dom = withDom('<div data-conversation-session="s1"><div data-conversation-scroll=""><div data-chat-flow id="t">分组内容</div></div></div>')
  eq('分组容器（data-chat-flow）也算正文', I.rangeInTranscript(rangeOver(dom, 't')), true)
}

/* ------------------------------------------------------------------ *
 * 5. Copy interception end to end
 * ------------------------------------------------------------------ */

group('5. 复制拦截：Cmd+C 拿到的是 markdown 源码')

{
  const dom = withDom(TRANSCRIPT(`<p id="t">质能关系 ${KATEX_INLINE} 很著名。</p>`))
  const provided = new Map()
  const disposers = []
  plugin.apply({
    effect: (run) => { const off = run(); if (typeof off === 'function') disposers.push(off); return () => {} },
    provide: (name, value) => { provided.set(name, value); return () => { provided.delete(name) } },
  })
  check('markdownSource 服务已提供', provided.has(I.SERVICE))

  const range = rangeOver(dom, 't')
  const selection = dom.window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  eq('jsdom 选区已建立（前置条件）', selection.rangeCount, 1)
  eq('服务 fromRange 与内部实现一致', provided.get(I.SERVICE).fromRange(range), '质能关系 $E = mc^2$ 很著名。')

  const written = {}
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true })
  event.clipboardData = { setData: (type, value) => { written[type] = value } }
  dom.window.document.dispatchEvent(event)
  eq('复制事件被接管并写入 markdown', written['text/plain'], '质能关系 $E = mc^2$ 很著名。')
  eq('复制被 preventDefault（浏览器不再写渲染文本）', event.defaultPrevented, true)

  // The real drag: it starts and ends inside the formula's VISUAL arm, without
  // catching the gaps around it. The endpoint is widened onto the formula's edge,
  // so Cmd+C still puts the source on the clipboard instead of `E=mc2`.
  const arm = dom.window.document.getElementById('t').querySelector('.katex-html')
  const armRange = dom.window.document.createRange()
  armRange.setStartBefore(arm)
  armRange.setEndAfter(arm)
  const selection3 = dom.window.getSelection()
  selection3.removeAllRanges()
  selection3.addRange(armRange)
  const written3 = {}
  const event3 = new dom.window.Event('copy', { bubbles: true, cancelable: true })
  event3.clipboardData = { setData: (type, value) => { written3[type] = value } }
  dom.window.document.dispatchEvent(event3)
  eq('只框住公式视觉臂时 Cmd+C 也写入 $…$', written3['text/plain'], '$E = mc^2$')

  // Outside the transcript the plugin must stay out of the way.
  const composerRange = rangeOver(dom, 'composer')
  const selection2 = dom.window.getSelection()
  selection2.removeAllRanges()
  selection2.addRange(composerRange)
  const written2 = {}
  const event2 = new dom.window.Event('copy', { bubbles: true, cancelable: true })
  event2.clipboardData = { setData: (type, value) => { written2[type] = value } }
  dom.window.document.dispatchEvent(event2)
  eq('输入框里的复制不被接管', written2['text/plain'], undefined)
  eq('输入框里的复制不 preventDefault', event2.defaultPrevented, false)

  eq('apply 登记的 disposer 数量（监听 + 服务）', disposers.length, 2)
}

/* ------------------------------------------------------------------ *
 * 6. HTML entry point
 * ------------------------------------------------------------------ */

group('6. 直接喂 HTML（服务与测试共用的入口）')

{
  withDom('<div></div>')
  eq(
    'fromHtml 与 DOM 路径等价',
    I.markdownFromHtml(`<p>甲 ${KATEX_INLINE} 乙</p><ul><li>x</li></ul>`),
    '甲 $E = mc^2$ 乙\n\n- x',
  )
  eq('空 HTML 得到空串', I.markdownFromHtml(''), '')
}

/* ------------------------------------------------------------------ *
 * 7. Literal escaping
 * ------------------------------------------------------------------ */

group('7. 字面转义：粘回去还是同一份内容，而不是被重新解析')

{
  const dom = withDom('<div id="t"><p>参数是 *args 和 **kwargs，还有 _private 与 snake_case</p></div>')
  eq(
    '字面星号被转义，词内下划线保持原样',
    markdownOfSelection(dom, 't'),
    '参数是 \\*args 和 \\*\\*kwargs，还有 \\_private 与 snake_case',
  )
}
{
  const dom = withDom('<div id="t"># 不是标题\n- 不是列表\n1. 不是编号\n> 不是引用\n--- 不是分隔线\n    缩进行</div>')
  eq(
    '行首的块语法被转义（含四空格缩进）',
    markdownOfSelection(dom, 't'),
    '\\# 不是标题\n\\- 不是列表\n1\\. 不是编号\n\\> 不是引用\n--- 不是分隔线\n&#32;   缩进行',
  )
}
{
  const dom = withDom('<div id="t"><p>用 ` 分隔，价格 $x$ 元，写 &lt;div&gt; 与 &amp;amp;</p></div>')
  eq(
    '反引号/成对美元/标签/实体都被转义',
    markdownOfSelection(dom, 't'),
    '用 \\` 分隔，价格 \\$x\\$ 元，写 \\<div> 与 \\&amp;',
  )
}
{
  const dom = withDom('<div id="t"><p>价格 $5 到 $10，单独一个 $ 留着</p></div>')
  eq('美元一律转义（micromark 会把 $5 到 $10 读成公式）', markdownOfSelection(dom, 't'), '价格 \\$5 到 \\$10，单独一个 \\$ 留着')
}
{
  const dom = withDom('<div id="t"><pre><code class="language-ts">const a = *b; `tick`; $x$</code></pre></div>')
  eq('代码块里的内容一个字符都不转义', markdownOfSelection(dom, 't'), '```ts\nconst a = *b; `tick`; $x$\n```')
}

/* ------------------------------------------------------------------ *
 * 8. Links, images, alignment, inline HTML
 * ------------------------------------------------------------------ */

group('8. 链接/图片/表格对齐/富格式：产出一定是能解析的 Markdown')

{
  const dom = withDom('<div id="t"><p>链接 <a href="https://x.dev">X</a></p></div>')
  eq('普通链接', markdownOfSelection(dom, 't'), '链接 [X](https://x.dev)')
}
{
  const dom = withDom('<div id="t"><p>看 <a href="https://x.dev/a b">[这里]</a></p></div>')
  eq(
    '标签里的方括号与含空格的 URL 都不破坏链接',
    markdownOfSelection(dom, 't'),
    '看 [\\[这里\\]](<https://x.dev/a%20b>)',
  )
}
{
  const dom = withDom('<div id="t"><p><img alt="图 ] 注" src="a.png"></p></div>')
  eq('图片 alt 里的 ] 被转义', markdownOfSelection(dom, 't'), '![图 \\] 注](a.png)')
}
{
  const dom = withDom('<div id="t"><table><tr><th style="text-align: center">中</th><th align="right">右</th><th>默认</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table></div>')
  eq(
    '表格对齐写回分隔行',
    markdownOfSelection(dom, 't'),
    '| 中 | 右 | 默认 |\n| :---: | ---: | --- |\n| 1 | 2 | 3 |',
  )
}
{
  const dom = withDom('<div id="t"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody id="body"><tr><td>1</td><td>2</td></tr></tbody></table></div>')
  eq(
    '选区正好落在一个 tbody 上时仍还原成 GFM 表格',
    markdownOfSelection(dom, 'body'),
    '| 1 | 2 |\n| --- | --- |',
  )
}
{
  const dom = withDom('<div id="t"><p>这<mark>高亮</mark>那<u>下划</u>x<sup>2</sup>y<sub>1</sub></p></div>')
  eq(
    '没有 Markdown 语法的行内样式用行内 HTML 保住',
    markdownOfSelection(dom, 't'),
    '这<mark>高亮</mark>那<u>下划</u>x<sup>2</sup>y<sub>1</sub>',
  )
}

/* ------------------------------------------------------------------ *
 * 9. Shell-specific blocks
 * ------------------------------------------------------------------ */

group('9. DSH 专有块：diff 卡 / 终端块 / 脚注')

{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="3:assistant-step"><div id="t" data-diff="" class="md-code-block" data-code-wrap="">'
    + '<div data-code-block-banner="true"><div class="heading"><span class="language">diff</span></div>'
    + '<div class="actions"><button type="button">复制</button></div></div>'
    + '<div class="body">'
    + '<div class="_line_17vb8_13 _path_17vb8_28">a/b.ts</div>'
    + '<div class="_line_17vb8_13 _context_17vb8_58">const a = 1</div>'
    + '<div class="_line_17vb8_13 _del_17vb8_38">const b = 2</div>'
    + '<div class="_line_17vb8_13 _add_17vb8_48">const b = 3</div>'
    + '<button type="button" class="expand">展开</button>'
    + '</div></div></div></div></div>',
  )
  eq(
    'diff 卡还原成 ```diff 围栏（横幅与展开按钮不进正文）',
    markdownOfSelection(dom, 't'),
    '```diff\na/b.ts\n  const a = 1\n- const b = 2\n+ const b = 3\n```',
  )
}
{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="3:tool"><div id="t" data-terminal="" data-body="">'
    + '<div class="header_x_header_1">'
    + '<div class="prompt_x_prompt_2"><span class="runStateLabel_x_3">已完成</span>'
    + '<div class="promptLine_x_4"><span class="cwd_x_5">$</span><span class="command_x_6">npm test</span></div></div>'
    + '<span class="status_x_7">exit 1</span><button type="button">复制</button>'
    + '</div>'
    + '<div class="output_x_output_8">'
    + '<div class="line_x_line_9"><span>PASS a</span></div>'
    + '<div class="line_x_line_9"></div>'
    + '<div class="line_x_line_9"><span>FAIL b</span></div>'
    + '<button type="button" class="expand_x_10">展开</button>'
    + '</div></div></div></div></div>',
  )
  eq(
    '终端块还原成围栏：命令行 + 输出，输出里的空行保真',
    markdownOfSelection(dom, 't'),
    '```\n$ npm test\nPASS a\n\nFAIL b\n```',
  )
}
{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="3:assistant-step"><div id="t">'
    + '<p>结论<sup>1</sup> 与再引<sup>1</sup>，还有字面 x<sup>9</sup></p>'
    + '<section data-footnotes="" class="footnotes"><h2 id="footnote-label" class="sr-only">脚注</h2><ol>'
    + '<li id="user-content-fn-note"><p>定义文本 <a href="#">↩</a> <sup>2</sup></p></li>'
    + '</ol></section>'
    + '</div></div></div></div>',
  )
  eq(
    '脚注还原成 [^1] + 定义，sr-only 标题与 ↩ 回链被丢掉，字面 <sup>9</sup> 不受影响',
    markdownOfSelection(dom, 't'),
    '结论[^1] 与再引[^1]，还有字面 x<sup>9</sup>\n\n[^1]: 定义文本',
  )
}
{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="3:assistant-step"><section id="t" data-footnotes=""><ol>'
    + '<li><p>第一段 ↩<sup>2</sup></p><p>第二段</p></li>'
    + '<li><p>另一条 ↩</p></li>'
    + '</ol></section></div></div></div>',
  )
  eq(
    '多段脚注定义按四空格续行',
    markdownOfSelection(dom, 't'),
    '[^1]: 第一段\n\n    第二段\n\n[^2]: 另一条',
  )
}
{
  const dom = withDom('<div data-chat-flow-key="x"><div id="t"><p>字面 <sup>2</sup> 不是引用</p></div></div>')
  eq('没有脚注列表时 <sup> 保持行内 HTML', markdownOfSelection(dom, 't'), '字面 <sup>2</sup> 不是引用')
}
{
  // The list belongs to another message, so this one's `<sup>1</sup>` is literal
  // text: resolving it would emit a reference with nothing to bind to.
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="1:assistant-step"><div id="t">字面 <sup>1</sup> 上标</div></div>'
    + '<div data-chat-flow-key="2:assistant-step"><section data-footnotes=""><ol>'
    + '<li><p>别的消息的脚注 ↩</p></li></ol></section></div>'
    + '</div></div>',
  )
  eq('别的消息里的脚注列表不会把这条消息的 <sup> 变成引用', markdownOfSelection(dom, 't'), '字面 <sup>1</sup> 上标')
}

/* ------------------------------------------------------------------ *
 * 10. Whole messages, shaped like the installed shell renders them
 * ------------------------------------------------------------------ */

group('10. 组合场景：一条用户气泡 + 一条混合内容的助手消息')

{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="1:user" data-chat-turn="1"><div class="_userRow_1"><div class="_userStack_2">'
    + '<div id="t" class="_bubble_3">'
    + '帮我看看这段：\n- 第一项是不是列表\n*args 和 **kwargs 怎么解释\n价格 $5 到 $10\n    四个空格开头'
    + '</div></div></div></div></div></div>',
  )
  eq(
    '没有 data-chat-flow-kind 的行：仍按 Markdown 转义',
    markdownOfSelection(dom, 't'),
    '帮我看看这段：\n\\- 第一项是不是列表\n\\*args 和 \\*\\*kwargs 怎么解释\n价格 \\$5 到 \\$10\n&#32;   四个空格开头',
  )
}
{
  // DSH renders user / steering text literally (MessageText), so its source is the text itself.
  const typed = '**2.（中）代码块内"部分选择"给裸文本** —— 选中 `# 这是注释` 会变成标题。\n**3.（低）README 措辞**\n- 不是列表\n价格 $5'
  const dom = withDom(
    '<style>._text_4{white-space:pre-wrap}</style>'
    + '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="s1:user:1" data-chat-flow-kind="user"><div class="_userRow_1"><div class="_userStack_2">'
    + `<div id="u" class="_bubble_3"><div class="_text_4">${typed}</div></div></div>`
    + '<div class="_actions_5"><button aria-label="复制">复制</button><span>10:02</span></div></div></div>'
    + '<div data-chat-flow-key="s1:steering:2" data-chat-flow-kind="steering"><div id="s">*引导* 文本</div></div>'
    + '<div data-chat-flow-key="s1:assistant:3" data-chat-flow-kind="assistant-step"><div class="md-body"><p id="a"><strong>加粗</strong> 与 *字面*</p></div></div>'
    + '</div></div>',
  )
  eq('用户气泡：原样返回，不加反斜杠；换行写成两空格硬换行', markdownOfSelection(dom, 'u'), typed.split('\n').join('  \n'))
  eq('steering 气泡：同样原样返回', markdownOfSelection(dom, 's'), '*引导* 文本')
  {
    const doc = dom.window.document
    const range = doc.createRange()
    range.setStart(doc.getElementById('u').firstChild.firstChild, 0)
    range.setEndAfter(doc.querySelector('._actions_5'))
    check('选到气泡外的按钮：按钮文字不进入复制结果', !I.markdownFromRange(range).includes('复制'))
  }
  {
    const doc = dom.window.document
    const range = doc.createRange()
    range.setStart(doc.getElementById('s').firstChild, 0)
    range.setEnd(doc.getElementById('a').lastChild, doc.getElementById('a').lastChild.length)
    const md = I.markdownFromRange(range)
    check('跨到助手消息的选区：仍按 Markdown（加粗保留、字面星号转义）',
      md.includes('**加粗**') && md.includes('\\*字面\\*'), md)
  }
  eq('助手消息不受影响', markdownOfSelection(dom, 'a'), '**加粗** 与 \\*字面\\*')
}
{
  const dom = withDom(
    '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="2:assistant-step"><div id="t" class="md-body">'
    + '<p>先看结论<sup>1</sup>：用 <code>*args</code> 收集位置参数。</p>'
    + '<div class="md-code-block"><div data-code-block-banner="true"><div class="infostring">python</div></div>'
    + '<div data-code-block-content="true"><pre class="shiki"><code><span class="line">def f(*args): pass</span></code></pre></div></div>'
    + '<div data-terminal="" data-body=""><div class="header_x_header_1"><div class="prompt_x_prompt_2">'
    + '<div class="promptLine_x_3"><span class="cwd_x_4">$</span><span class="command_x_5">python a.py</span></div>'
    + '</div><button type="button">复制</button></div>'
    + '<div class="output_x_output_6"><div class="line_x_line_7"><span>ok</span></div></div></div>'
    + '<div data-diff="" class="md-code-block"><div data-code-block-banner="true">'
    + '<div class="heading"><span class="language">diff</span></div></div>'
    + '<div class="body"><div class="_line_1 _del_1">old</div><div class="_line_1 _add_1">new</div></div></div>'
    + '<p>参考<sup>1</sup>。</p>'
    + '<section data-footnotes=""><h2 class="sr-only">脚注</h2><ol><li><p>Python 文档 ↩</p></li></ol></section>'
    + '</div></div></div></div>',
  )
  eq(
    '整条助手消息：段落 + 代码围栏 + 终端围栏 + diff 围栏 + 脚注定义',
    markdownOfSelection(dom, 't'),
    [
      '先看结论[^1]：用 `*args` 收集位置参数。',
      '',
      '```python',
      'def f(*args): pass',
      '```',
      '',
      '```',
      '$ python a.py',
      'ok',
      '```',
      '',
      '```diff',
      '- old',
      '+ new',
      '```',
      '',
      '参考[^1]。',
      '',
      '[^1]: Python 文档',
    ].join('\n'),
  )
}

/* ------------------------------------------------------------------ *
 * 11. Part of a formula
 * ------------------------------------------------------------------ */

group('11. 局部公式：只复制选中的那一段源码')

/** Real KaTeX output for `\sum_{i=1}^{n} i^2`, styles stripped. */
const KATEX_SUM =
  '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML">'
  + '<semantics><mrow><msubsup><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></msubsup>'
  + '<msup><mi>i</mi><mn>2</mn></msup></mrow>'
  + '<annotation encoding="application/x-tex">\\sum_{i=1}^{n} i^2</annotation></semantics></math></span>'
  + '<span class="katex-html" aria-hidden="true"><span class="base"><span class="strut"></span>'
  + '<span class="mop"><span class="mop op-symbol small-op">∑</span><span class="msupsub">'
  + '<span class="vlist-t vlist-t2"><span class="vlist-r"><span class="vlist">'
  + '<span><span class="pstrut"></span><span class="sizing reset-size6 size3 mtight">'
  + '<span class="mord mtight"><span class="mord mathnormal mtight">i</span>'
  + '<span class="mrel mtight">=</span><span class="mord mtight">1</span></span></span></span>'
  + '<span><span class="pstrut"></span><span class="sizing reset-size6 size3 mtight">'
  + '<span class="mord mtight"><span class="mord mathnormal mtight">n</span></span></span></span>'
  + '</span><span class="vlist-s"></span></span><span class="vlist-r"><span class="vlist">'
  + '<span></span></span></span></span></span></span><span class="mspace"></span><span class="mord">'
  + '<span class="mord mathnormal">i</span><span class="msupsub"><span class="vlist-t">'
  + '<span class="vlist-r"><span class="vlist"><span><span class="pstrut"></span>'
  + '<span class="sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span>'
  + '</span></span></span></span></span></span></span></span></span>'

/** Real KaTeX output for `\frac{a}{b}` — note the layout prints `b` first. */
const KATEX_FRAC =
  '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML">'
  + '<semantics><mrow><mfrac><mi>a</mi><mi>b</mi></mfrac></mrow>'
  + '<annotation encoding="application/x-tex">\\frac{a}{b}</annotation></semantics></math></span>'
  + '<span class="katex-html" aria-hidden="true"><span class="base"><span class="strut"></span>'
  + '<span class="mord"><span class="mopen nulldelimiter"></span><span class="mfrac">'
  + '<span class="vlist-t vlist-t2"><span class="vlist-r"><span class="vlist">'
  + '<span><span class="pstrut"></span><span class="sizing reset-size6 size3 mtight">'
  + '<span class="mord mtight"><span class="mord mathnormal mtight">b</span></span></span></span>'
  + '<span><span class="pstrut"></span><span class="frac-line"></span></span>'
  + '<span><span class="pstrut"></span><span class="sizing reset-size6 size3 mtight">'
  + '<span class="mord mtight"><span class="mord mathnormal mtight">a</span></span></span></span>'
  + '</span><span class="vlist-s"></span></span><span class="vlist-r"><span class="vlist">'
  + '<span></span></span></span></span></span><span class="mclose nulldelimiter"></span>'
  + '</span></span></span></span>'

/** The visual glyph runs of one formula, in layout order. */
function formulaRuns(el) {
  const out = []
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue.replace(/[\u200b-\u200f\u2061-\u2064]/gu, '').trim() !== '') out.push(child)
        continue
      }
      if (child.nodeType !== 1) continue
      const tag = child.tagName.toLowerCase()
      if (tag === 'svg' || tag === 'annotation') continue
      walk(child)
    }
  }
  walk(el.querySelector('.katex-html'))
  return out
}

/** A range covering whole glyph runs `from`..`to` of one formula. */
function selectRuns(dom, formula, from, to) {
  const runs = formulaRuns(formula)
  const range = dom.window.document.createRange()
  range.setStart(runs[from], 0)
  range.setEnd(runs[to], runs[to].nodeValue.length)
  return range
}

{
  const dom = withDom(`<div data-chat-flow><p id="t">求和 ${KATEX_SUM} 与结论</p></div>`)
  const formula = dom.window.document.querySelector('.katex')
  eq('字形序列与安装版渲染一致（前置条件）', formulaRuns(formula).map((n) => n.nodeValue).join(''), '∑i=1ni2')
  eq('只选 ∑：给出它自己的源码', I.markdownFromRange(selectRuns(dom, formula, 0, 0)), '$\\sum$')
  eq('只选下标 i=1', I.markdownFromRange(selectRuns(dom, formula, 1, 3)), '$i=1$')
  eq('选 ∑ 与上下标：整条算符', I.markdownFromRange(selectRuns(dom, formula, 0, 4)), '$\\sum_{i=1}^{n}$')
  eq('只选 i^2', I.markdownFromRange(selectRuns(dom, formula, 5, 6)), '$i^{2}$')
  eq('只选指数 2', I.markdownFromRange(selectRuns(dom, formula, 6, 6)), '$2$')
  eq('整条公式仍用作者原文（空格与 \\sum 都在）', I.markdownFromRange(selectRuns(dom, formula, 0, 6)), '$\\sum_{i=1}^{n} i^2$')
}
{
  const dom = withDom(`<div data-chat-flow><p id="t">比值 ${KATEX_FRAC} 很小</p></div>`)
  const formula = dom.window.document.querySelector('.katex')
  // the layout prints the denominator first: run 0 is `b`, run 1 is `a`
  eq('分母先出现（前置条件）', formulaRuns(formula).map((n) => n.nodeValue).join(''), 'ba')
  eq('只选排版在上方的 a', I.markdownFromRange(selectRuns(dom, formula, 1, 1)), '$a$')
  eq('只选排版在下方的 b', I.markdownFromRange(selectRuns(dom, formula, 0, 0)), '$b$')
  eq('整条分式', I.markdownFromRange(selectRuns(dom, formula, 0, 1)), '$\\frac{a}{b}$')
}
{
  // The real gesture: drag over part of a formula, press Cmd/Ctrl+C.
  const dom = withDom('<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + '<div data-chat-flow-key="1:assistant-step"><p id="t">求和 ' + KATEX_SUM + '</p></div></div></div>')
  const provided = new Map()
  const instance = handoff.factory(() => { throw new Error('this bundle requires no modules') })
  instance.apply({
    effect: (run) => { const off = run(); return () => { if (typeof off === 'function') off() } },
    provide: (name, value) => { provided.set(name, value); return () => provided.delete(name) },
  })
  const formula = dom.window.document.querySelector('.katex')
  const selection = dom.window.getSelection()
  selection.removeAllRanges()
  selection.addRange(selectRuns(dom, formula, 0, 4))
  const written = {}
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true })
  event.clipboardData = { setData: (type, value) => { written[type] = value } }
  dom.window.document.dispatchEvent(event)
  eq('只框住 ∑ 与上下标时，Cmd+C 写入的正是这一段', written['text/plain'], '$\\sum_{i=1}^{n}$')
}

{
  // A selection that reaches outside the formula is not "part of one formula":
  // the whole formula is widened in, exactly as before.
  const dom = withDom(`<div data-chat-flow><p id="t">求和 ${KATEX_FRAC} 与结论</p></div>`)
  const p = dom.window.document.getElementById('t')
  const formula = dom.window.document.querySelector('.katex')
  const runs = formulaRuns(formula)
  const range = dom.window.document.createRange()
  range.setStart(p.firstChild, 0)
  range.setEnd(runs[0], runs[0].nodeValue.length)
  eq('从正文拖进公式：整条公式（局部提取不接管）', I.markdownFromRange(range), '求和 $\\frac{a}{b}$')
}

/* ------------------------------------------------------------------ *
 * 12. Fragment equivalence, checked against KaTeX itself
 * ------------------------------------------------------------------ */

group('12. 片段等价性：把复制出来的片段重新渲染，和它来源的 MathML 子树比对')

/**
 * KaTeX is what the shell renders formulas with, so when a copy of it is
 * available the fragments can be checked the strict way: render the fragment
 * again and compare the MathML it produces with the subtree it was cut from.
 * The harness runs without it too (the check is skipped, loudly).
 *
 * The macro sweep reads `src/symbols.ts` and `src/macros.ts` out of the KaTeX
 * package itself, so the package root is resolved rather than its entry point
 * (which lives in `dist/`).
 */
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

function loadKatex() {
  const anchors = [
    join(pluginDir, 'package.json'),
    fileURLToPath(import.meta.url),
  ]
  for (const anchor of anchors) {
    try {
      const required = createRequire(anchor)
      const mod = required('katex')
      if (mod !== undefined && typeof mod.renderToString === 'function') {
        KATEX_ROOT = packageRootOf(required)
        return mod
      }
    } catch {
      // try the next anchor
    }
    // …and the package store next to it (katex is a transitive dependency there).
    try {
      const store = join(dirname(anchor), 'node_modules', '.pnpm')
      for (const entry of readdirSync(store)) {
        if (!entry.startsWith('katex@')) continue
        const folder = join(store, entry, 'node_modules', 'katex')
        try {
          const mod = createRequire(join(folder, 'package.json'))(folder)
          if (mod !== undefined && typeof mod.renderToString === 'function') {
            KATEX_ROOT = folder
            return mod
          }
        } catch {
          // not a usable copy
        }
      }
    } catch {
      // no store here
    }
  }
  return null
}

let KATEX_ROOT = null
const KATEX = loadKatex()

/**
 * Render with KaTeX, quietly: the sweep walks every macro KaTeX defines, and
 * some of them warn (`strict` mode) or print (`\show`) while rendering. Their
 * output is noise here, not a result.
 */
function renderQuietly(tex, display) {
  const log = console.log
  const warn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    return KATEX.renderToString(tex, { displayMode: display === true, throwOnError: true })
  } finally {
    console.log = log
    console.warn = warn
  }
}

if (KATEX === null) {
  console.log('  ! 跳过：本机找不到 katex，片段等价性校验未运行')
} else {
  const INVISIBLE_RUN = /[\u200b-\u200f\u2061-\u2064\ufe00-\ufe0f\u0300-\u036f\u20d0-\u20ff]/gu
  const TRANSPARENT_TAGS = new Set(['math', 'semantics', 'mstyle', 'mpadded', 'mphantom', 'mrow',
    'mtd', 'mtr', 'mlabeledtr', 'menclose'])
  const kidsOf = (node) => [...node.childNodes].filter((c) => c.nodeType === 1 && c.tagName.toLowerCase() !== 'annotation')
  /** Shape of one MathML node: tags and leaf text, grouping wrappers dropped. */
  function shapeOf(node) {
    const out = []
    const emit = (el) => {
      const tag = el.tagName.toLowerCase()
      // Spacing and invisible scaffolding do not change the math.
      if (tag === 'mspace' || tag === 'mpadded') return
      if ((tag === 'mo' || tag === 'mtext' || tag === 'mi' || tag === 'mn')
        && el.textContent.replace(INVISIBLE_RUN, '').trim() === '') return
      if (TRANSPARENT_TAGS.has(tag)) {
        for (const kid of kidsOf(el)) emit(kid)
        return
      }
      const variant = typeof el.getAttribute === 'function' ? el.getAttribute('mathvariant') : null
      out.push(`<${tag}${variant === null ? '' : `:${variant}`}`)
      const kids = kidsOf(el)
      if (kids.length === 0) out.push(JSON.stringify(el.textContent.trim()))
      else for (const kid of kids) emit(kid)
      out.push('>')
    }
    emit(node)
    return out.join(' ')
  }
  /** Two shapes that render the same glyphs, modulo TeX's own notations. */
  function normalize(text) {
    return text
      .replace(/<mn "([0-9]+)" > <mn "([0-9]+)" >/gu, '<mn "$1$2" >')
      .replace(/<mover <mo "([^"]{1,2})" > >/gu, '<accent "$1" >')
      .replace(/<mo "([\^~¯ˉ˙¨])" >/gu, '<accent "$1" >')
      .replace(/<(?:mo|mtext) "([^"]{1,2})" >/gu, '<glyph "$1" >')
      .replace(/\s+/gu, ' ')
      .trim()
  }
  const corpus = [
    'E = mc^2', 'x_i', '\\sum_{i=1}^{n} i^2', '\\frac{a}{b}+\\sqrt{x}',
    '\\int_0^1 f(x)\\,dx', '\\lim_{n\\to\\infty} a_n', '\\sqrt[3]{x+1}',
    '\\hat{x}+\\bar{y}', '\\left(\\frac{1}{2}\\right)^n', '\\sum_{k=0}^{\\infty}\\frac{x^k}{k!}',
  ]
  let checked = 0
  let mismatches = 0
  for (const tex of corpus) {
    for (const display of [false, true]) {
      const dom = withDom('<div data-conversation-session="s1"><div data-conversation-scroll="">'
        + '<div data-chat-flow-key="1:assistant-step"><div id="t"></div></div></div></div>')
      const host = dom.window.document.getElementById('t')
      host.innerHTML = renderQuietly(tex, display)
      const formula = host.querySelector('.katex')
      const plan = I.formulaPlanOf(formula)
      if (plan === null) {
        mismatches += 1
        console.error(`  ! 规划失败: ${tex}`)
        continue
      }
      for (let first = 0; first < plan.leaves.length; first += 1) {
        for (let last = first; last < plan.leaves.length; last += 1) {
          const start = plan.leaves.slice(0, first).reduce((total, leaf) => total + leaf.text.length, 0)
          const end = plan.leaves.slice(0, last + 1).reduce((total, leaf) => total + leaf.text.length, 0)
          const range = alignedRange(dom, plan.runs, start, end)
          if (range === null) continue
          const markdown = I.markdownFromRange(range)
          if (markdown === `$${tex}$` || markdown === `$$\n${tex}\n$$`) continue
          const fragment = markdown.replace(/^\$\$?\n?/u, '').replace(/\n?\$\$?$/u, '')
          let rerendered
          try {
            rerendered = renderQuietly(fragment, display)
          } catch (error) {
            mismatches += 1
            console.error(`  ! 片段不可渲染: ${tex} → ${fragment} (${error.message})`)
            continue
          }
          const template = dom.window.document.createElement('template')
          template.innerHTML = rerendered
          const root = template.content.firstElementChild.querySelector('.katex-mathml math')
          const semantics = kidsOf(root).find((el) => el.tagName.toLowerCase() === 'semantics') ?? kidsOf(root)[0]
          const expected = I.coveringNodes(plan.leaves, first, last, I.topMathNode(formula.querySelector('.katex-mathml')))
            .map(shapeOf).join(' ')
          const actual = kidsOf(semantics).filter((el) => el.tagName.toLowerCase() !== 'annotation').map(shapeOf).join(' ')
          checked += 1
          if (normalize(actual) !== normalize(expected)) {
            mismatches += 1
            console.error(`  ! 片段与来源不等价: ${tex}\n      选中 → ${fragment}\n      期望 ${normalize(expected)}\n      实得 ${normalize(actual)}`)
          }
        }
      }
    }
  }
  /* ---- the two cases a user reported, kept as named assertions ---- */
  for (const [tex, expected] of [
    // `⟹` has to come back as its macro, not as the bare glyph: the character
    // table is derived from KaTeX's own macro list for exactly this.
    ['A \\Longrightarrow B', ['A', '\\Longrightarrow', 'B']],
    // The font lives in `mathvariant`, so `\mathbb{R}` must not come back as `R`.
    ['\\mathbb{R}^n', ['\\mathbb{R}', 'n']],
    ['\\mathbf{p}+\\mathbf{q}', ['\\mathbf{p}', '+', '\\mathbf{q}']],
    ['\\boldsymbol{v}\\cdot\\boldsymbol{w}', ['\\boldsymbol{v}', '\\cdot', '\\boldsymbol{w}']],
  ]) {
    const dom = withDom('<div data-conversation-session="s1"><div data-conversation-scroll="">'
      + '<div data-chat-flow-key="1:assistant-step"><div id="t"></div></div></div></div>')
    const host = dom.window.document.getElementById('t')
    host.innerHTML = renderQuietly(tex, false)
    const formula = host.querySelector('.katex')
    const plan = I.formulaPlanOf(formula)
    if (plan === null) {
      check(`反馈用例：${tex}`, false, '规划失败')
      continue
    }
    const actual = plan.leaves.map((leaf, index) => {
      const start = plan.leaves.slice(0, index).reduce((total, item) => total + item.text.length, 0)
      const end = start + leaf.text.length
      const range = alignedRange(dom, plan.runs, start, end)
      return range === null ? '?' : I.markdownFromRange(range).replace(/^\$|\$$/gu, '')
    })
    eq(`反馈用例：${tex}`, actual.join(' | '), expected.join(' | '))
  }

  /* ---- sweep: one formula per macro KaTeX defines, plus styled variants ----
   *
   * The point of the sweep is coverage: a hand-written corpus only finds what
   * somebody already thought of, which is exactly how `\Longrightarrow` came
   * back as a bare `⟹`. Two invariants are checked for every fragment:
   *   1. re-rendering it must produce the same MathML as the subtree it came
   *      from — presentation attributes (`mathvariant`, i.e. the font) included;
   *   2. it must not contain a character that has a macro of its own, which is
   *      the "bare glyph instead of `\Longrightarrow`" class of bug.
   */
  const SWEEP_LIMIT = Number(process.env.DSH_COPY_SWEEP ?? 0) || 900
  const macroNames = (() => {
    const names = new Map()
    const add = (escaped, primitive) => {
      const name = escaped.replace(/\\\\/gu, '\\')
      if (!/^\\[A-Za-z]+$/u.test(name)) return
      const previous = names.get(name)
      if (previous === undefined || (primitive && !previous.primitive)) names.set(name, { primitive })
    }
    const symbols = readFileSync(join(KATEX_ROOT, 'src', 'symbols.ts'), 'utf8')
    for (const match of symbols.matchAll(/defineSymbol\([^;]*?"(\\\\[A-Za-z]+)"/gu)) add(match[1], true)
    const macros = readFileSync(join(KATEX_ROOT, 'src', 'macros.ts'), 'utf8')
    for (const match of macros.matchAll(/defineMacro\("(\\\\[A-Za-z]+)"/gu)) add(match[1], false)
    return [...names.keys()].sort()
  })()
  // A macro on its own is one leaf, and a one-leaf formula has no partial
  // selection to test: it is followed by a digit so the macro's leaf is partial.
  const sweepCorpus = macroNames.slice(0, SWEEP_LIMIT).map((name) => `${name}0`)
  sweepCorpus.push(
    '\\mathbf{p}+\\mathbf{q}', '\\mathbb{R}^n', '\\boldsymbol{v}\\cdot\\boldsymbol{w}',
    '\\mathcal{L}(f)', '\\mathfrak{g}', '\\mathsf{A}\\mathtt{x}', '\\mathrm{d}y',
    '\\mathsfit{k}', '\\vec{p}+\\hat{q}', '\\bar{x}\\tilde{y}\\dot{z}\\ddot{u}',
    '\\frac{\\partial f}{\\partial x}', '\\sqrt[3]{x+1}',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'x \\Longrightarrow y',
  )
  let swept = 0
  const fallbacks = []
  for (const tex of sweepCorpus) {
    const dom = withDom('<div data-conversation-session="s1"><div data-conversation-scroll="">'
      + '<div data-chat-flow-key="1:assistant-step"><div id="t"></div></div></div></div>')
    const host = dom.window.document.getElementById('t')
    try {
      host.innerHTML = renderQuietly(tex, false)
    } catch {
      continue
    }
    const formula = host.querySelector('.katex')
    if (formula === null) continue
    const plan = I.formulaPlanOf(formula)
    if (plan === null) {
      // Not a defect: the reconstruction gives up and the copy falls back to the
      // whole formula, whose source is exact. Counted so a regression shows up.
      fallbacks.push(tex)
      continue
    }
    const cases = []
    for (let index = 0; index < plan.leaves.length; index += 1) cases.push([index, index])
    if (plan.leaves.length > 1) cases.push([0, plan.leaves.length - 1])
    for (const [first, last] of cases) {
      const start = plan.leaves.slice(0, first).reduce((total, leaf) => total + leaf.text.length, 0)
      const end = plan.leaves.slice(0, last + 1).reduce((total, leaf) => total + leaf.text.length, 0)
      const range = alignedRange(dom, plan.runs, start, end)
      if (range === null) continue
      const markdown = I.markdownFromRange(range)
      if (markdown === `$${tex}$` || markdown === `$$\n${tex}\n$$`) continue
      const fragment = markdown.replace(/^\$\$?\n?/u, '').replace(/\n?\$\$?$/u, '')
      swept += 1
      // TeX's own syntax characters are in the table as escapes, and every
      // fragment is full of backslashes: only real glyphs count here.
      const SYNTAX_CHARS = new Set(['\\', '{', '}', '#', '$', '%', '&', '_'])
      const bare = [...fragment].find((char) => I.TEX_OF_CHAR.has(char) && !SYNTAX_CHARS.has(char))
      if (bare !== undefined) {
        mismatches += 1
        console.error(`  ! 片段里有本可用宏表示的字符 ${JSON.stringify(bare)}: ${tex} → ${fragment}`)
        continue
      }
      let rerendered
      try {
        rerendered = renderQuietly(fragment, false)
      } catch (error) {
        mismatches += 1
        console.error(`  ! 片段不可渲染: ${tex} → ${fragment} (${error.message})`)
        continue
      }
      const template = dom.window.document.createElement('template')
      template.innerHTML = rerendered
      const root = template.content.firstElementChild.querySelector('.katex-mathml math')
      const semantics = kidsOf(root).find((el) => el.tagName.toLowerCase() === 'semantics') ?? kidsOf(root)[0]
      const expected = I.coveringNodes(plan.leaves, first, last, I.topMathNode(formula.querySelector('.katex-mathml')))
        .map(shapeOf).join(' ')
      const actual = kidsOf(semantics).filter((el) => el.tagName.toLowerCase() !== 'annotation').map(shapeOf).join(' ')
      checked += 1
      if (normalize(actual) !== normalize(expected)) {
        mismatches += 1
        console.error(`  ! 片段与来源不等价: ${tex}\n      选中 → ${fragment}\n      期望 ${normalize(expected)}\n      实得 ${normalize(actual)}`)
      }
    }
  }
  check(`宏清单扫描（${macroNames.length} 个宏，检查 ${swept} 个片段，${fallbacks.length} 个回退成整条公式）`,
    mismatches === 0 && fallbacks.length <= 90)
  if (fallbacks.length > 0) {
    console.log(`  · 回退（渲染字形与 MathML 文本不一致，如 \\neq 的 "=" + "/"）：${fallbacks.slice(0, 12).join(' ')}${fallbacks.length > 12 ? ' …' : ''}`)
  }
  check(`重渲染等价（${checked} 个片段，含错 ${mismatches} 个）`, mismatches === 0 && checked > 200)
}

/** A range over the aligned character range `[from, to)` of one formula. */
function alignedRange(dom, runs, from, to) {
  let cursor = 0
  let startNode = null
  let startOffset = 0
  let endNode = null
  let endOffset = 0
  for (const run of runs) {
    const length = run.text.length
    if (startNode === null && cursor + length > from) {
      startNode = run.node
      startOffset = rawOffset(run, from - cursor)
    }
    if (cursor + length >= to) {
      endNode = run.node
      endOffset = rawOffset(run, to - cursor)
      break
    }
    cursor += length
  }
  if (startNode === null || endNode === null) return null
  const range = dom.window.document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

/** An aligned offset inside one run → the raw offset in its text node. */
function rawOffset(run, aligned) {
  if (run.map === null) return Math.max(0, Math.min(aligned, run.text.length))
  let count = 0
  for (let index = 0; index < run.map.length; index += 1) {
    if (count === aligned) return index
    if (run.map[index] === 1) count += 1
  }
  return run.node.nodeValue.length
}

/* ------------------------------------------------------------------ *
 * 13. Acceptance regressions (each case was a confirmed round-trip bug)
 * ------------------------------------------------------------------ */

group('13. 验收回归')

{
  const H = (html) => I.markdownFromHtml(html)
  eq('em 包 strong → ***x***', H('<p><em><strong>x</strong></em></p>'), '***x***')
  eq('行内代码含 ``` 用更长围栏', H('<p><code>a```b</code></p>'), '````a```b````')
  eq('行首代码 ``` 加空格补齐', H('<p><code>```</code> fence</p>'), '```` ``` ```` fence')
  eq('DSH 的 <br>+换行 只产生一个硬换行', H('<p>a<br>\nb</p>'), 'a\\\nb')
  eq('<br> 后的 = 不变成 setext 标题', H('<p>title<br>\n=</p>'), 'title\\\n\\=')
  eq('段尾 <br> 被丢弃', H('<p>a<br></p>'), 'a')
  eq('段尾字面反斜杠被转义', H('<p>a\\</p>'), 'a\\\\')
  eq('形似链接定义的段落转义冒号', H('<p>[1]: x</p>'), '[1]\\: x')
  eq('代码块里缩进的 ``` 也计入围栏长度', H('<pre><code>x\n   ```\ny</code></pre>'), '````\nx\n   ```\ny\n````')
  eq('嵌套列表保持紧凑', H('<ul><li>a<ul><li>b</li></ul></li></ul>'), '- a\n  - b')
  eq('嵌套任务列表各自取自己的勾选框',
    H('<ul><li><input type="checkbox" checked> a<ul><li><input type="checkbox"> b</li></ul></li></ul>'),
    '- [x] a\n  - [ ] b')
  eq('单波浪线转义（GFM 单 ~ 删除线）', H('<p>~a~</p>'), '\\~a\\~')
  eq('美元符号全部转义（单 $ 数学）', H('<p>$5 and $10</p>'), '\\$5 and \\$10')
  eq('标题末尾 # 被转义', H('<h2>C# rocks #</h2>'), '## C# rocks \\#')
  eq('标题内 <br> 变空格', H('<h2>a<br>b</h2>'), '## a b')
  eq('链接地址里的反斜杠加倍', H('<p><a href="http://x/a\\_b">l</a></p>'), '[l](http://x/a\\\\_b)')
  eq('表格单元格内 <br> 变空格', H('<table><tr><th>a</th></tr><tr><td>x<br>y</td></tr></table>'), '| a |\n| --- |\n| x y |')
  eq('只转义像标签的 <', H('<p>a &lt;b&gt; 1 &lt; 2</p>'), 'a \\<b> 1 < 2')

  // Former quadratic paths: many unmatched `<`, many footnote refs.
  let t0 = Date.now()
  const angles = H(`<p>${'&lt;a '.repeat(20000)}</p>`)
  check('2 万个未闭合 < 在 1 秒内完成', Date.now() - t0 < 1000 && angles.length > 0)
  t0 = Date.now()
  const sups = Array.from({ length: 2000 }, (_, i) => `<sup><a href="#fn-${i}">${i}</a></sup>`).join(' ')
  H(`<p>${sups}</p>`)
  check('2000 个脚注引用在 2 秒内完成', Date.now() - t0 < 2000)
}

{
  // Partial selections inside code are raw text; a whole inline code is a span.
  const dom = withDom('<pre id="pre"><code id="c">const a = 1\nconst b = 2</code></pre><p>x <code id="ic">foo`bar</code> y</p>')
  const doc = dom.window.document
  const text = doc.getElementById('c').firstChild
  const part = doc.createRange()
  part.setStart(text, 6)
  part.setEnd(text, 11)
  eq('代码块内部分选择得到原文', I.markdownFromRange(part), 'a = 1')
  const whole = doc.createRange()
  whole.selectNodeContents(doc.getElementById('ic'))
  eq('整段行内代码得到代码 span', I.markdownFromRange(whole), '``foo`bar``')
  const inlinePart = doc.createRange()
  inlinePart.setStart(doc.getElementById('ic').firstChild, 0)
  inlinePart.setEnd(doc.getElementById('ic').firstChild, 3)
  eq('行内代码部分选择得到原文', I.markdownFromRange(inlinePart), 'foo')
}

{
  // An editable field inside a transcript row owns its own copy.
  const dom = withDom(TRANSCRIPT('<p id="t">正文</p><div contenteditable="true"><span id="ed">可编辑的字</span></div>'))
  // Browsers put execCommand on Document.prototype; give jsdom the same shape
  // so the plugin's wrapper path actually runs.
  if (typeof dom.window.document.execCommand !== 'function') {
    dom.window.Document.prototype.execCommand = () => true
  }
  check('前置：execCommand 位于原型上', !Object.prototype.hasOwnProperty.call(dom.window.document, 'execCommand'))
  const disposers = []
  plugin.apply({
    effect: (run) => { const off = run(); if (typeof off === 'function') disposers.push(off); return () => {} },
    provide: () => () => {},
  })
  const selection = dom.window.getSelection()
  selection.removeAllRanges()
  selection.addRange(rangeOver(dom, 'ed'))
  const written = {}
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true })
  event.clipboardData = { setData: (type, value) => { written[type] = value } }
  dom.window.document.getElementById('ed').dispatchEvent(event)
  eq('行内可编辑区的复制不被接管', written['text/plain'], undefined)
  eq('行内可编辑区的复制不 preventDefault', event.defaultPrevented, false)

  const doc = dom.window.document
  check('安装后 execCommand 被包装为自有属性', Object.prototype.hasOwnProperty.call(doc, 'execCommand'))
  disposers.forEach((off) => off())
  check('卸载后删除自有 execCommand，恢复原型方法', !Object.prototype.hasOwnProperty.call(doc, 'execCommand'))

  // Someone wrapped it after us: dispose must leave their wrapper in place.
  const disposers2 = []
  plugin.apply({
    effect: (run) => { const off = run(); if (typeof off === 'function') disposers2.push(off); return () => {} },
    provide: () => () => {},
  })
  const foreign = () => false
  doc.execCommand = foreign
  disposers2.forEach((off) => off())
  check('卸载不覆盖别人后装的 execCommand', doc.execCommand === foreign)
}

// Round 2: a literal newline is a real line break only inside pre-wrap.
{
  const H = (html) => I.markdownFromHtml(html)
  const PW = (text) => `<div style="white-space:pre-wrap">${text}</div>`
  eq('pre-wrap 多行 → 硬换行', H(PW('第一行\n第二行')), '第一行\\\n第二行')
  eq('普通流里的 \\n 保持软换行', H('<p>第一行\n第二行</p>'), '第一行\n第二行')
  eq('引用的结构性换行不产生硬换行', H('<blockquote>\n<p>a</p>\n</blockquote>'), '> a')
  eq('引用内 <br> 不受影响', H('<blockquote><p>a<br>b</p></blockquote>'), '> a\\\n> b')
  eq('pre-wrap 续行的行首块语法被转义', H(PW('正文\n> 不是引用')), '正文\\\n\\> 不是引用')
  eq('pre-wrap 续行的行首空格写成实体', H(PW('正文\n > 缩进')), '正文\\\n&#32;\\> 缩进')
  eq('pre-wrap 空行保留为连续硬换行', H(PW('甲\n\n乙')), '甲\\\n\\\n乙')
  eq('pre-wrap 里的代码块不走硬换行', H(PW('<pre><code>a\nb</code></pre>')), '```\na\nb\n```')

  // The real copy path: class-based CSS on the LIVE tree, serialized from a clone.
  const dom = withDom('<style>.bubble{white-space:pre-wrap}</style><div class="bubble" id="u">正文\n# 不是标题\n第三行</div><p id="n">软\n换行</p>')
  eq('实时选区：class 设定的 pre-wrap 也生效', markdownOfSelection(dom, 'u'), '正文\\\n\\# 不是标题\\\n第三行')
  eq('实时选区：普通段落仍是软换行', markdownOfSelection(dom, 'n'), '软\n换行')
}

// Round 3: user rows keep line structure (2.1) and block boundaries (2.2), unescaped.
{
  const USER = (inner) => withDom(
    '<style>.t{white-space:pre-wrap}.chip{display:inline-block}</style>'
    + '<div data-conversation-session="s1"><div data-conversation-scroll="">'
    + `<div data-chat-flow-key="s1:user:1" data-chat-flow-kind="user"><div class="bubble" id="u">${inner}</div></div>`
    + '</div></div>',
  )
  eq('用户行：多行 → 两空格硬换行，不转义', markdownOfSelection(USER('<div class="t">甲\n*乙*</div>'), 'u'), '甲  \n*乙*')
  eq('用户行：空行保留为段落分隔', markdownOfSelection(USER('<div class="t">甲\n\n乙</div>'), 'u'), '甲\n\n乙')
  eq('用户行：@ 芯片前后的 MessageText 仍是同一行',
    markdownOfSelection(USER('<div class="t">看 </div><span class="chip" data-ref-chip="subagent">@file</span><div class="t"> 这个</div>'), 'u'),
    '看 @file 这个')
  eq('用户行：文本与附件卡之间有块分隔',
    markdownOfSelection(USER('<div class="t">价格 $10</div><div class="card"><span>报告.pdf</span><div>12 KB</div></div>'), 'u'),
    '价格 $10\n\n报告.pdf\n\n12 KB')
  eq('用户行：JSON 块（pre）原样保留换行',
    markdownOfSelection(USER('<div class="t">看这个</div><pre>{\n  "a": 1\n}</pre>'), 'u'),
    '看这个\n\n{\n  "a": 1\n}')
  {
    const dom = USER('<div class="t">第一行\n第二行\n第三行</div>')
    const text = dom.window.document.querySelector('.t').firstChild
    const range = dom.window.document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 6)
    eq('用户行：文本节点中间起止的局部选区', I.markdownFromRange(range), '行  \n第二')
  }

  // The linear Range helpers agree with the native ones on boundary edge cases.
  const dom = withDom('<div id="r"><p id="p1">ab<b>cd</b>ef</p><p id="p2">gh<i>ij</i></p><p id="p3"></p>kl</div>')
  const doc = dom.window.document
  const p1 = doc.getElementById('p1')
  const p2 = doc.getElementById('p2')
  const cases = [
    ['文本中间到文本中间', (r) => { r.setStart(p1.firstChild, 1); r.setEnd(p2.lastChild.firstChild, 1) }],
    ['起点在文本末尾', (r) => { r.setStart(p1.firstChild, 2); r.setEnd(p1.lastChild, 1) }],
    ['终点在文本偏移 0', (r) => { r.setStart(p1.firstChild, 0); r.setEnd(p2.firstChild, 0) }],
    ['元素边界：容器末尾起', (r) => { r.setStart(p1, p1.childNodes.length); r.setEnd(p2, 1) }],
    ['元素边界：容器开头止', (r) => { r.setStart(p1, 1); r.setEnd(p2, 0) }],
    ['跨空段落', (r) => { r.setStart(p2, 0); r.setEnd(doc.getElementById('r').lastChild, 1) }],
    ['整段内容', (r) => { r.selectNodeContents(doc.getElementById('r')) }],
    ['同一文本节点', (r) => { r.setStart(p1.firstChild, 0); r.setEnd(p1.firstChild, 1) }],
  ]
  const html = (fragment) => {
    const box = doc.createElement('div')
    box.appendChild(fragment)
    return box.innerHTML
  }
  for (const [name, set] of cases) {
    const range = doc.createRange()
    set(range)
    eq(`线性 toString 等价：${name}`, I.rangeText(range), range.toString())
    eq(`线性 cloneContents 等价：${name}`, html(I.cloneRangeContents(range)), html(range.cloneContents()))
  }
}

// Round 3 (2.3): the LIVE copy path scales linearly (attached HTML, selectNodeContents).
{
  const lines = (n) => Array.from({ length: n }, (_, i) => `第 ${i} 行 <b>粗</b> 与 <code>code</code>`).join('\n')
  const time = (n) => {
    const dom = withDom('<style>.bubble{white-space:pre-wrap}</style>'
      + '<div data-conversation-session="s1"><div data-conversation-scroll="">'
      + `<div data-chat-flow-key="2:a"><div class="bubble" id="pick">${lines(n)}</div></div></div></div>`)
    const started = performance.now()
    const md = markdownOfSelection(dom, 'pick')
    return { ms: performance.now() - started, md }
  }
  time(200) // warm-up
  // jsdom timings are noisy (GC lands in the middle of a run), so each size is
  // measured twice and the faster run is used; a quadratic serializer would
  // still show up as roughly 16× instead of the ~4× a linear one needs.
  const fastest = (n) => Math.min(time(n).ms, time(n).ms)
  const smallMs = fastest(2000)
  const largeRun = time(8000)
  const largeMs = Math.min(largeRun.ms, time(8000).ms)
  const ratio = largeMs / smallMs
  check(`实时大选区线性：2000 行 ${smallMs.toFixed(0)} ms → 8000 行 ${largeMs.toFixed(0)} ms（倍数 ${ratio.toFixed(1)}×；线性约 4×，上限 12×，二次方约 16×）`,
    largeMs <= Math.max(smallMs, 20) * 12 && largeRun.md.split('\\\n').length === 8000)
  const four = time(4000)
  check(`实时 4000 行（16k 文本节点）：${four.ms.toFixed(0)} ms，< 2000 ms（jsdom；Chromium 目标 < 200 ms）`, four.ms < 2000)
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${pass} 项通过, ${fail} 项失败`)
if (fail > 0) {
  console.error(`失败项: ${failures.join('; ')}`)
  process.exitCode = 1
}
