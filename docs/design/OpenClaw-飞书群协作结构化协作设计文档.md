# OpenClaw 飞书群协作结构化协作设计文档

更新时间：2026-03-12 19:15 CST

说明：文中的 `main` 只是示例协调账号 id。实际运行时的协调账号取自 `channels.feishu.defaultAccount`，不要求固定叫 `main`。

## 1. 目标

这份设计只解决一件事：

`让多个 OpenClaw 内部 agent 在飞书群里像真人一样协作处理问题，同时保持生产可用。`

这里的“像真人一样协作”不是指无限闲聊，而是指：
1. 用户可以同时点名多个 agent
2. 多个 agent 可以各自开口
3. 某个 agent 可以把问题交给另一个 agent
4. 对方可以接棒、拒绝、要求补信息、完成阶段结论
5. 群里看起来像在协作
6. 系统里又能看见统一的任务状态、owner、证据和终止条件

如果做不到第 6 条，这只是“像聊天”。
如果做不到前 5 条，这只是“稳定编排”。

目标是两者都成立。

## 2. 需求边界

### 2.1 必须满足

1. `main` 保留无 `@` 默认接单能力。
2. 用户可以同时点名多个内部 agent。
3. 轻量问题时，多 agent 可以各自答一句，不发生内部任务流转。
4. 复杂问题时，多 agent 可以进入受控的多轮协作。
5. agent 之间可以真实接棒，而不是只在群里写一段 `@另一个 agent` 的文字。
6. 每条协作链都必须绑定同一个 `task_id`。
7. 每条协作链都必须有当前 owner。
8. 同一时刻只能有一个可见主讲 owner，但允许多个 agent 内部并行工作。
9. 用户可以中途打断、加人、要求 main 汇总。
10. 外部 bot 不进入内部协作主链。

### 2.2 明确不做

1. 不把飞书群里的 bot-to-bot `@` 当成可靠控制面。
2. 不把 LLM 生成的自然语言 `@Agent` 当成结构化协议。
3. 不支持无 `task_id`、无 owner、无 hop 限制的无限多轮闲聊。
4. 不支持外部 bot 被当成内部 agent 一样接棒。

## 3. 第一性原理

### 3.1 飞书平台的硬边界

当前已验证的边界：
1. 群里的 bot A 发消息，不能设计成 bot B 的可靠触发源。
2. 卡片消息里的 `@` 更适合做展示，不适合做控制面。
3. 不同 bot 应用之间的 `open_id` 体系不能当成一套稳定全局坐标。
4. 飞书会把原始 `@` 归一化成占位符或结构化字段，文本扫描不能作为唯一真相源。

所以：

`可靠控制面必须放在 OpenClaw 内部。飞书群消息只负责展示和用户输入。`

### 3.2 当前实现的正确部分

当前实现已经做对了三件事：
1. 群消息已能区分 `none / direct_reply / coordinate`
2. 群 mention-forward 已禁用
3. `main` 和专业 agent 的原始群消息仲裁已基本站住

这说明底座方向没错。

但当前实现还不够“像真人协作”，因为还缺：
1. `peer_collab` 模式
2. 发言权和 owner 机制
3. 结构化协作动作
4. `task_id + shared workspace` 绑定
5. 用户打断和重分流规则

### 3.3 官方能力与本设计的边界

这份设计不是在重复官方飞书插件已有能力，而是在补官方没有定义的协作协议。

当前官方 stock 飞书插件已具备的能力：
1. 多账号接入
2. 群 allowlist / `requireMention`
3. 单聊 mention-forward
4. 群消息基础仲裁与可见回复

当前官方 stock 飞书插件未提供的能力：
1. `peer_collab`
2. owner / `speakerToken`
3. `agent_handoff`
4. `task_id`
5. 结构化多轮协作状态机

因此这份设计的判断是：
1. 不再继续强化“原生 bot-to-bot `@` 本身”作为主链，因为平台不保证它可靠；
2. 可见 `@` 继续保留，用来维持群里的真人协作感；
3. 稳定控制面必须放在 OpenClaw 内部协议；
4. 后续如果要发布成通用插件，优先抽象的是协作协议，不是继续特化飞书群里的显示层 `@`。

