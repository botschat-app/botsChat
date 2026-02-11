# BotsChat 端到端加密（E2E）详细计划

## 1. 目标与范围

### 1.1 业务目标
- **隐私卖点**：聊天记录、Cron 提示词、任务摘要仅用户与插件可读，云端与数据库仅存密文，平台无法解密。
- **用户感知**：初始化/设置中明确提供 E2E 密码，密钥仅保存在浏览器与插件侧，产品内多处体现「端到端加密」能力。

### 1.2 技术目标
- **通信 E2E**：插件 ↔ ConnectionDO ↔ 浏览器的敏感载荷在传输前由客户端/插件加密，服务端只转发或存储密文。
- **存储 E2E**：D1 中敏感字段以密文存储，服务端不持有解密密钥。
- **密钥模型**：用户提供「E2E 密码」，在浏览器与插件侧用「密码 + userId」分别派生同一密钥；服务端不存密钥、不存盐。

### 1.3 需加密的数据

| 数据 | 存储位置 | 传输路径 | 加密字段 |
|------|----------|----------|----------|
| 聊天消息 | D1 `messages` | WS + REST GET /messages | `text`, `a2ui`, 可选 `media_url` |
| 任务执行摘要 | D1 `jobs` | WS job.update + REST GET jobs | `summary` |
| Cron 提示词/配置 | 不落库，仅经 DO 转发 | WS task.scan.result、REST /scan-data | `instructions`, `schedule`（传输加密） |

---

## 2. 架构与密钥模型

### 2.1 原则
- **服务端零知识**：API / ConnectionDO 不接收、不存储用户 E2E 密码或密钥；只存储密文。
- **密钥一致**：浏览器与插件用同一算法从「用户 E2E 密码 + 账户 ID」派生密钥，无需服务端参与，用户只需记住一个密码。

### 2.2 密钥派生（域前缀盐，用户零概念）
- **算法**：PBKDF2-HMAC-SHA256。
- **输入**：用户 E2E 密码 + **"botschat-e2e:" + userId**（域前缀 + 账户 ID，双方已知，不新增任何独立「盐」概念）。
- **不在服务端存盐**：密钥只由「密码 + 域前缀userId」派生，服务端不生成、不存储 e2e_salt；用户只需在网页和插件里设同一密码即可。域前缀 `"botschat-e2e:"` 可避免与其他系统的 PBKDF2 派生撞 salt。
- **输出**：256-bit 主密钥，直接用于 AES-256-CTR。
- **公式**：`masterKey = PBKDF2(password, "botschat-e2e:" + userId, iterations=310000, length=32)`。
- **迭代次数**：310,000（符合 OWASP 2023 推荐），首次派生约需 0.5-1 秒，可在 UI 展示「正在生成密钥」动画。

### 2.3 加密算法：AES-256-CTR（无头、无 HMAC）
- **加密**：仅 AES-256-CTR（流式，密文长度 = 明文长度，无填充），不做 MAC/tag。
- **Nonce/IV（16 bytes，CTR 用）**：由 **contextId** 派生，不随密文存储。  
  - `nonce = HKDF-SHA256(masterKey, "nonce-" + contextId, length=16)`（按实现拆成 IV + counter）。  
  - **⚠️ 关键约束**：同一 (key, contextId) **严格只加密一次**，不重用 nonce。contextId 必须是 UUID/ULID 等全局唯一标识。**禁止对同一 messageId/jobId 的内容进行更新（update）**——如需修改，必须使用新 ID 创建新记录。违反此约束将导致 CTR 模式下 nonce 重用，安全性完全崩溃。
- **存储内容**：**不带头**，密文一律以**原始字节（BLOB）**存储与传输（见 2.4）；是否加密由表结构标记。

| 数据类型 | contextId |
|----------|-----------|
| 单条消息 | `messageId` |
| job summary | `jobId` |
| task.scan 某条 | `cronJobId` 或 `cronJobId + field` |

- **无 contextId 时**：用随机 16 字节 nonce 随密文存，内容为 `nonce || ciphertext`（BLOB），该行仍用列标记为加密。

