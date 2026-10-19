# FDE 工作台（FDE Engineer Desktop）

面向 FDE / 交付工程师 / 解决方案工程师的桌面端工作台首页，内置一个参照 Claude Code CLI 交互的**学习工作台**：多供应商模型切换（CC Switch 模式）+ 模型强度（EFFORT）档位 + 练习会话。

纯本地运行，数据不出本机，不需要数据库、不需要构建工具。

## 功能

- **工作台首页**：今日概览 KPI、FDE Copilot 指令输入条（CLI 风格）、进行中交付卡片（数据 / 空态 / 骨架屏三态切换）、待办与动态
- **学习工作台**：Claude Code 式开始界面，提交学习目标后由当前启用的模型生成一节**自包含互动 HTML 课程**（teach 方法论：quiz 即时反馈、Tufte 风排版、引用可信来源）；左侧学习记录按编号 + 标题区分每次学习，课程内进度实时保存，刷新不丢
- **对话（通用 Agent）**：CLI 风格开始界面与双栏布局，多轮对话 + 工具调用（本机命令执行 / 文件读写 / 目录与检索）+ **四种审批模式**（复刻 Penguin：全部放行 / 只读放行 / 逐个询问 / 全部拒绝，默认「只读放行」）+ **目标模式**（自主推进直到目标完成再给总结）+ **上下文自动压缩**（超阈值自动 summarize）+ 模型 / EFFORT 档位选择；流式输出、思考过程折叠、会话持久化，刷新不丢
- **对话工作区**：新建对话时在工作区选择器里挑一个文件夹即可建工作区，对话按工作区分组（文件夹行可折叠、悬停有「＋」在该工作区新建对话、「···」重命名/移除）；新建对话没选文件夹时自动划分**临时工作区**（`.fde-data/workspaces/tmp-<对话号>/`，一个对话一个目录），标签取首条输入的简易摘要（去口头禅与标点，最多 12 字）；文件夹工作区用文件夹名。弹窗里的「自动临时工作区」可切回自动划分。Agent 的工具以工作区为基准：相对路径落在工作区里、`run_command` 默认在工作区执行，系统提示词里也会写明当前工作区
- **输入框统一交互**：首页 Copilot、学习工作台、对话输入框都支持自动换行（每行 60 列，半角算 1 列、汉字算 2 列，到上限自动折行）与随内容自动增高；**Enter 发送**、**Shift+Enter 换行**（中文输入法组合中按 Enter 不会误发）
- **双引擎**：**Claude Code 订阅引擎**（复用本机 Claude Code 登录态，走 Pro/Max 订阅额度）与 **REST 外接引擎**（任意 Anthropic 兼容供应商，含官方 API 与 DeepSeek、Kimi、GLM 等第三方中转）
- **模型管理（CC Switch 模式）**：官方 API 与任意兼容 Anthropic 协议的第三方中转并存；一键拉取供应商模型列表，全量模型二级下拉切换并按能力强弱排序；EFFORT 档位随模型动态生成（如 Claude Opus/Fable 五档：最低 / 低 / 中 / 高 / 最大）；一键测试连接
- **Key 安全**：API Key 只保存在本机并仅由本地后端代持调用上游，页面与接口都拿不到完整 Key，只展示「是否已配置 + 尾号 4 位」
- **管理与运营**：侧边栏分「工作台」与「管理与运营」两个区域，当前上线两个功能：
  - **用量数据看板（成本与统计）**：按成本看板模板组织——右上角三个筛选（全部 Agent / 全部模型 / 时间范围：最近一小时、最近一天、近 7 天、近 30 天、近 90 天、自定义），今日 / 近 7 天 / 累计三张汇总卡（Token、Requests、成本）；四张图表：各 Agent 请求与成功率、各模型请求与成功率（堆叠柱 + 成功率折线、双坐标轴）、Token 变化（缓存命中 / 缓存未命中 / 输出 + 缓存命中率）、成本变化（¥ 与 $ 各一条曲线与一侧坐标轴）；底部「异常」区统计总数 / 未预期 / 预期内 / 最常见错误并列出明细
  - **应用可观测**（对应 Langfuse 的 LLM Application Observability）：每次对话或课程生成一条可展开的执行链路——用串行箭头与并行虚线分组展示每个节点（模型 / 上下文压缩 / 工具 / Skill / 子代理），工具节点附「模型判断」原文、调用参数与返回结果；每个模型节点标注 Token（含缓存命中与未命中）与该模型币种的费用；进行中的调用实时标「运行中」，由历史记录回填的链路标「估算」；支持按对话题目、模型、工具或 Skill 搜索，以及成功 / 错误筛选
  - **币种跟随模型返回**：Claude 官方按美元（$），DeepSeek / Kimi / GLM / Qwen 按人民币（¥）；两者同时出现时分别列出（如 ¥7.04 · $4.71），成本图各用一侧坐标轴
  - 数据全部来自本地埋点（见下节「用量与可观测的数据来源」），非演示数据