## 4. 协作模式

群消息不能只分“直答”和“编排”。至少要分成 4 种模式。

### 4.1 `default`
示例：
- `排查 Flink 任务 demo-job 延迟`

规则：
- 只有 `main` 处理
- `main` 决定是否创建任务并内部派单

### 4.2 `direct_reply`
示例：
- `@Flink-SRE @Starrocks-SRE 你俩互相打个招呼`
- `@首席大管家 @Flink-SRE 一个字描述下 john`
- `@Flink-SRE @SoulCoder 各自介绍一下自己`

规则：
- 每个被点名 bot 只代表自己回复
- 不创建任务
- 不发生 handoff
- 不走 `sessions_send/sessions_spawn`
- 不替对方发言

### 4.3 `peer_collab`
示例：
- `@Flink-SRE @Starrocks-SRE 你俩一起看下这条链路，先各自说判断，再互相补充`
- `@Flink-SRE @Starrocks-SRE 你俩协作定位这个问题`
- `@Flink-SRE @SoulCoder 你们先一起看日志和代码，再同步判断`

规则：
- 不强制收口到 `main`
- 会创建任务
- 会创建参与者列表
- 会进入受控多轮协作
- 必须有 owner
- 允许 handoff、accept、reject、need_info、complete、escalate

### 4.4 `coordinate`
示例：
- `@首席大管家 @Flink-SRE 帮我安排并汇总这次排查`
- `@首席大管家 拉通 flink-sre 和 starrocks-sre 排查`

规则：
- 只有 `main` 处理原始群消息
- 子 agent 跳过原始群消息
- `main` 创建任务并作为初始 owner
- 专业 agent 通过内部协作参与
- 最终汇总口默认回到 `main`

### 4.5 模式判定优先级

模式判定不能靠感觉，必须按固定优先级执行。

先定义 3 个集合：
1. `internalMentions`
- 当前消息里被点名的内部 agent
2. `externalMentions`
- 当前消息里被点名但不在 OpenClaw 内部注册的 bot 或用户
3. `coordinationVerbs`
- `安排`
- `协调`
- `拉通`
- `汇总`
- `并行处理`
- `派单`
- `分工`
- `你负责`
- `你来主导`

判定顺序：
1. 如果消息要求 `main` 安排、协调、汇总或主导，进入 `coordinate`
2. 否则，如果 `internalMentions >= 2` 且出现协作语义，例如：
   - `一起看`
   - `协作`
   - `互相补充`
   - `接力`
   - `先各自说判断，再继续`
   进入 `peer_collab`
3. 否则，如果出现内部点名，但问题是轻量直答，例如：
   - `一个字`
   - `一句话`
   - `打个招呼`
   - `各自介绍`
   - `分别说下自己`
   进入 `direct_reply`
4. 否则，如果没有内部点名，进入 `default`

补充规则：
1. `externalMentions` 不计入 `internalMentions` 数量
2. `@main + @多个内部 agent` 时，只要出现协调语义，优先 `coordinate`
3. `@main + @多个内部 agent` 但问题明显是轻量直答时，仍按 `direct_reply`
4. 判定结果必须落盘到任务或会话上下文，后续 reply/handoff 不得重新猜

## 5. `peer_collab` 为什么是必须的

上一版设计最大的问题，是把“多个专业 agent 被共同点名”收成了两类：
- 要么各答一句
- 要么交给 `main`

这不符合真实群协作。

真实场景里，经常会出现：
- 用户先同时点名两个专业 agent
- 希望他们先各自给判断
- 再彼此补充
- 再决定谁接着查

这不是 `direct_reply`。
这也不是 `coordinate`。

所以必须新增 `peer_collab`。

它的作用是：
1. 允许多个专业 agent 先并行说第一轮判断
2. 之后再进入 owner 接棒阶段
3. 让群里看起来像真人协作
4. 同时把后续多轮交互控制在任务状态机里