### 2.4 数据格式（一律 BLOB，无前缀）
- **密文**：以**原始二进制（BLOB）**为主；仅 REST 的 JSON 因格式限制对密文做 base64 编码。  
  - **数据库**：存密文的列类型为 **BLOB**，直接存密文字节，不用 hex/base64。  
  - **WebSocket**：密文以二进制帧（Blob / ArrayBuffer）发送与接收，或在本端先解密再以明文 JSON 交互（由实现选择）。  
  - **REST 响应**：若接口为 JSON，密文字段用 **base64** 编码传输；前端先 base64 解码为二进制再解密。服务端从 D1 读 BLOB，写出时按需 base64 编码进 JSON。
- **是否加密**：由表结构表达。`messages`、`jobs` 增加 `encrypted INTEGER DEFAULT 0`；1 表示该行敏感字段为 BLOB 密文，0 为明文（TEXT）。读取时根据 `encrypted` 决定是否解密。
- **长度**：明文 n 字节 → 密文 n 字节（BLOB），零膨胀。

---

## 3. 组件职责

### 3.1 浏览器（Web）
- **密钥**：用户输入 E2E 密码；用 `PBKDF2(password, "botschat-e2e:" + userId, iterations=310000)` 派生 masterKey（userId 从 `auth.ok` 响应获取），无需向服务端要盐。
- **存储**：派生后通过 `crypto.subtle.importKey(..., extractable: false)` 生成 **non-extractable CryptoKey** 对象，存储在模块级变量中。JS 代码无法读取密钥原始字节（防 XSS 窃取），只能通过 `crypto.subtle.encrypt/decrypt` 使用。关闭标签页即清除；可选「在本设备记住」时用密码加密 key 后存 localStorage。
- **加密/解密**：发 `user.message` 前加密 `text`；收到 agent 消息、jobs、task.scan 后根据 `encrypted` 标记解密展示。
- **防御性适配（密码错误或解密失败）**：  
  - 解密可能失败：密码错误、数据损坏、或服务端返回的 BLOB 非密文（如历史/兼容数据）。  
  - 解密失败时**不得**将解密结果或原始 BLOB 当字符串直接渲染（防乱码、防 XSS）。  
  - 统一处理：解密前校验 `encrypted` 与密钥是否存在；解密失败（抛错或返回错误码）时，该条消息/摘要显示占位文案，例如「无法解密，请检查 E2E 密码是否与插件一致」或「[内容无法解密]」，并可选提供「重新输入 E2E 密码」入口。  
  - 对接口返回的 BLOB（或 base64 解码后的二进制）：先尝试解密；若失败则走上述占位逻辑，不把原始字节当 UTF-8 解码展示。

### 3.2 插件（OpenClaw Plugin）
- **密钥**：从配置读 `channels.botschat.e2ePassword`；用同一公式 `PBKDF2(password, "botschat-e2e:" + userId, iterations=310000)` 派生 key（userId 在 `auth.ok` 响应中获得）。
- **加密/解密**：发送前加密 `agent.text`、`agent.a2ui`、`job.update.summary`、`task.scan.result` 的 instructions/schedule；收到 `user.message` 后解密。

### 3.3 API / ConnectionDO
- **不持钥**：不接收、不存储 E2E 密码或密钥。
- **存储**：收到已加密的 payload 原样写入 D1，并设对应行的 `encrypted = 1`；GET 时原样返回，不解密。
- **兼容**：`encrypted = 0` 或列为空时按明文处理（兼容旧数据与未开启 E2E）。

---

## 4. 数据流（简要）

1. **用户启用 E2E**  
   Web：用户输入 E2E 密码 → 用 `"botschat-e2e:" + userId` 本地派生 non-extractable CryptoKey → 存于模块级变量；无需调 API 要盐。  
   插件：用户执行 `openclaw config set channels.botschat.e2ePassword '<password>'`；`auth.ok` 返回 userId 后，本地用同一公式派生 key。

