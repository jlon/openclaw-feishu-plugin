# OpenClaw 飞书插件

这是一个基于 OpenClaw 官方飞书/Lark 插件持续增强的独立源码仓库。

这个仓库解决的重点不是飞书基础接入，而是 `多账号 + 群聊协作 + 多 Agent 协议` 这条生产主线。当前本地运行中的飞书插件代码，已经以这个仓库为准并同步到本机 OpenClaw 安装目录。

## 这是什么

这个插件在保留官方飞书插件基础能力的前提下，增强了以下能力：

- 多账号飞书接入
- 文档、知识库、云盘、权限等工具能力
- 群消息仲裁与多 Agent 群协作协议
- `main` 默认入口、专业 Agent 显式点名、共同点名直答
- `peer_collab / coordinate` 两类复杂协作模式
- owner、handoff、accept/reject/need_info/complete 协作状态机
- 流式回复去重、内部控制块剥离、错误 `@` 清洗
- 群参与者视图 `feishu_chat(action="participants")`

## 参数兼容性

当前结论：**配置参数层面，基本兼容原生 OpenClaw 飞书插件。**

理由：

- 本仓库继续使用官方的 `channels.feishu` 配置 schema
- `defaultAccount`、`dmPolicy`、`groupPolicy`、`groupAllowFrom`、`requireMention`、`renderMode`、`streaming`、`tools.*` 等原生参数都仍然有效
- 没有另起一套新的配置 DSL
- 已有增强主要发生在运行时群协作协议和工具行为上，而不是配置字段重定义

当前是**增量增强**，不是**破坏性替换**。

需要明确的差异：

- 新增了 `feishu_chat(action="participants")` 视图，用来回答“这个群里有哪些可见成员和内部机器人参与者”
- 群协作协议新增了 `direct_reply / peer_collab / coordinate` 行为分流，但这不是新的配置字段，而是运行时行为增强

兼容边界：

- 这份兼容判断以 `openclaw@2026.3.8` / `@openclaw/feishu@2026.3.8-beta.1` 为基线
- 如果未来 upstream 大改 `configSchema` 或群协作逻辑，需要重新做一次兼容审计

## 当前支持的群聊协作模式

### 1. `default`
- 无 `@`
- 只有 `main` 作为默认入口处理

### 2. `direct_reply`
- 共同点名多个 Agent，但问题只是轻量直答
- 每个被点名 Agent 只代表自己回答
- 不创建任务，不发生 handoff

### 3. `peer_collab`
- 同时点名多个内部专业 Agent，并要求一起看、互相补充、继续讨论
- 会创建协作任务
- 允许 owner、handoff、accept/reject/need_info/complete
- 用于“多个专业 Agent 受控多轮协作”

### 4. `coordinate`
- 明确要求 `main` 安排、协调、汇总、拉通
- 只有 `main` 处理原始群消息
- 其他 Agent 通过内部协作参与

更细的协议细节见：
- [能力与兼容性](docs/01-能力与兼容性.md)
- [群聊协作模式](docs/02-群聊协作模式.md)
- [技术实现细节](docs/03-技术实现细节.md)
- [结构化协作设计文档](docs/design/OpenClaw-飞书群协作结构化协作设计文档.md)

## 目录结构

- `index.ts`: 插件入口
- `openclaw.plugin.json`: 插件元数据
- `src/`: 运行时代码与测试
- `skills/`: 插件附带技能
- `scripts/sync-to-installed-extension.sh`: 同步到本机 OpenClaw 安装目录
- `docs/`: 中文文档、技术细节和设计文档

## 本地开发

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

同步到本机安装目录：

```bash
npm run sync:local
```

运行群协作 synthetic E2E：

```bash
npm run e2e:group
```

## 当前运行时

本机 OpenClaw 当前加载的插件目录是：

```text
/home/oppo/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/extensions/feishu
```

这个仓库不会自动替换运行目录。修改仓库后，需要手动执行：

```bash
npm run sync:local
systemctl --user restart openclaw-gateway.service
```

## 已知边界

1. 飞书原生 bot-to-bot `@` 不是可靠控制面
2. 可见 `@` 可以保留做展示层，但稳定接棒必须走内部协作协议
3. 当前插件已经补了群协作协议层，但没有把 durable shared workspace 状态存储塞进插件本体
4. 如果要发布成通用插件，后续优先收敛 README、docs、验收矩阵和回归，而不是继续堆新能力