## 6. 状态机设计

### 6.1 任务最小字段

每个进入 `peer_collab` 或 `coordinate` 的协作，都必须绑定同一个 `task_id`。

最小字段：
- `taskId`
- `mode`
- `originMessageId`
- `originSessionKey`
- `participants`
- `workers`
- `currentOwner`
- `speakerToken`
- `stage`
- `status`
- `hop`
- `visitedAgents`
- `lastHandoffId`
- `lastUserIntent`
- `version`
- `eventSeq`
- `updatedBy`
- `updatedFromMessageId`
- `activeHandoffState`

### 6.2 状态阶段

推荐状态：
1. `created`
2. `initial_assessment`
3. `active_collab`
4. `awaiting_accept`
5. `blocked_need_info`
6. `awaiting_summary`
7. `completed`
8. `aborted`

### 6.3 初始并行发言阶段

这是上一版没有写出来的关键点。

在 `peer_collab` 模式下，不应该一开始就只有一个 owner 说话。
否则一点都不像真人协作。

正确做法：
1. 任务创建后进入 `initial_assessment`
2. 每个被点名 agent 获得一次短发言机会
3. 每个 agent 只能说：
   - 现象
   - 初步判断
   - 需要看什么
4. 这一阶段不允许 handoff
5. 初始发言结束后，系统选出一个当前 owner，进入 `active_collab`

每个 `collab_assess` 不能只是一段自然语言，还必须生成结构化结果：
- `agentId`
- `domainRole`
- `ownershipClaim`
- `currentFinding`
- `nextCheck`
- `needsWorker`

其中 `ownershipClaim` 允许值：
- `owner_candidate`
- `supporting`
- `observer`

owner 选举必须确定，不允许再让模型自由猜。

前置规则：
1. 如果模式是 `coordinate`，初始 owner 固定为 `main`
2. 只有 `peer_collab` 才进入下面的 owner 选举

优先级：
1. 用户显式指定主导者  
示例：
- `Flink-SRE 先主导`
- `先由 Starrocks-SRE 接着看`
2. `initial_assessment` 里，`ownershipClaim=owner_candidate` 的 agent 优先
3. 如果多个 agent 都是 `owner_candidate`，选择最左侧被点名的内部 agent
4. 如果没有任何 `owner_candidate`，但存在 `supporting`，选择最左侧被点名的 `supporting`

owner 选举结果必须记录到：
- `currentOwner`
- `speakerToken`
- `version`
- `eventSeq`

### 6.4 owner 与 speaker token

这里必须分清楚两件事：

1. `currentOwner`
- 当前负责推动任务前进的人
- 负责 handoff、收集结果、决定下一步

2. `speakerToken`
- 当前允许在群里发下一轮主讲消息的人

在大多数时候，两者是同一个 agent。
但在 `initial_assessment` 阶段可以不同。

规则：
1. `initial_assessment` 阶段，每个被点名 agent 各有一次短发言 token
2. 进入 `active_collab` 后，同一时刻只有一个 `speakerToken`
3. 非 token 持有者只能：
   - `accept`
   - `reject`
   - `need_info`
   - 补证据到共享工作区
4. 非 owner 不允许再主动拉第三方入场

### 6.5 后台 worker 模型

“一个可见 owner + 多个内部并行工作”必须有单独模型，不然只剩串行。

规则：
1. `currentOwner` 可以创建后台 worker
2. worker 只能是当前 `participants` 中的内部 agent
3. worker 不拥有 `speakerToken`
4. worker 不直接在群里发主讲消息
5. worker 只做两件事：
   - 补证据到共享工作区
   - 回传结构化内部结果
6. worker 不能再发起新的 handoff，除非先被 owner 提升为新的 owner

最小字段：
- `workerId`
- `assignedBy`
- `purpose`
- `status`
- `evidencePaths`
- `resultSummary`

如果 worker 失败：
1. 不自动改变 `currentOwner`
2. owner 决定重试、换人或升级到 `main`

## 7. 协作动作协议