2. **发消息**  
   Web：明文 `text` → 本地加密 → WS 发 `user.message`（加密后的 text）。  
   DO：原样转发给插件；并可能持久化（若由 DO 从插件回包写库，则写的是插件发来的密文）。  
   插件：收到后解密 → 交给 OpenClaw。

3. **收消息 / 历史**  
   插件：生成 `agent.text` 等 → 加密后发 WS。  
   DO：原样转发给浏览器；持久化时写入密文。  
   Web：收到密文 → 解密 → 展示。  
   GET /messages：DO 从 D1 读密文 → 返回；Web 解密后展示。

4. **Jobs**  
   插件：`job.update` 中 `summary` 加密后发送。  
   DO：原样写入 D1、原样转发。  
   GET /jobs：返回密文 summary；Web 解密。

5. **Cron 提示词（仅传输）**  
   `task.scan.result` / `/scan-data`：插件对 `instructions`、`schedule` 加密后发送；DO 原样转发；Web 解密后展示。不落库，无需改 D1。

---

## 5. 数据库与 API 变更

### 5.1 D1 变更（密文列改为 BLOB，不保留旧数据）
- **users 表**：不新增列；密钥由客户端用 password + userId 派生。
- **messages 表**：存密文的列改为 **BLOB**，不保留旧数据。  
  - 将 `text`、`a2ui` 改为 **BLOB** 类型（或重建表）；新增 `encrypted INTEGER NOT NULL DEFAULT 0`。  
  - 明文时（encrypted=0）可存 TEXT 或 BLOB；encrypted=1 时必为 BLOB 密文。为统一类型，可全部改为 BLOB，明文也以 UTF-8 字节存。
- **jobs 表**：将 `summary` 改为 **BLOB**，新增 `encrypted INTEGER NOT NULL DEFAULT 0`；同上，不保留旧数据。
- **迁移策略**：不保留旧数据。迁移时**重建表**或 DROP 后 CREATE，列类型为 BLOB；无需兼容旧明文数据。

迁移示例（重建表，列类型 BLOB）：

```sql
-- 0011_e2e_blob.sql
-- messages: 重建或 ALTER，text/a2ui 为 BLOB
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'agent')),
  text BLOB,
  media_url TEXT,
  a2ui BLOB,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- jobs: 重建或 ALTER，summary 为 BLOB
DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  duration_ms INTEGER,
  summary BLOB,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_key);
```

### 5.2 API 变更
- **无需 salt 接口**：不提供 e2e/salt 或 e2e-enable 的盐分配；启用 E2E 仅前端/插件本地行为（设密码、派生 key）。
- **可选**：PATCH /me 或单独接口里允许设置 `e2eEnabled: true`（仅布尔，用于 UI 展示「已开启 E2E」），不传密码、不存盐。
- **初始化命令（setup）**：在返回的 `setupCommands` 中增加：  
  `openclaw config set channels.botschat.e2ePassword '<user-chosen-password>'`  
  并说明：与网页里设置的 E2E 密码保持一致即可。

### 5.3 插件配置
- 新增 `channels.botschat.e2ePassword`；与 Web 端设同一密码，用 userId（auth 后获得）派生同一密钥。

---

## 6. 浏览器端密钥存储（稳妥方案）

- **首选**：**non-extractable CryptoKey（模块级变量）**  
  - 派生后通过 `crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["encrypt", "decrypt"])` 生成 non-extractable CryptoKey。  
  - 密钥对象存于 JS 模块级变量，关闭标签页即清除，下次打开需重新输入 E2E 密码。  
  - 优点：即使发生 XSS，攻击者也无法导出密钥原始字节，只能在当前页面上下文中调用加解密——显著降低密钥被持久窃取的风险。  
- **可选「在本设备记住」**：  
  - 用 E2E 密码派生 KEK，用 KEK 加密实际加密密钥，密文存 localStorage；下次用密码解密得到密钥。  
  - 需在 UI 明确说明：仅本设备、本浏览器，且设备若被他人使用仍有风险。  
- **不与登录 token 同存**：E2E 密钥与 `botschat_token` 分离存储与使用，避免一次泄露同时影响认证与解密。

---