## 运行

要求：Node.js ≥ 22.5（用到内置 fetch 与内置 `node:sqlite`；本机 Node 24 已验证）。零依赖启动，不需要安装数据库驱动或构建工具。

可选：要用 Claude Code 订阅引擎，需 `npm install @anthropic-ai/claude-agent-sdk`（REST 外接引擎不需要）。

```bash
# 1. 初始化本地配置（Key 留空，启动后在页面里填）
mkdir -p .fde-data && cp providers.example.json .fde-data/providers.json

# 2. 启动本地服务
node fde-workbench-server.js

# 3. 打开
open http://127.0.0.1:7842
```

> 注意：请通过 `http://127.0.0.1:7842` 访问，不要直接双击 HTML 打开——所有模型配置与代理能力都在本地后端上。

端口可用环境变量覆盖：`FDE_PORT=8000 node fde-workbench-server.js`。

## 配置模型供应商

1. 首页侧边栏左下角 → **设置** → **模型管理**
2. 编辑某个供应商或「＋ 添加供应商」：
   - **官方 API**：Base URL 默认 `https://api.anthropic.com`，填入官方 Key
   - **第三方 API**：填中转站地址（兼容 Anthropic 协议）+ 中转站 Key；模型列表地址一般留空（默认 `Base URL + /v1/models`），少数中转需单独填写
3. **测试连接** 验证连通性 → **获取模型列表** → 回到学习工作台，MODEL 菜单里即可切换全量模型

正在启用的配置不可删除（需先切换到其他配置）；所有变更即时生效、刷新不丢。

## 用量与可观测的数据来源

两个页面读的是本地埋点，不是演示数据：

- **写入**：每次对话（`default_agent`）与每次课程生成（`learn_agent`）在后端开一条 trace，逐个记录模型调用、上下文压缩与工具调用（参数 / 判断 / 结果 / 审批拒绝），对话或课程结束时收尾为 `success` / `error` / `stopped`
- **调用原因**：每个模型节点带 `reason`——「收到用户提问，开始第 N 轮推理」「上一轮的工具结果已回灌，继续推理」「上下文压缩后继续」等，页面在节点里以「调用原因」展示；回填链路按对话顺序推断
- **内容标签**：每次模型调用还记录 `content`（`steps.content_json`）——`system`（系统提示词原文 + 字/Token 数）、`user`（本轮用户输入，工具回灌时说明「本轮没有新的用户输入」）、`skills`、`tools`（发给模型的工具 / MCP 定义）、`context`（上下文消息清单 + 系统与消息 Token 拆分 + 与上一轮的差值）、`thinking`（思考过程）、`output`（本轮输出）。页面上每块内容一个标签——模型节点是「系统提示词 / 用户输入 / Skill / 工具 / 上下文 / 思考过程 / 输出」，工具节点是「模型判断 / 参数 / 结果」，用的是同一套交互：标签正面直接显示这段文本的开头（不是只给数量），点开才铺全文；全文放在可拖拽缩放（右下角拖动改宽高）的文本框里，右上角 `A− / A+ / 复位` 或用 ⌘/Ctrl + 滚轮可以调字号；同一节点同时只展开一个标签，展开时卡片会按文本框宽度自动变宽。回填的历史链路只还原对话里可见的部分，节点上会注明 system 与工具定义当时没有记录
- **存放**：SQLite 单文件 `.fde-data/ops/ops.db`（Node 内置 `node:sqlite`，零依赖），参照 Langfuse 的 trace + observations 建模：`traces` 表一条 = 一次对话 / 一次课程生成，`steps` 表一条 = 一次模型调用 / 上下文压缩 / 工具调用，带 `started_at`、`kind`、`model`、`trace_id` 等索引。旧版本遗留的 `traces/*.json` 在启动时一次性导入并归档到 `.fde-data/ops/traces-json/`，之后不再读取
- **查库**：`sqlite3 .fde-data/ops/ops.db`（或用 Node 的 `node:sqlite`）即可按时间 / 模型 / Agent 聚合，例如