### 7.1 不允许用自然语言 `@Agent` 当协议

这条必须反复强调：

`自由文本中的 @ 只能作为展示，不能作为协作触发器。`

不能做：
- 扫描回复文本里的 `@Agent`
- 用 `getLastDeliveredText()` 推断 handoff
- 让模型自己靠自由文本决定控制流

### 7.2 最小动作集合

最小动作至少需要这 10 个：

1. `collab_assess`
- 初始并行判断

2. `agent_handoff`
- 当前 owner 交棒给目标 agent

3. `agent_handoff_accept`
- 目标 agent 接受交棒

4. `agent_handoff_reject`
- 目标 agent 拒绝交棒，并说明原因

5. `agent_handoff_need_info`
- 目标 agent 要求补充信息后才能继续

6. `agent_handoff_complete`
- 当前 owner 完成自己负责的阶段

7. `agent_escalate_to_main`
- 从 `peer_collab` 升级回 `main` 汇总或重新编排

8. `agent_handoff_cancel`
- 当前 handoff 被 owner 主动取消

9. `agent_handoff_expire`
- 当前 handoff 超时失效

10. `agent_handoff_superseded`
- 当前 handoff 被新的 handoff 覆盖，旧回执不再有效

### 7.3 `agent_handoff` 最小字段

```json
{
  "taskId": "task_20260312_xxx",
  "handoffId": "handoff_xxx",
  "fromAgentId": "flink-sre",
  "targetAgentId": "starrocks-sre",
  "reason": "需要查询服务层继续判断慢查询是否为源头",
  "visibleText": "这个问题我先交给 Starrocks-SRE 继续看。",
  "internalMessage": "【Handoff】请继续判断查询服务层是否为独立源头。已知现象：...",
  "timeWindow": "2026-03-12 18:20~18:35 CST",
  "currentFinding": "Flink checkpoint 正常，但 sink 吞吐下降。",
  "unresolvedQuestion": "查询服务层是独立源头，还是上游延迟传导后的结果？",
  "evidencePaths": [
    "shared/tasks/task_20260312_xxx/evidence/02-compute.md",
    "shared/tasks/task_20260312_xxx/artifacts/flink-metrics.png"
  ],
  "originMessageId": "feishu_msg_xxx",
  "originSessionKey": "agent:flink-sre:feishu:group:oc_xxx",
  "hop": 1,
  "visitedAgents": ["flink-sre"],
  "version": 4,
  "eventSeq": 7,
  "dedupeKey": "task_20260312_xxx:handoff_xxx:v4"
}
```

handoff 发起前必须具备最小证据包：
1. 时间窗
2. 当前现象
3. 当前判断
4. 未决问题
5. 至少一条已落盘证据路径

不满足这 5 条，不允许 handoff。

### 7.4 回执动作最小字段

```json
{
  "taskId": "task_20260312_xxx",
  "handoffId": "handoff_xxx",
  "agentId": "starrocks-sre",
  "status": "accept",
  "visibleText": "我接着看查询服务层。",
  "note": "先看慢查询、查询队列和导入刷新。",
  "version": 5,
  "eventSeq": 8,
  "updatedFromMessageId": "feishu_msg_xxx"
}
```

`status` 允许值：
- `accept`
- `reject`
- `need_info`
- `complete`
- `cancel`
- `expire`
- `superseded`

## 8. Owner、接棒和回收规则

### 8.1 为什么必须有 owner

如果没有 owner，所谓“多轮交互”会直接变成：
- 大家都能说
- 大家都觉得自己该说
- 同一轮出现双回、三回、抢结论

这不是协作，是失控。

### 8.2 owner 规则

1. 同一时刻只能有一个 `currentOwner`
2. 只有当前 owner 可以发起 `agent_handoff`
3. 目标 agent 必须先 `accept`，owner 才真正切换
4. `accept` 成功后，原 owner 自动降级成观察者
5. 观察者只能补充信息，不能继续主导线程
6. `main` 在 `coordinate` 模式下保留最终汇总权，但不等于始终是当前 owner

