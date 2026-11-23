# 复制增强（@local/dsh-copy-markdown）

[English](README.en.md) | 中文

在 DeepSeek Harness 的对话记录里**选中一段内容，按 Cmd/Ctrl+C** —— 剪贴板里拿到的不是屏幕上
渲染后的样子，而是它的 **Markdown 源码**：公式回到 `$E=mc^2$`，代码块回到围栏，表格回到 GFM
表格，diff 卡回到 ```` ```diff ````，终端块回到围栏，脚注回到 `[^1]` 加定义。

而且**粘回去还是同一份内容**：正文里字面出现的 `*args`、行首的 `- `、成对的 `$…$` 会被转义，
不会被重新解析成强调、列表或数学。

<p><img src="icon.svg" width="72" height="72" alt="复制增强图标：两张叠起来的纸片，前面一张上是一个 M"></p>

## 安装

**要求**：DeepSeek Harness `0.2.2-rc.3` 或更新（插件清单里用 `engines.dsh` 声明了这个范围，
更老的版本会在安装时被拒绝）。纯 JavaScript，没有构建步骤 —— 从 git 安装不需要额外的
`allowBuilds` 许可。

从 GitHub 安装（`v1.0.0` 是标签，也可以省略跟 `main`）：

```sh
dsh plugin --profile <profile> add github:Rayzenchen/dsh-copy-markdown#v1.0.0
```

从本地目录安装：

```sh
dsh plugin --profile <profile> add /path/to/dsh-copy-markdown
```

在 Desktop 应用里，也可以让 agent 用 `plugin_manager` 的 `install_bundle` 装同一个 spec。
装完**刷新页面**即可（功能全在浏览器侧）；卸载用
`dsh plugin --profile <profile> remove @local/dsh-copy-markdown`。

## 用法

只有一条规则：**在对话正文里选中，按 Cmd/Ctrl+C**。

- 复制的是**源码**，不是渲染文本 —— 粘到编辑器、Issue、笔记里都能直接用；
- 输入框、侧栏、设置页不接管，那些地方的复制还是浏览器默认行为；
- DSH 自己的复制按钮（代码块、diff、终端上的）不会被抢；
- 任何一步判断失败都会放行走浏览器默认复制，不会让"复制"整体失效。

## 复制出来长什么样

| 你选中的渲染形态 | 剪贴板里的内容 |
|---|---|
| 公式（整条） | 作者原文，`$…$` / `$$…$$` |
| 公式（只选一部分） | 那一段的结构等价源码，比如 `$\sum_{i=1}^{n}$` |
| 代码块 | 围栏 + 语言（语言取自 DSH 自己的横幅） |
| 表格 | GFM 表格，对齐写回 `:---:` / `---:` / `:---` |
| diff 卡 | ```` ```diff ```` 围栏，行首 `- `/`+ `/`  ` |
| 终端块 | 围栏，命令行与输出行都在，空行保真 |
| 脚注 | `[^1]` 引用 + `[^1]: …` 定义（定义也在选区里时） |
| 标题 / 列表 / 引用 / 加粗 / 行内代码 | 对应的 Markdown 标记 |
| 按钮、图标、展开/复制等界面零件 | 跳过，不进剪贴板 |

## 其它插件也可以用它

插件在浏览器侧提供一个 `markdownSource` 服务，这样别的插件不必重新实现一遍同样的投影：

```js
const source = ctx.get('markdownSource')
source.fromRange(range)           // 一个 DOM Range → Markdown（'' 表示没有内容）
source.fromNodes(nodeList)        // 节点列表 → Markdown
source.fromHtml(htmlString)       // HTML 字符串 → Markdown
source.fromSelection()            // 当前浏览器选区 → Markdown
source.isTranscriptRange(range)   // 该选区是否落在对话正文里
```

取不到服务时自己回退即可，不影响主功能。

## 怎么做到的

序列化器遍历的是**克隆出来的 DOM**：一次选区是任意的 DOM 区间，只有渲染树还知道它的边界。
能做到精确还原，靠的是渲染树里这些结构事实（已在 `0.2.2-rc.5` 的安装包里逐项核对）：