```sql
SELECT model, count(*) calls, sum(input_tokens+output_tokens) tokens, round(sum(cost),4) cost
FROM steps WHERE kind = 'llm' GROUP BY model;
```

- **接口**：`GET /api/ops/traces?limit=200` → `{ traces, serverTime }`，前端打开这两个页面时拉取并每 5 秒轮询；后端没重启时该接口返回 404，两页会直接提示「可观测接口暂不可用（HTTP 404）：服务端可能还是旧版本」
- **Token 与费用**：优先用上游返回的 usage（`cache_read` / `cache_creation` 分别计入缓存命中 / 未命中），费用按模型价格换算，币种跟随模型（Claude 官方 `$`，DeepSeek / Kimi / GLM / Qwen `¥`）；上游没给 usage 时按字符估算，链路上标「估算」
- **看板口径**：汇总卡的 Requests 只计模型调用次数（工具调用不计入，所以少于可观测页的节点数），Token = 输入（命中 + 未命中）+ 输出，数值按千分位精确显示、成本保留 4 位小数，与链路头部的合计一致；页面上的口径行会说明当前范围里有多少次是回填估算
- **历史回填**：服务启动时对没有 trace 的历史对话按保存的 `display` 回放生成链路，同样标「估算」
- **文本编码**：命令输出与文件读取统一走 `decodeText`——先严格按 UTF-8 解，失败再按 GB18030 / Big5 解（中文 Windows 的 `dir`、`curl` 行情接口返回 GBK，直按 UTF-8 解会整段变成 `��ָ֤��`）。修复前写进磁盘的旧链路里那些替换字符已不可还原，新发起的对话正常
- **改价格**：默认价目在后端 `opsPricingRules`（每 1M token），可在 `.fde-data/ops/pricing.json` 覆盖，按顺序取第一条 `match` 子串命中的规则：

```json
{ "pricing": [ { "match": "claude-opus", "cur": "USD", "in": 15, "out": 75, "cache": 1.5 } ] }
```

- **生效**：埋点在后端，改完代码需重启 `node fde-workbench-server.js`；只改页面则刷新浏览器即可。启动时 Node 会打一条 `ExperimentalWarning: SQLite is an experimental feature`，属正常提示，不想看到可用 `node --no-warnings fde-workbench-server.js` 启动

## 项目结构

```
├── fde-workbench.html        # 前端页面（单文件，无构建）
├── fde-workbench-server.js   # 本地后端（零依赖）：托管页面、保管 Key、代理模型列表/课程生成
├── providers.example.json    # 供应商配置模板（复制到 .fde-data/providers.json）
└── .gitignore                # 已忽略 .fde-data/、.env 等一切敏感与本地文件
```

学习会话与生成的课程存放在 `.fde-data/sessions/`，对话记录存放在 `.fde-data/chats/`，对话工作区注册表在 `.fde-data/workspaces.json`（临时工作区目录在 `.fde-data/workspaces/`），用量与可观测的链路在 `.fde-data/ops/`（`ops.db` 埋点库、可选 `pricing.json`、旧 JSON 归档 `traces-json/`）；都位于被忽略目录，删除会话/对话即清理，删除工作区只移除注册、不会删除磁盘上的文件夹。

## 安全约定

- `**/apiKey` 等敏感字段只存在于 `.fde-data/providers.json`（本地，0600），该目录已被 `.gitignore` 忽略
- 后端出站接口全部脱敏：只返回 `hasKey` 与尾号 4 位
- 提交/开源前请确认 `.fde-data/`、`.env` 不在暂存区
- 生成的课程 HTML 是模型产出内容，仅建议本地自用；课程页已强制 CSP（禁外部资源加载）

## Roadmap

- 设置页扩展：MCP 管理、Skill 管理（子导航已预留占位）
- 学习工作台：teach 式多文件教学工作区（MISSION、参考资料、学习记录）