### 8.3 owner 失效条件

owner 不是永久身份，以下情况必须失效并重新决策：
1. handoff 被目标 agent `accept`
2. 用户显式指定新的主导者
3. 当前 owner 超时无进展
4. 任务从 `peer_collab` 升级到 `coordinate`
5. 当前 owner 明确 `complete` 且需要下一层继续主导
6. 用户要求停止

### 8.4 接棒超时与回收

这也是上一版漏掉的关键点。

如果 owner 发起 handoff，而目标 agent 长时间不接，系统不能一直悬空。

规则：
1. `agent_handoff` 发出后进入 `awaiting_accept`
2. 若目标 agent 在超时时间内未 `accept/reject/need_info`：
   - owner 自动回收
   - 任务回到发起方 owner
   - 群里发一条可见说明：`对方暂未接手，我先继续推进`
3. 若 `reject`：
   - owner 不切换
   - 原 owner 决定改找别人还是升级到 `main`
4. 若 `need_info`：
   - 任务进入 `blocked_need_info`
   - 当前 owner 仍保持不变

### 8.5 迟到回执处理

如果旧 handoff 的回执晚到，不能污染当前状态。

规则：
1. 回执必须校验：
   - `taskId`
   - `handoffId`
   - `version`
   - `eventSeq`
2. 如果当前 `activeHandoffState` 已变化：
   - 旧回执直接标记为 `superseded`
   - 不改变 `currentOwner`
   - 不改变 `speakerToken`
3. 所有状态写入必须是 compare-and-swap 语义，而不是盲写

## 9. 可见发言规则

### 9.1 `direct_reply`
- 各自只回复自己
- 不 `@` 其他内部 agent
- 不接棒

### 9.2 `peer_collab`
- `initial_assessment` 阶段：每个被点名 agent 允许一条短回复
- `active_collab` 阶段：只有当前 `speakerToken` 持有者发主讲消息
- handoff 发起时，source 可以可见地 `@targetAgent`
- target `accept` 时，可以可见地回复“收到，我接着看”
- 非 owner 不应主动再拉第三方入场

### 9.3 `coordinate`
- 原始群消息只由 `main` 接
- `main` 可以在可见层 `@` 参与者说明分工
- 专业 agent 的可见消息只用于回执、进度、阶段结论，不抢主汇总口

### 9.4 避免串位的硬规则

1. 任何 agent 不替别的 agent 做自我介绍
2. 任何 agent 不用别的 agent 的身份发消息
3. 任何 agent 不在 `direct_reply` 场景里主动 `@` 其他内部 agent
4. 共同点名场景里，禁止把外部 bot 映射成内部 agent
5. `peer_collab` 场景里，非 `speakerToken` 持有者不得主动发群主讲消息

## 10. 与任务追踪和共享工作区的绑定

如果协作不绑定 `task_id + shared workspace`，群里再像真人，也只是“像”。
系统里没有统一状态，事情不会自主流转。

### 10.1 每个协作任务的目录

```text
shared/tasks/<task_id>/
├── task.md
├── summary.md
├── evidence/
├── artifacts/
└── transcript.md
```

### 10.2 `task.md` 最小字段

- `task_id`
- `mode`
- `status`
- `participants`
- `current_owner`
- `speaker_token`
- `current_stage`
- `last_handoff_id`
- `next_action`
- `updated_at`
- `version`
- `event_seq`
- `updated_by`
- `updated_from_message_id`

### 10.3 谁改什么

1. 当前 owner
- 可以改 `summary.md`
- 可以补 `evidence/`
- 可以更新 `current_stage`
- 可以发起 `agent_handoff`

2. `main`
- 在 `coordinate` 模式下负责最终汇总
- 负责把任务状态改为 `awaiting_summary / completed`

3. 非 owner
- 只能补充自己的证据和说明
- 不改 `current_owner`
- 不改最终状态

### 10.4 写入契约

共享工作区必须有写入边界，不然多 agent 会互相覆盖。

规则：
1. `task.md`
- 只允许 runtime 改写
- 人工或 agent 不直接手写
- 必须按结构化字段整文件覆盖

