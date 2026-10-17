# AGENTS.md · FDE 工作台项目宪法

本文件是本项目所有 AI Agent（Codex、Claude Code 等）的**唯一规则真源**。修改规则只改这里；其他入口文件（CLAUDE.md 等）只导入或摘要本文件并标明出处。

## 1. 项目与真源

- **项目**：FDE 工作台——本地单人工具（`node fde-workbench-server.js` 后访问 `http://127.0.0.1:7842`），零依赖 Node 后端 + 单文件原生 JS 前端，无框架、无构建、无数据库、无多用户。
- **真源优先级**：源码与 `.fde-data/` 实际数据 > 本宪法 > 立项文档与 ADR（001-004）> README.md > 历史对话。
- **外部事实源**：`../立项归档/`（001 立项文档、002-003 ADR、004 AI 功能规格）。该目录在仓库外，克隆环境下不存在——此时以本宪法与 README 为准，不得凭记忆虚构其内容。
- **仓库定位**：**私有仓库，仅供本人使用**。无对外贡献流程；「发布」= `git push`。

## 2. 推理闸（编码前必答）

1. 这次改动动的是哪个 owner 文件（见 §3）？
2. 是否触碰安全铁律（§5）？
3. 是否属于非目标（§7）？是 → 停止并引用条目。
4. 更简单的做法是什么？为什么不够？
5. 验收命令跑了吗？结果是什么？

## 3. Owner Map

| 范围 | Owner | 规则 |
|---|---|---|
| 全部业务语义（生成管线、引擎路由、降级、脱敏、进度合同、上游协议） | `fde-workbench-server.js` | 唯一后端；语义改动只改这里 |
| UI 呈现与设计 token | `fde-workbench.html` | `:root` 变量是设计唯一来源；前端不拥有业务语义 |
| 数据文件 `.fde-data/`（providers.json、sessions/） | **仅服务器进程** | Agent **禁止手工编辑**、禁止完整读取/输出 providers.json 内容（含明文 Key）；结构变更走 `providers.example.json` 同步 |
| 供应商配置模板 | `providers.example.json` | 改 Provider 字段结构时必须同步 |
| 对外文档 | `README.md` | 不承载 agent 规则与内部事实 |
| `skills/` 目录 | **独立技能资产**（用户手动上传的 PM 技能包，29 个文件） | 与项目本体**无代码关联**；工作台功能不得读写或依赖它；移动/改名需用户确认 |

## 4. Stack 规则（只列真实使用的）

- **运行时**：Node ≥18。后端 CommonJS；ESM 能力通过 `await import()` 动态引入（唯一用途：加载可选依赖 `@anthropic-ai/claude-agent-sdk`）。不新增硬依赖。
- **前端**：单文件内联 `<script>`/`<style>`，无框架无构建；新增交互用原生 JS。
- **存储**：JSON 文件原子写（tmp + rename）。顺序铁律：课程落盘**先 html 后 meta**；meta 存在 ⇒ 会话完整。
- **测试**：无测试框架（已知债务）。验收命令见 §6，未运行的命令不得声称通过。
- **部署**：无。`git push` 只同步代码到私有仓库，不触发任何部署。

## 5. 安全铁律（违反即返工）

1. **Key 不出后端**：任何接口响应、日志、前端代码不得出现完整 `apiKey`；脱敏只允许 `hasKey` + 尾号 4 位。
2. **`.fde-data/` 三禁**：禁提交 git、禁手工编辑、禁完整输出其中文件内容。
3. **HTML 注入契约**：凡把动态值插入 HTML 字符串，必须过 `esc()`；会话 id 必须先过 `/^\d{3,}$/` 再拼文件路径。
4. **课程页（`sessions/*.html`）是模型生成物，只读**：修正质量问题的正确手段是改提示词/引擎后重新生成；手工修补须在交付说明中明确标注。
5. 课程端点必须保持 `Cache-Control: no-store` 与 CSP（禁外部资源）。

## 6. 生成管线规则

- **任务制**：POST 立即返回 + 内存 job + 前端轮询；生成中/失败态只存内存；磁盘原子序**先 html 后 meta**。
- **引擎分派**：`type === 'claude-code'` → Agent SDK；否则 REST `/v1/messages`。REST 被中转以 `only allows Claude Code clients` 拒绝时，自动降级订阅引擎重试同一会话（其他错误不降级）。
- **上游请求体**：按模型族分档——当前代 Claude 用 `output_config.effort`，**禁止发送 `thinking.budget_tokens` 与采样参数（必 400）**；旧代 Claude 才用 budget_tokens；非 Claude 都不发。400 时走剥参降级链。
- **边界常量**：goal ≤2000 字；课程体量 ≤60KB；CC 引擎死线 20 分钟；截断自动续写 1 轮。
- 失败必须透出上游错误片段（≤300 字）或可操作提示，禁止裸错误码。

## 7. 非目标（提出即停止）

多用户/账号体系 · 云同步 · 移动端/小程序/APP · 数据库 · 构建工具与前端框架 · 订阅 token 逆向伪装 · 多轮对话式课程修改（v1） · 批量并行生成 · 第二评分模型。

任何任务触碰以上方向：**停止**，引用本节与 `../立项归档/001` §2，向用户确认是否真的要突破边界。

## 8. 验收命令

```bash
# 语法（每次改动后必跑）
node --check fde-workbench-server.js
sed -n '/^<script>$/,/^<\/script>$/p' fde-workbench.html | sed '1d;$d' > /tmp/fde-check.js && node --check /tmp/fde-check.js

# Git 边界（提交前必查：输出必须为空）
git ls-files | grep fde-data

# 运行态探针（需先 npm start，属写入态操作，征得同意后执行）
curl -s http://127.0.0.1:7842/api/providers   # 响应不得含完整 apiKey
curl -s http://127.0.0.1:7842/api/sessions     # 会话列表
```

课程质量回归（golden set 5 目标 + 结构合规 S1-S8）见 `../立项归档/004` §5/§8，属写入态长任务，按需执行。

## 9. Git 规则

- 提交信息用中文描述意图，结尾附 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- 提交前 `git status` 逐项核对，不盲目 `git add -A` 吞入无关文件；`.fde-data/`、`.env` 出现在暂存区即为事故。
- 私有仓库，无 PR/Review 流程；push 前确认分支为 main。