## 7. 初始化与用户感知（让用户充分感知 E2E）

目标：用户在任何时刻都能直观感受到「我的聊天与任务内容被端到端加密保护」，而不是藏在一个设置页里。

### 7.1 初始化流程
1. 在「连接 OpenClaw」的初始化步骤中，把「启用端到端加密」作为**推荐步骤**（可跳过但文案突出推荐）。
2. 用户设置 E2E 密码（与插件侧一致）；**仅本地**用 `"botschat-e2e:" + userId` 派生 key，不调 API 要盐。
3. **⚠️ 密码永久生效，设置后不可修改。** 设置时需二次确认 + 强警告：  
   - 「**此 E2E 密码设置后无法修改。**请务必牢记或离线备份（写纸上、密码管理器等）。丢失密码将永久无法解密历史数据。」  
   - 删除账号/重新注册是唯一的「重置」路径。
4. 展示的初始化命令中增加：  
   `openclaw config set channels.botschat.e2ePassword '<your-e2e-password>'`  
   并说明：与上一步在网页里设置的密码一致即可，建议不要与登录密码混用。
5. 若用户跳过，后续可在设置中再开启；开启时再次强调「只有您和您的 OpenClaw 能解密」及密码不可修改。

### 7.2 产品露出（多处、持续可见）
- **聊天区域**  
  - 输入框上方或会话标题旁常驻**小锁图标 +「端到端加密」**短文案（已开启时）。  
  - 悬停或点击可展开一句说明：「只有您与您的 OpenClaw 能解密，我们无法查看内容。」
- **侧栏 / 频道列表**  
  - 已开启 E2E 的频道旁显示**锁图标**或「E2E」小标，与未开启的频道区分。
- **Cron / 任务页**  
  - 当该账号已开启 E2E 时，在 Cron 列表或任务详情处显示「提示词与结果已端到端加密」。
- **设置页**  
  - 将「端到端加密」放在**隐私/安全**区块最上方，状态（已开启/未开启）、修改密码、简短说明集中展示。  
  - 文案示例：「您的聊天记录、Cron 提示词与任务摘要仅您与您的 OpenClaw 可读，我们无法解密。」
- **首次生效反馈**  
  - 用户首次在已开启 E2E 的会话中发送或收到一条消息后，可轻量 **toast/提示**：「此会话已受端到端加密保护」，强化感知。
- **登录/首页**  
  - 若账号已开启 E2E，登录后可在首屏或导航处有一次性短提示：「您的数据受端到端加密保护」，避免用户忘记。

---

## 8. 测试计划

### 8.1 单元 / 集成（加密工具）
- **包**：`packages/e2e-crypto`（或放在 `packages/web` / `packages/plugin` 的公共 crypto 工具）。
- **用例**：
  - 给定 password + userId，派生 key 一致（与参考实现或固定向量比对）。
  - AES-CTR：encrypt(plaintext, contextId) → decrypt(ciphertext, contextId) === plaintext。
  - 密文无业务前缀，为原始字节（BLOB）；解密后与原文一致。
  - 错误 key 或错误 contextId 解密应失败（抛错或返回明确失败）。
  - 同一 (plaintext, contextId) 加密两次，密文相同（确定性）。

### 8.2 API 层测试
- **环境**：本地 wrangler dev + D1 local，或 CI 中跑 Workers 测试。
- **用例**：
  1. **消息写入与读取为密文**  
     - 使用已认证用户，通过 WS 发送一条已加密的「已知明文」消息。  
     - 查询 D1：`SELECT text, encrypted FROM messages WHERE ...`，断言 `encrypted = 1` 且 `text` 为 BLOB 密文、不以明文形式出现（不包含测试原文）。
  2. **Jobs summary 为密文**  
     - 触发 job.update 写入已加密的已知明文 summary；查询 D1，断言 `jobs.encrypted = 1` 且 `summary` 为 BLOB 密文、非明文。
  3. **GET 返回密文、不解密**  
     - GET /messages、GET /jobs 返回的 `text`/`summary` 为密文，且对应行 `encrypted = 1`；服务端不尝试解密。
  4. **无 E2E 时行为不变**  
     - 不启用 E2E 时，消息与 jobs 为明文写入，`encrypted = 0`，兼容现有行为。