| 渲染形态 | DOM 特征 | 还原方式 |
|---|---|---|
| 数学公式 | KaTeX 输出：MathML 臂里带 `<annotation encoding="application/x-tex">`，视觉臂 `.katex-html` 是 `aria-hidden` | 读 annotation 拿回 TeX；`aria-hidden` 臂被跳过，不会重复计入 |
| 代码块 | 高亮只是嵌套 `<span>`；语言在 `[data-code-block-banner]` 的横幅里 | `textContent` 就是源码 + 语言 ⇒ 围栏；横幅整块跳过 |
| diff 卡 | 卡根 `[data-diff]`，行带 `data-diff-line`（旧版只有类名） | 按行类型拼回 `- `/`+ `/`  `，整体写成 ```` ```diff ```` |
| 终端块 | 根 `[data-terminal]`：命令头 + 每个输出行是独立 `div` | 命令 + 输出写进一个围栏，空行保真 |
| 脚注 | 引用是裸的 `<sup>1</sup>`，定义在 `section[data-footnotes] > ol > li` | 引用 → `[^1]`，定义 → `[^1]: …`，`↩` 回链与 `sr-only` 文本丢弃 |
| 其余 Markdown | 标题/列表/表格/引用/行内样式都是语义标签 | 按标签还原；按钮/图标/svg/`aria-hidden` 一律跳过 |

几个刻意的细节：

- **`<pre>` 里的语言**取自 DSH 自己的横幅，取不到才退回 `language-xxx` class；无高亮时的通用
  标签（"代码块" / "Code block" 等）当作"没有语言"，不写进围栏。
- **行内代码含反引号**时自动加长围栏（`` ``a`b`` ``），围栏冲突同理，保证产出的 Markdown 一定可解析。
- **表格单元格**里的 `|` 转义，内部换行压成空格。
- **只选中一段加粗文字**时向外吸附到整节点，否则 `**` 标记会丢。
- **代码块里的空行不压缩**（块与块之间才用一个空行连接）。

### 字面转义：只在文本节点上做

剪贴板里装的是源码，所以"看起来像 Markdown 的正文"必须转义，否则粘回去会被重新解析：