2. `summary.md`
- 只允许当前 owner 改写
- 必须保留固定区块：
  - `现象`
  - `时间窗`
  - `当前判断`
  - `未决问题`
  - `下一步`

3. `evidence/`
- 采用 append-only
- 每个 agent 写自己的文件
- 推荐命名：
  - `01-ingest.md`
  - `02-compute.md`
  - `03-resource.md`
  - `04-serving.md`
  - `05-data-service.md`
  - `06-coder.md`

4. `artifacts/`
- 只新增，不覆盖
- 文件名必须带时间或序号

5. `transcript.md`
- 只允许 runtime append
- 不允许 agent 直接改写

## 11. 用户中途打断规则

这是上一版完全没定义的漏洞。

真实群聊里，用户会中途插话。
这必须进入状态机。

### 11.1 用户 `@main` 要汇总

如果当前任务是 `peer_collab`，用户中途 `@main` 并要求汇总：
1. 模式升级为 `coordinate`
2. `main` 接管最终汇总口
3. 当前 owner 不丢状态，只是停止直接对业务发主讲消息

如果 `main` 接管汇总：
1. `speakerToken` 切到 `main`
2. 原 owner 降级成后台执行者
3. 任务模式变成 `coordinate`

### 11.2 用户新点名一个内部 agent

如果当前任务未完成，用户又点名了一个新的内部 agent：
1. 若该 agent 属于当前问题相关角色，可加入 `participants`
2. 但不自动成为 owner
3. 是否发言由当前 owner 或 `main` 决定

如果用户补充的是关键新事实，例如：
- 新时间窗
- 新错误堆栈
- 新告警
- 新受影响面

则：
1. `eventSeq` 加一
2. 当前 owner 必须重新评估
3. 必要时任务回到 `initial_assessment`

### 11.3 用户要求停止

1. 任务状态改为 `aborted`
2. 当前 owner 释放
3. 后续任何 handoff 失效

## 12. 外部 bot 的处理规则

像 `云上Bot` 这类不在当前 OpenClaw 内部注册的 bot，必须单独定义。

规则：
1. 可以共同点名展示
2. 不参与内部协作主链
3. 不作为 `targetAgentId`
4. 不进入 OpenClaw 的任务状态机
5. 不计入内部模式判定人数
6. 只影响可见展示，不影响 owner 选举

这意味着：
- `@云上Bot @首席大管家 一个字描述下自己`
  - 可以作为 `direct_reply`
- 但：
  - `让云上Bot接手`
  - 不能进入内部协作主链

这不是缺陷，是边界。

如果同时出现：
- 外部 bot
- `main`
- 多个内部 agent

则模式判定时：
1. 先忽略外部 bot
2. 只按内部 agent + `main` + 用户意图判定

## 13. 运行时改造建议

### 13.1 保留现有部分

保留当前已经正确的部分：
1. `GroupCoAddressMode`
2. mention 仲裁
3. 群 mention-forward 禁用
4. 可见回复清洗

### 13.2 新增部分

新增：
1. `peer_collab` 模式判定
2. `collab_assess` 阶段
3. `agent_handoff / accept / reject / need_info / complete / escalate_to_main`
4. `owner + speakerToken`
5. `task_id + shared workspace` 绑定
6. handoff 去重、hop 限制、visitedAgents 检查
7. 接棒超时与 owner 回收
8. 用户中途打断处理
9. compare-and-swap 状态写入
10. worker 管理

### 13.3 不建议的做法

不建议：
1. 扫描 LLM 回复文本里的 `@Agent`
2. 把 `getLastDeliveredText()` 当控制协议
3. 直接伪造 Feishu 原始事件作为主协作机制

如果需要 synthetic dispatch，也应该是：

`内部协作事件`，不是伪装成 `FeishuMessageEvent` 的外部消息。

### 13.4 runtime 注入契约

运行时必须把协作上下文显式注入给 agent，不能再让 prompt 猜。