### 8.3 数据库内容加密验证（专项）
- **目标**：确保 D1 中敏感列在 E2E 开启后绝不出现明文。
- **方法**：
  1. 在测试中插入已知明文（如 `TEST_PLAINTEXT_123`、固定 prompt、固定 summary）。
  2. 通过正常 API/WS 流程写入（前端/插件侧已加密）。
  3. 用 D1 本地或测试实例直接查询：  
     `SELECT id, text, a2ui, encrypted FROM messages WHERE user_id = ?`  
     `SELECT id, summary, encrypted FROM jobs WHERE user_id = ?`
  4. 断言：当 `encrypted = 1` 时，`text`、`a2ui`、`summary` 为 BLOB 密文且不包含 `TEST_PLAINTEXT_123` 等已知字符串；无业务前缀。
- **Cron 数据**：当前不落库，传输层测试：E2E 开启时 task.scan.result 或 /scan-data 的 instructions/schedule 为 BLOB 密文，无前缀。

### 8.4 E2E 自动化（可选）
- 使用 Playwright 或类似：登录 → 启用 E2E 并设置密码 → 发一条消息 → 通过 API 或测试 DB 查询 D1 确认密文；再在 UI 刷新，确认消息正确解密展示。
- 插件侧：可单独用 Node 脚本连接测试环境，发送加密消息并验证 DO 存密文、浏览器可解密。

### 8.5 测试用例清单（可直接用于实现）

#### A. 加密工具（e2e-crypto）
| 用例 ID | 描述 | 预期 |
|---------|------|------|
| CRYPTO-1 | deriveKey(password, userId) 两次结果一致 | 相同 key |
| CRYPTO-2 | encrypt then decrypt roundtrip（带 contextId） | plaintext === decrypt(encrypt(plaintext, contextId), contextId) |
| CRYPTO-3 | 密文格式（有 contextId） | 无业务前缀，原始字节（BLOB）；长度 = plaintext.length，零膨胀 |
| CRYPTO-4 | 错误 key 或错误 contextId 解密 | 抛错或返回失败，不返回明文 |
| CRYPTO-5 | 同一明文、同一 contextId 加密两次 | 密文相同（确定性） |
| CRYPTO-6 | 短明文零膨胀 | 2 字节明文 → 密文 2 字节（BLOB），零膨胀 |

#### B. API 层
| 用例 ID | 描述 | 步骤 | 预期 |
|---------|------|------|------|
| API-1 | 消息存密文 | 通过 WS 发送已加密的 user.message → 查 D1 | messages.encrypted=1，text 为 BLOB 密文且不含原文 |
| API-2 | 消息读为密文 | GET /api/messages/:userId?sessionKey=... | 返回 messages[].text 为密文（BLOB 或 JSON 内 base64）、encrypted=1 |
| API-3 | job summary 存密文 | 触发 job.update（插件加密 summary）→ 查 D1 | jobs.encrypted=1，summary 为 BLOB 密文且不含原文 |
| API-4 | jobs 读为密文 | GET /api/channels/:cid/tasks/:tid/jobs | 返回 jobs[].summary 为密文、encrypted=1 |
| API-5 | 未启用 E2E 时明文 | 不启用 E2E，发消息、写 job | encrypted=0，text/summary 为明文 |

#### C. 数据库内容加密验证（D1 直接查询）
| 用例 ID | 描述 | 查询 | 断言 |
|---------|------|------|------|
| DB-1 | 消息正文非明文 | `SELECT text, a2ui, encrypted FROM messages WHERE user_id = ?` | encrypted=1 时 text/a2ui 为 BLOB 密文、不含已知测试原文；无前缀 |
| DB-2 | 任务摘要非明文 | `SELECT summary, encrypted FROM jobs WHERE user_id = ?` | encrypted=1 时 summary 为 BLOB 密文、不含已知测试原文 |
| DB-3 | 历史明文仍可读 | encrypted=0 或未设时 | text/summary 为原始明文（兼容旧数据） |

