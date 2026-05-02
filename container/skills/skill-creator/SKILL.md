---
name: skill-creator
description: >
  创建新的 Skill、修改和改进已有 Skill。当用户想要创建 Skill、编辑 Skill、
  将当前工作流程转化为可复用 Skill、或者提供了一个现成的 Skill 内容要求适配时使用。
  即使用户没有明确说"创建 skill"，只要他们表达了"把这个流程自动化"、"记住这个做法"、
  "下次也这样做"之类的意图，也应该考虑使用此 skill。
user-invocable: false
---

# Skill Creator

创建新 Skill 和迭代改进已有 Skill 的指南。

## 整体流程

1. 理解用户意图——他们想让 Skill 做什么、什么时候触发
2. 编写 SKILL.md 草稿
3. 保存到 `$HAPPYCLAW_SKILLS_DIR`（由 HappyClaw 负责运行时链接）
4. 和用户一起测试、收集反馈
5. 根据反馈迭代改进
6. 直到用户满意为止

你的工作是判断用户处于哪个阶段，然后帮他们推进。可能他们说"我想做一个 X 的 skill"，那就从需求捕获开始；也可能他们已经有一份现成的 SKILL.md，那就直接进入适配/改进环节。

## 存储位置原则

HappyClaw 有自己的 Skill 管理机制。创建、迁移或修改用户级 Skill 时，**只把源文件写到 `$HAPPYCLAW_SKILLS_DIR`**（宿主机对应 `data/skills/{ownerId}/`）。不要把 HappyClaw Skill 安装到 provider 原生目录，例如 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`。

这些 provider 原生目录可能只对某个 runner 或当前宿主环境生效，不会进入 HappyClaw 的 `/api/skills`、Web Skills 管理页，也不保证能被未来自动新建的 workspace 继承。`data/sessions/<workspace>/.claude/skills` / `.claude/skills` 这类目录只应视为 HappyClaw 启动 runtime 时生成的链接层或缓存，不是持久化来源。

只有在用户明确要求“给 Codex/Claude 原生环境单独安装一个 skill，和 HappyClaw 无关”时，才考虑写入 provider 原生目录，并且要说明它不会被 HappyClaw 统一管理。

## 需求捕获

从对话上下文中提取信息，必要时向用户提问：

1. 这个 Skill 要让 Claude 做什么？
2. 什么时候应该触发？（用户会说什么话、什么场景）
3. 期望的输出格式是什么？
4. 需要哪些工具权限？（`Bash`、`Read`、`Edit` 等）
5. 有没有边界情况或特殊要求？

如果当前对话中已经包含了一个完整的工作流程（比如用户说"把刚才这个流程做成 skill"），直接从对话历史中提取：用了什么工具、步骤顺序、用户做了哪些修正、输入输出格式。

## HappyClaw Skill 格式

### 目录结构

```
{skill-id}/               ← 目录名就是 skill ID
├── SKILL.md              ← 必需（skill 定义文件）
├── scripts/              ← 可选（可执行脚本，用于确定性/重复性任务）
├── references/           ← 可选（参考文档，按需加载到上下文）
└── assets/               ← 可选（模板、图标等静态资源）
```

**skill-id 命名规则**：只允许字母、数字、下划线、连字符（正则：`/^[\w\-]+$/`）。用小写加连字符，如 `code-reviewer`、`daily-report`。

### SKILL.md 格式

```yaml
---
name: my-skill
description: >
  这个 skill 做什么、什么时候应该触发。描述要具体，
  涵盖触发场景和关键词，让 Claude 能准确判断何时使用。
user-invocable: true
allowed-tools: Bash(*), Read, Edit
argument-hint: <参数说明>
---

# Skill 标题

Markdown 格式的详细指令...
```

### Frontmatter 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 显示名称 |
| `description` | 是 | 触发描述——这是 Claude 决定是否使用此 skill 的主要依据 |
| `user-invocable` | 否 | 用户能否通过 `/skill-name` 直接调用（默认 `true`）|
| `allowed-tools` | 否 | 允许使用的工具，逗号分隔（如 `Bash(*)`, `Read`, `Edit`）|
| `argument-hint` | 否 | 参数提示文本 |

### 启用 / 禁用

将 `SKILL.md` 重命名为 `SKILL.md.disabled` 即可禁用，反之启用。用户也可以在 Web UI 的 Skills 页面切换。

## 三层渐进加载

Skill 使用三层加载机制，合理分配上下文：

1. **元数据**（name + description）—— 始终在上下文中（约 100 词）
2. **SKILL.md 正文** —— skill 触发时加载（理想情况 < 500 行）
3. **附带资源** —— 按需加载（无大小限制，脚本可直接执行无需加载）

**要点**：
- SKILL.md 正文控制在 500 行以内；如果超过，把细节拆到 `references/` 目录，SKILL.md 中给出清晰的指引
- 对大型参考文档（> 300 行），加一个目录索引
- 按领域/框架组织变体文档：

```
cloud-deploy/
├── SKILL.md          ← 工作流 + 选择逻辑
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

## 写好 description

description 是触发的核心机制。Claude 看到用户消息后，根据 description 判断是否需要这个 skill。

**写得"主动"一些**：Claude 目前倾向于"少触发"，所以 description 要稍微"推"一下。比如：

不够好：`如何构建数据展示面板。`