最小注入字段：
- `groupCollabMode`
- `taskId`
- `participants`
- `currentOwner`
- `speakerToken`
- `stage`
- `status`
- `hop`
- `visitedAgents`
- `activeHandoffState`
- `allowedActions`
- `visibleReplyPolicy`
- `workspace.taskDir`
- `workspace.summaryPath`
- `workspace.evidencePath`

其中：
1. `allowedActions` 决定当前 agent 只能：
   - `reply_self`
   - `collab_assess`
   - `handoff`
   - `accept`
   - `reject`
   - `need_info`
   - `complete`
   - `silent_worker_update`
2. `visibleReplyPolicy` 决定当前轮：
   - 是否允许发群主讲消息
   - 是否允许 visible `@target`
   - 是否只能静默写证据

## 14. 验收场景

### 14.1 必须通过

1. `@Flink-SRE 一个字描述下 john`
- 只有 `flink-sre` 回复

2. `@首席大管家 @Flink-SRE 一个字描述下 john`
- `main` 和 `flink-sre` 各自答自己的
- 不发生协作

3. `@Flink-SRE @Starrocks-SRE 你俩互相打个招呼`
- 两个 bot 各自答自己的
- 不发生协作

4. `@Flink-SRE @Starrocks-SRE 你俩一起看下这条链路，先各自说判断，再互相补充`
- 进入 `peer_collab`
- 生成 `task_id`
- 先进入 `initial_assessment`
- 两个 agent 各有一次短回复机会
- 然后进入 owner 接棒阶段

5. `@首席大管家 @Flink-SRE 帮我安排并汇总这次排查`
- 进入 `coordinate`
- 只有 `main` 处理原始群消息
- `main` 创建任务并内部派单

6. 当前 owner 把任务交给另一个内部 agent
- 群里出现一条可见交接提示
- 控制层实际发起 `agent_handoff`
- 目标 agent 必须先 `accept` 再接棒

7. owner handoff 超时
- owner 被自动回收
- 群里出现一条可见说明
- 任务不悬空

8. 用户中途 `@main` 要汇总
- 任务从 `peer_collab` 升级到 `coordinate`
- `main` 接管汇总口

9. 任意协作场景
- 群里不出现 `sessions_send(...)` 等内部代码
- 不出现 A 替 B 发言
- 不出现无 owner 的并行乱回

10. 含歧义的共同点名
- 按固定优先级稳定落到同一种模式
- 不因上下文不同而忽左忽右

11. 迟到 `accept`
- 不改变已回收或已切换的 owner
- 只会被标记为 `superseded`

12. 外部 bot 与内部 agent 同时被点名
- 外部 bot 不参与内部协作模式判定
- 不污染 owner 选举

### 14.2 明确不验收

1. 两个内部 agent 只靠群里 visible `@` 自主无限聊天
2. 外部 bot 被纳入 OpenClaw 内部协作主链
3. 扫描自然语言 `@Agent` 自动推断协作

## 15. 实施顺序

推荐顺序：
1. 先落 `peer_collab` 模式判定
2. 再落 `collab_assess + owner + speakerToken`
3. 再落 `agent_handoff` 系列动作
4. 再绑定 `task_id + shared workspace`
5. 再补接棒超时、用户中断、集成测试

先做第 2 步之前，不建议继续在当前实现上修修补补。
因为没有 `peer_collab + owner + task_id + interruption`，所谓“像真人一样多轮协作”永远只会停留在表面。

## 16. 结论

如果目标只是“避免串位”，上一版设计已经够。
如果目标是你现在明确提出的：

`让 bot 在群里像真人一样协作处理问题，互相之间可以 @，支持受控的多轮交互。`

那必须补四层：
1. `peer_collab`
2. `initial_assessment + owner + speakerToken`
3. `accept / reject / need_info / complete / escalate_to_main`
4. `task_id + shared workspace + interruption`

因此，下一步的正确目标不是继续修补“谁该回、谁不该回”，而是：

`把群里的真人感协作，建立在一个稳定、可追踪、可接棒、可回收、可收口的内部协作协议之上。`
