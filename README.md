# FDE 工作台（FDE Engineer Desktop）

面向 FDE / 交付工程师 / 解决方案工程师的桌面端工作台首页，内置一个参照 Claude Code CLI 交互的**学习工作台**：多供应商模型切换（CC Switch 模式）+ 模型强度（EFFORT）档位 + 练习会话。

纯本地运行：一个静态页面 + 一个零依赖 Node 后端，不需要数据库、不需要构建工具。

## 功能

- **工作台首页**：今日概览 KPI、FDE Copilot 指令输入条（CLI 风格）、进行中交付卡片（数据 / 空态 / 骨架屏三态切换）、待办与动态
- **学习工作台**：Claude Code 式开始界面，提交学习目标后由当前启用的模型生成一节**自包含互动 HTML 课程**（teach 方法论：quiz 即时反馈、Tufte 风排版、引用可信来源）；左侧学习记录列表按编号 + 标题区分每次学习，课程内进度实时上报并持久化，刷新不丢
- **模型管理（CC Switch 模式）**：
  - 支持**官方 API**（Anthropic 直连）与**任意兼容 Anthropic 协议的第三方中转**
  - 一键拉取供应商模型列表，全量模型二级下拉切换，按模型能力强弱排序
  - EFFORT 档位随模型动态生成（如 Claude Opus/Fable 五档：最低 / 低 / 中 / 高 / 最大）
  - 一键测试连接（真实请求模型列表接口）
- **Key 安全模型**：API Key 只保存在本机 `.fde-data/providers.json`（权限 0600），由本地后端代理调用上游；前端与页面任何接口都拿不到完整 Key，只能看到「是否已配置 + 尾号 4 位」

## 运行

要求：Node.js ≥ 18（用到内置 fetch）

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

## 项目结构

```
├── fde-workbench.html        # 前端页面（单文件，无构建）
├── fde-workbench-server.js   # 本地后端（零依赖）：托管页面、保管 Key、代理模型列表/课程生成
├── providers.example.json    # 供应商配置模板（复制到 .fde-data/providers.json）
└── .gitignore                # 已忽略 .fde-data/、.env 等一切敏感与本地文件
```

学习会话与生成的课程存放在 `.fde-data/sessions/`（同一被忽略目录，删除会话即清理）。

## 安全约定

- `**/apiKey` 等敏感字段只存在于 `.fde-data/providers.json`（本地，0600），该目录已被 `.gitignore` 忽略
- 后端出站接口全部脱敏：只返回 `hasKey` 与尾号 4 位
- 提交/开源前请确认 `.fde-data/`、`.env` 不在暂存区
- 生成的课程 HTML 是模型产出内容，仅建议本地自用；课程页已强制 CSP（禁外部资源加载）

## Roadmap

- 设置页扩展：MCP 管理、Skill 管理（子导航已预留占位）
- 学习工作台：teach 式多文件教学工作区（MISSION、参考资料、学习记录）