#### D. 集成 / E2E 场景
| 用例 ID | 描述 | 预期 |
|---------|------|------|
| INT-1 | 全链路：Web 加密发 → 插件解密 → 插件加密回 → Web 解密显示 | 消息在 UI 上显示正确 |
| INT-2 | 历史加载：GET /messages 返回密文 → Web 解密 | 列表与详情展示正确 |
| INT-3 | Cron 列表：task.scan.result 中 instructions 加密 → Web 解密 | Cron 编辑页显示正确提示词 |
| INT-4 | 错误密码或未设置插件密码 | 解密失败时有明确提示，不展示乱码为「正常内容」 |
| INT-5 | 前端防御：密码错误 / BLOB 无法解密 | 解密失败不抛未捕获异常；不把 BLOB 或解密结果当字符串直接渲染；显示占位「无法解密，请检查 E2E 密码」等 |

---

## 9. 实施阶段建议

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **Phase 1** | 密钥派生（password+userId）、AES-CTR 工具、密文 BLOB、D1 列改为 BLOB+encrypted（重建表，不保留旧数据） | `e2e-crypto` 包、迁移 0011（messages/jobs 重建为 BLOB） |
| **Phase 2** | Web：启用 E2E、密钥存储、消息/jobs 加解密与 WS/REST 集成、**解密失败/BLOB 防御性适配** | 设置页 E2E、发收消息与历史、密码错误时占位展示 |
| **Phase 3** | 插件：读取 e2ePassword、用 userId 派生 key、加解密、WS 收发全部敏感字段加密 | 插件发收密文、与 Web 互通 |
| **Phase 4** | ConnectionDO：透存密文、写入时设 encrypted=1；GET 原样返回 | DO 无密钥、仅透传与存储 |
| **Phase 5** | 初始化命令与文案、锁图标/Badge/toast、设置页与隐私说明（多处露出） | 用户感知与文档 |
| **Phase 6** | API 测试 + D1 密文断言 + 可选 E2E 自动化 | 测试套件与 CI |

---

## 10. 风险与注意事项

- **密码永久不可修改**：E2E 密码设置后不可更改。用户遗忘密码时，历史密文永久无法恢复；需在 UI 的设置流程中通过二次确认+强警告充分告知。
- **密钥一致性**：插件与 Web 必须使用同一密码和同一 userId（插件在 `auth.ok` 后获得），否则无法互解；无需服务端参与派生。
- **无完整性校验**：仅用 AES-CTR、不做 MAC，密文若被篡改无法被解密方发现（解密可能得到乱码）。此为零膨胀的代价。主要威胁模型为防止 cloud provider 读数据，能写 D1 的攻击者通常也能删数据，完整性不在 E2E 防护范围内。
- **禁止消息编辑/重写**：同一 messageId/jobId 的内容不可 update，如需修改必须创建新记录（新 ID = 新 nonce）。代码层面需强制此约束，违反将导致 CTR 模式 nonce 重用。
- **性能**：加解密在浏览器与插件侧进行，对长文本与大量历史需注意性能；可对长消息分块或限制单条大小。
- **媒体 URL**：若对 `media_url` 加密，需约定为「加密后的 URL 或标识」，R2 访问策略需与现有一致；建议首版只加密 text/a2ui/summary/instructions/schedule，media_url 仍为可访问 URL。

---

## 11. 文档与规范

- 在架构文档中增加「端到端加密」小节：数据流、密钥模型、哪些字段加密。
- API 文档中标明：当 E2E 开启时，相关接口的请求/响应体中敏感字段为密文；DB 存 BLOB，REST 若为 JSON 则密文字段以 base64 编码传输，且对应行 `encrypted=1`。
- 运维手册：说明服务端不存密钥与盐；故障排查时不接触用户密码。

以上计划覆盖了 E2E 加密的设计、密钥与存储、API/DB 变更、测试（含 API 与数据库密文验证）以及用户感知与实施阶段，可直接作为开发与测试的执行依据。