更好：`如何构建数据展示面板。当用户提到仪表盘、数据可视化、指标展示、或者想要展示任何类型的数据时都应该使用此 skill，即使他们没有明确说"面板"。`

## 写作风格

- **解释 why**：用理论解释让模型理解背后的原因，而不是堆砌 ALWAYS / NEVER。模型很聪明，理解了原因就能举一反三
- **用祈使句**：直接说"做什么"，不要说"你应该做什么"
- **保持精练**：删掉不起作用的内容。如果测试中发现某段指令让模型浪费时间做无用功，果断去掉
- **给例子**：示例比抽象描述更有效

```markdown
## 提交消息格式
**示例 1：**
输入：添加了基于 JWT 的用户认证
输出：feat(auth): 实现 JWT 认证

**示例 2：**
输入：修复了侧边栏在移动端的滚动问题
输出：fix(ui): 修复移动端侧边栏滚动
```

- **提取重复工作**：如果你发现每次运行 skill 时 Claude 都在写类似的辅助脚本，把它放进 `scripts/` 目录

## 文件操作

### 创建新 Skill

Skills 目录路径通过环境变量 `$HAPPYCLAW_SKILLS_DIR` 获取。这个目录是 HappyClaw 用户级 Skill 的唯一持久化来源。

```bash
# 创建 skill 目录和 SKILL.md
mkdir -p "$HAPPYCLAW_SKILLS_DIR/my-new-skill"
# 然后用 Write/Edit 工具写入 $HAPPYCLAW_SKILLS_DIR/my-new-skill/SKILL.md
```

不要额外写入 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`。HappyClaw 会在每次 runtime 启动时自动把 `$HAPPYCLAW_PROJECT_SKILLS_DIR` 和 `$HAPPYCLAW_SKILLS_DIR` 链接进 session 目录；Codex 的 tool-loader 也会直接扫描这两个目录。

如果当前 runtime 已经启动，新创建的 skill 通常从下一轮/下一次 runtime 启动开始稳定可见。需要立刻验证时，优先直接读取 `$HAPPYCLAW_SKILLS_DIR/<skill-id>/SKILL.md` 或重新启动一次相关 runtime，不要为了“立即可见”污染 provider 原生目录。

### 编辑已有 Skill

用户级 skill 的实际文件在 `$HAPPYCLAW_SKILLS_DIR/` 中，可以直接用 Read/Edit 工具修改。项目级 skill 在 `$HAPPYCLAW_PROJECT_SKILLS_DIR`（通常是 `/workspace/project-skills/` 或 `container/skills/`）中，默认只读；要定制它们，使用下面的覆盖机制。

### 定制默认 Skill（Copy-on-Write）

系统自带的默认 skill（如 `agent-browser`、`post-test-cleanup`）是项目级的，只读挂载。如果你觉得某个默认 skill 需要根据当前环境精简或调整（比如去掉不适用的命令、添加特定于当前系统的配置），按以下步骤操作：

```bash
# 1. 复制默认 skill 到用户目录
cp -r /workspace/project-skills/agent-browser "$HAPPYCLAW_SKILLS_DIR/agent-browser"

# 2. 编辑用户目录中的副本（这里可以随意修改）
# 用 Read/Edit 工具修改 $HAPPYCLAW_SKILLS_DIR/agent-browser/SKILL.md

# 3. 无需手动写 provider 原生目录；HappyClaw 下次 runtime 启动会自动链接用户级覆盖
```

**原理**：runtime 启动时，符号链接按"项目级 → 用户级"的顺序创建，同名的用户级 skill 会自动覆盖项目级。所以只要在用户目录放一个同名目录，下次启动就生效。

**恢复默认**：在 Web UI 的 Skills 页面删除用户级的同名 skill，或者手动 `rm -rf "$HAPPYCLAW_SKILLS_DIR/agent-browser"`。下次启动时项目级原版会自动恢复。

**注意**：只复制你需要修改的 skill，不要批量复制所有默认 skill。保持用户目录精简，未来项目级 skill 更新时未被覆盖的会自动获得更新。

### 查看已有 Skill

```bash
ls "$HAPPYCLAW_SKILLS_DIR"                 # 列出用户级 skill
ls "$HAPPYCLAW_PROJECT_SKILLS_DIR"         # 列出项目级 skill
cat "$HAPPYCLAW_SKILLS_DIR"/*/SKILL.md     # 查看用户级 skill 内容
```

## 迭代改进

创建 skill 后，和用户一起测试和改进：

1. **测试**：用几个真实场景试用 skill，看效果
2. **收集反馈**：问用户哪里好、哪里需要改
3. **改进**：根据反馈修改 SKILL.md，注意泛化而不是过拟合到测试用例
4. **重复**：直到用户满意

改进时的原则：

- **从反馈中泛化**：skill 会被使用很多次、面对很多不同的输入。不要为了修复一个特定用例而加入过于死板的规则
- **保持精简**：删掉不起作用的内容
- **解释 why**：与其写"ALWAYS use X format"，不如解释为什么 X format 更好，让模型在边界情况下也能做出合理判断

## 安全守则

创建的 skill 不得包含：
- 恶意代码、exploit、或任何可能危害系统安全的内容
- 读取或外传敏感环境变量（如 `$ANTHROPIC_API_KEY`）的指令
- 绕过 HappyClaw 安全机制的手段

skill 的内容应该是"如果描述给用户听，不会让他们感到意外"的。