| 正文里出现 | 产出 | 为什么 |
|---|---|---|
| `*args`、`**kwargs` | `\*args`、`\*\*kwargs` | 否则变成强调 |
| 行首（含至多 3 个空格）`#` `-` `+` `>` `1.`，整行只有 `-` 或 `=` | `\#` `\-` `\>` `1\.` `\-` `\=` | 否则变成标题/列表/引用/分隔线/setext 标题 |
| pre-wrap 里的字面换行，续行行首空格/Tab | `\` + 换行；`&#32;` / `&#9;` | 否则软换行会并成一行，行首空白被吞 |
| 行首 `[1]: x` | `[1]\: x` | 否则变成链接引用定义，整行消失 |
| 行首四个空格或 Tab | `&#32;` / `&#9;` | 否则变成缩进代码块 |
| 任何 `$`（如 `$5 到 $10`） | `\$5 到 \$10` | DSH 开着单 `$` 行内数学，不成对也会被当公式 |
| `` ` ``、`~`、`&amp;`、`<div>` | `\``、`\~`、`\&amp;`、`\<div>` | 否则变成行内代码/删除线/实体/HTML |
| 末尾的字面 `\` | `\\` | 否则吞掉下一行变成硬换行 |
| `snake_case` | 原样 | CommonMark 里词内下划线不构成强调 |
| `[x](y)` | `\[x](y)` | 否则变成链接 |

只转义文本节点：标题、围栏、`**` 这些由序列化器自己生成的标记在转义之后才拼上去，不会被误伤；
`<code>` / `<pre>` 里的内容一个字符都不动。

### 只选中公式的一部分

TeX 里没有"第 3 到第 7 个字符"这种信息，所以局部选区只能**按结构重建**：把视觉臂读成一条字符串，
让 MathML 树按布局顺序去切它（分式先排分母、根式先排指数、矩阵先排第一列、上下限排在算符两侧），
每个叶子必须与分到的字符完全对上，否则整条链路放弃、回退成整条公式。

| 选中 | 结果 |
|---|---|
| `∑`（只框住算符） | `$\sum$` |
| `i=1`（下标） | `$i=1$` |
| `∑` + 上下标 | `$\sum_{i=1}^{n}$` |
| 排版在上方的分子 `a` | `$a$` |
| 整条公式 / 盖住视觉臂 | 作者原文 |

因为第 3 步是重建而不是抄写，片段可能与作者原文有风格差异（`\dfrac` → `\frac`、`\left(` → `(`），
但渲染出来是同一份数学。矩阵是例外：只有"刚好一个单元格"才给片段。

### 字符到宏的表是自动生成的

手写"字符 → 宏"映射一定会漏（`\Longrightarrow` 曾经只给出裸字形 `⟹`），所以这张表由 KaTeX 自己
派生：`tools/gen-unicode-tex.mjs` 读 KaTeX 的 `src/symbols.ts` / `src/macros.ts`，把 774 个宏逐个
渲染，记下每个字符的规范宏（429 个字符映射）和节点签名（478 个，覆盖 `\mathbf` 这类字体属性）。
KaTeX 升级后重跑 `node tools/gen-unicode-tex.mjs --write` 即可。

自检里的第 12 组断言会对**每一个宏**做片段重建，再把片段重新交给 KaTeX 渲染，和它来源的 MathML
子树逐节点比对；"本可以用宏表示的裸字符"也会被抓出来。

## 已知限制

- **只接管对话正文里的复制**：输入框、侧栏、设置页一律不干预；DSH 自己的复制按钮不被抢。
- **公式**：整条选中给原文；部分选中给结构等价的重建片段；选区只要有一端落在公式外就按整条处理。
  遇到不认识的构造（`\underbrace`、用宏搭出来的自定义写法）同样回退成整条公式。
  排版字形由多段拼成的宏（`\neq`、`\notin`、`\KaTeX`，约占宏清单 10%）的局部提取会回退成整条。
- **Mermaid / 图片预览之类的非文本块**按普通图片或跳过来处理，不还原图定义。
- **脚注引用**只在定义列表同时被选中时才还原成 `[^n]`，否则保持行内 HTML（渲染出来仍是上标）。
- **终端块与 diff 卡**按"完整覆盖"识别：只选中块里一两行时给那几行的原始文本，不会凭空补出 `+`/`-`。
- **行内 HTML 兜底**：`<mark>` / `<u>` / `<kbd>` / `<sup>` / `<sub>` 没有对应 Markdown 语法，只能以
  行内 HTML 还原。注意 DSH 自己的渲染器把行内 HTML 当文本显示，粘回 DSH 会看到字面的 `<mark>…</mark>`。
- **中日文紧贴标点的加粗**：`**“注意”**是` 这类写法不满足 CommonMark 的 flanking 规则，粘回后
  `**` 会以字面显示；没有不依赖 HTML 的等价写法。
- **硬换行**：`<br>` 输出为 `\` + 换行；标题和表格单元格里变成空格。
- **用户 / steering 气泡原样复制**：选区完全落在一条用户或 steering 行里时复制的是当初输入的原文，
  `**`、`- `、`$` 都不加反斜杠（气泡的换行用行尾两个空格保住）。选区跨到助手消息时整体按 Markdown 处理。
- **代码内的部分选择**：只选中代码块/行内代码的一部分时给原始文本，不加围栏、不转义 —— 粘到编辑器
  或终端里就是代码本身；代价是粘到 Markdown 目标时会按 Markdown 解析。
- **编辑区不接管**：焦点或选区端点在 `input` / `textarea` / `contenteditable` 内时走浏览器默认复制。
- **裸 URL**：正文里的 `http://…` 粘回后会被 GFM 自动识别成链接（与原渲染一致）。

## 验证

```sh
npm install
node --check client.js && node --check index.js
node tools/verify-core.mjs      # 152 项断言
```

自检覆盖：行内/块级公式、KaTeX 错误回退、局部公式重建、片段等价性（用 KaTeX 重渲染后与原 MathML
子树逐节点比对）、公式选区的各种边界、标题/代码/列表/嵌套列表/引用/表格/行内样式/任务列表、
代码块横幅与语言、反引号升级围栏、表格竖线转义、局部选区的加粗吸附、正文与输入框的区域判定、
字面转义各条规则、链接与图片、表格对齐、`mark`/`u`/`sup`/`sub`、diff 卡/终端块/脚注（含 sr-only
标题、`↩` 回链、多段定义）、端到端的 copy 事件（接管、`preventDefault`、输入框内不接管），以及
大量文本下的线性耗时。

`jsdom` 和 `katex` 是 devDependencies：前者提供真实 DOM，后者用来做片段等价性比对（版本与 DSH
安装里的 KaTeX 保持一致）。

## 兼容性

| 项 | 值 |
|---|---|
| 声明支持 | DSH `>=0.2.2-rc.3 <0.3.0`（`engines.dsh`） |
| 最近核对 | DSH `0.2.2-rc.5` |
| 对话区域 | `data-conversation-session`、`data-composer-seat`、`data-chat-flow-key`、`data-chat-turn`、`data-chat-flow`、`data-chat-flow-kind`（`user` / `steering`） |
| 内容块 | `data-code-block-banner`、`data-code-block-content`、`data-diff` / `data-diff-line`、`data-terminal`、`data-footnotes` |
| 公式 | KaTeX 的 `.katex-mathml annotation[encoding="application/x-tex"]`，视觉臂 `.katex-html` 为 `aria-hidden` |

这些接缝没有官方的兼容承诺：DSH 升级后如果改名，功能会静默退化成"浏览器默认复制"。升级 DSH
后建议跑一次自检，并用一段带公式/代码/表格的回答实测一次。

## 许可证

[MIT](LICENSE) © 2026 Rayzenchen
