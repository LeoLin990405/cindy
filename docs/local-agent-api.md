# Cindy 本机 Agent API v1

这是供任意本机应用接入的 Agent 会话协议。Cindy 管理供应商、凭据、模型路由和 Claude Code / Codex / Pi 执行；客户端管理自己的界面、记录、上下文、工具实现及业务权限，用户也可按应用开启 Cindy 内的可见任务记录。HHH 是首个客户端，不是协议的应用类型或授权白名单。

实现入口：[`main/local-agent/`](../apps/desktop/src/main/local-agent/)。协议扩展保持 v1，旧客户端可忽略新增能力字段；不要把兼容的本机 API 当成 OpenAI 或 Anthropic 模型 API，也不提供跨机访问。

维护者于 2026-10-22 明确裁决：**保留 Cindy 身份、现有提示词与装配语义**。应用接入的是 Cindy；通用化针对 API、授权和应用隔离。调用方应按公开事件消费 Cindy 现有风格的文本与输出格式，不以移除身份、产品指引或回答呈现规则为集成前提。客户端的 `instructions` 仍通过既有调用方指令位置追加，不替换 Cindy 提示词。

## 独立客户端示例

[`scripts/examples/local-agent-client.mjs`](../scripts/examples/local-agent-client.mjs) 只使用 Node 22+ 标准库、发现文件和 HTTP，没有 Cindy / HHH 源码依赖。先启动本任务或已包含该 API 的 Cindy，再指定**目标 profile** 的发现文件：

```sh
node scripts/examples/local-agent-client.mjs --discovery "<profile>/local-agent/discovery.json" --list-models
node scripts/examples/local-agent-client.mjs --discovery "<profile>/local-agent/discovery.json" --provider "<provider-id>" --engine pi --model "<opaque-model-id>" --cwd "<absolute-folder>"
```

每次在 Cindy 的主题确认弹窗允许该应用。第二条命令运行一个只做文本回显的 `client_echo` 工具，再接收模型回答。可用 `--client-id org.example.notes --client-name Notes` 和另一组身份同时启动两份示例；两者可使用相同会话编号。`--prompt` 自定输入，`--native-tools` 显式启用原生执行。模型调用会消费所选供应商额度。

示例令牌只在进程内存中，退出时关闭自己的会话并撤销自己的授权，不打印、保存或复用令牌。需要长期连接的产品自行通过 OS 凭据库保存此应用令牌；不得复制供应商登录。命令行参数不接收秘密。`--list-models` 不调用模型生成。

## 开发连接码（可选增量）

开发构建在 **设置 → 远程连接 → 本机应用连接 → 开发连接** 提供“复制连接码”。正式构建隐藏这一行。Main 只从本进程当前持有租约、owner 仍有效的 ready server 内存生成码，不读取其他实例的发现文件；启动中、未登录/未进入本地模式、`HOST_IN_USE`、启动失败或已停止均不能复制。复制时重新查询当前状态。

规范文本为 `cindy-local:v1:<port>:<instance>`：ASCII、总长60–64字符，`port` 为无前导零的十进制整数1..65535，`instance` 为已有API nonce（32字节随机值的43位无padding base64url）。原始输入最多256字符，只允许trim首尾空白，之后严格匹配上述格式；不接受内部空白、URL、host、path、query或额外字段。`v1` 对应RPC protocol=1；其他版本返回 `CONNECTION_CODE_UNSUPPORTED`，非法输入返回 `CONNECTION_CODE_INVALID`。

连接码是本机端点定位信息，不是grant/token，不包含账号、凭据、profile、源码目录、PID或稳定实例账本。没有短码服务、持久映射、公共实例目录、进程/端口扫描、TTL心跳或实例间通信。原API自己的 per-profile discovery、host.lock、owner-scoped grants和恢复记录继续保留；不是“整个API零文件”。

```sh
node scripts/examples/local-agent-client.mjs --connection-code "cindy-local:v1:<port>:<instance>" --list-models
```

独立Node示例保留 `--discovery` 旧入口，两个入口必须二选一。接码后只向 `http://127.0.0.1:<port>/rpc` 发无Bearer的 `capabilities`，携带码中nonce，拒绝重定向；握手超时750ms、响应上限32KiB。先核对protocol和instance，再核对 `features.instanceMetadata:true` 和 `instanceInfo:{kind,region}`；开发入口必须为 `kind:"development"`，region只能是global/cn/dev。缺元数据报 `INSTANCE_METADATA_UNSUPPORTED`，类型不符报 `INSTANCE_METADATA_MISMATCH`，端点代次不符报 `INSTANCE_CHANGED`，网络/超时/非法JSON不能验证时为 `CONNECTION_UNAVAILABLE`。只有握手通过后才按原 `connect/start` / Cindy 确认 / `connect/poll` 申请授权；拒绝、取消和超时保持原协议，不自动批准。

`instanceInfo` 是可选的两字段构建自述，版本继续使用capabilities顶层 `version`。只有实际packaged、非已验证个人构建且region非dev才是installed；unpackaged、CindyDev或个人构建均为development，不能按版本号或profile路径猜。region来自既有构建区域，默认global规则不变。元数据用于避免错连，不是对同OS用户恶意程序的发行认证。

日常正式连接继续读取调用方原先绑定的正式profile的 `local-agent/discovery.json`，然后无token核对nonce、`kind:"installed"`及预期region。共profile的开发实例若持有原host.lock，正式API仍会 `HOST_IN_USE`，该路径的discovery可能指向development；必须明确拒绝把它当正式版，不能自动改接另一实例。不同profile仍可独立连接；不新增锁接管、路由或实例协调。

旧v1端点缺身份元数据时，显式旧 `--discovery` 接入仍兼容、grants无需重建；但无法证明其正式身份，新的正式自动连接应显示legacy/unknown并提示经官方更新入口升级，不把缺字段默认当installed。没有本机API的旧安装版不可连接，不侧载或替换安装版。

每个客户端对象固定端点、nonce及自己的授权，能力查询永不带Bearer。重启/owner或API换代后码失效，重新从目标Cindy复制并握手；旧执行不迁移，消息、工具副作用和控制请求不自动重放。调用方负责临时开发覆盖及恢复正式配置，不转用其他目标token。此码仅用于同一电脑上的应用，不扩展SSH/device-link/Mobile协议。

## 发现、封装与能力

目标 profile 根目录的 `local-agent/discovery.json`：

```json
{"protocol":1,"port":12345,"instance":"<opaque-instance>"}
```

端口随机分配，只监听 `127.0.0.1`。发现文件不含令牌。正式 profile 与开发沙箱完全独立；示例不扫描或默认借用其他 profile。Windows 正式目录为 `%APPDATA%/CindyGlobal` 或中国大陆版 `%APPDATA%/Cindy`，macOS 在 `~/Library/Application Support/`，Linux 在 `$XDG_CONFIG_HOME`（缺省 `~/.config`）；沙箱位置以启动器输出为准。

`POST http://127.0.0.1:<port>/rpc`，`Content-Type: application/json`：

```json
{"version":1,"instance":"<opaque-instance>","id":"550e8400-e29b-41d4-a716-446655440000:1","method":"capabilities","params":{}}
```

成功为 `{"result":...}`，失败为 `{"error":{"code":"...","message":"..."}}`；错误的 `code` 用于程序判断，`message` 用于展示。RPC 不使用 JSON-RPC 的 `jsonrpc` 字段。Host 必须为发现的 loopback 地址，任何带 Origin 的请求都拒绝；这是供本机进程使用的接口，不开放浏览器 CORS。

`capabilities` 无需授权，返回 `protocol`、Cindy `version`、`instance`、可用 `methods` 和 `features`。当前通用扩展声明 `clientIdentity`、`isolatedSessions`、`individualRevocation`、`toolPolicy`、`scopedPermissions` 为 true；装配只读任务观察时另声明 `taskObservation: 1`、`historyCoherence: 1`。`nativeReadOnly` 仍为 false：任务观察只读不代表原生执行具有只读文件沙箱。能力声明不等于调用方已获授权。未声明的能力不得假定支持。`instance` 保持可选以兼容早期 v1 客户端，新客户端应始终携带；实例改变后重新发现，不自动重放旧操作。

有副作用的请求编号必须是 `<process-nonce>:<counter>`，nonce 为 8–64 位 `[A-Za-z0-9_-]`，counter 从 1 单调递增、最多 15 位。去重按**授权 + 完整请求编号**计算，同编号不同 payload 拒绝；每个进程保留最近 256 个编号的窗口，已过期请求拒绝执行，不重新提交。重启后用新 nonce，不依赖旧实例的去重记录。每个授权最多同时保留 32 个进程 nonce（全部授权合计 128 个）；名额用满时，空闲超过 10 分钟的 nonce 会被回收，之后再用该 nonce 的请求返回 `REQUEST_EXPIRED` 且不执行，仍无可回收名额时返回 `CLIENT_LIMIT`。网络超时表示结果可能未知；任何消息、工具副作用或控制请求都不能用新编号自动重试。

## 应用授权

1. `connect/start`：`{"client":{"id":"org.example.notes","name":"Notes","version":"1.0"},"permissions":["tasks:read"]}`，返回 `{id,claim,url}`。权限只能是 `agent:execute`、`tasks:read` 的非空、不重复数组。只有省略 `permissions` 时才兼容为旧版的 `['agent:execute']`；显式 `['tasks:read']` 不附带执行权，不能调用 models、open、send、events 或任何执行控制。两项都要使用时必须同时申请并在原生确认中展示。已有授权不按应用 id 升权；新增读取须另行原生确认并签发独立授权。id 最多 128 字符，只含字母、数字、点、下划线、连字符且以字母或数字开头；名称最多 80 字符，version 可省略、最多 64 字符。名称/版本不接受控制或双向覆盖字符。
2. Cindy 在**本机**显示应用自报名称、编号及能力说明，由用户允许或取消。客户端无需打开返回的兼容网页才能触发弹窗。允许连接和撤销连接复用 Cindy 的主题确认组件及确认队列，默认焦点在取消，支持 Esc、Tab 焦点约束；不会弹出操作系统消息框。
3. `connect/poll`：`{id,claim}`，返回 `{state:"waiting"|"denied"|"approved",token?,permissions?}`；通过后才有 token 和实际权限。申请两分钟过期。`connect/cancel` 用同一组 id/claim 取消并撤销该申请已经签发的授权。
确认请求由 Main 生成不可复用的编号，只投递到当前可信主窗口；回包必须来自同一窗口的顶层 Cindy 页面。窗口关闭、崩溃、导航（含页内导航）、账号换代、宿主关闭、请求取消或超时都会取消待确认项，迟到回包不能批准。Renderer 只提供用户选择，Main 在执行前再次核对 owner generation 与请求归属；HTTP 客户端不能提交确认回包。并发请求沿用 Cindy 的确认队列，各自独立结算。

4. 后续请求带 `Authorization: Bearer <token>`。`connect/revoke` 无参数，只撤销**当前令牌自己的授权**。

应用名称、id、version 都是申请方自报的展示资料，不能证明安装包或发布者身份。相同 app id / 名称不会得到已有授权或会话；每次经用户允许产生独立、不可猜测的 bearer 凭据。名字不是认证依据，不按品牌自动批准。

设置 → 远程连接 → 本机应用连接逐条显示应用、自报编号和授权权限，每条可单独撤销。撤销同时失效令牌、恢复绑定、工具桥接、观察读取与事件轮询，并只关闭该授权自己的执行会话，不关闭被观察的既有任务；其他授权保持可用。旧设置调用不带编号的“全部撤销”仍兼容。账号切换和退出会关闭本机 API；数据仍按 Cindy 的账号 owner 隔离。

## 只读任务观察（`taskObservation: 1`）

这是通用本机调用方能力，不绑定某个 Dashboard、MCP App 或应用品牌。首次读取之前必须核对能力，
再以 `permissions:['tasks:read']` 经 Cindy 原生确认申请；不能借旧执行 token、内部 helper token、
插件令牌、系统文件或任意 IPC 绕过。HTTP 入口仍只监听本机 loopback；远端内容由本机 Cindy
复用当前账号已有的设备互联授权取得，不提供新的跨机登录、凭证或公开接口。

| method | params | 结果边界 |
|---|---|---|
| `observation/devices` | `{limit?,cursor?}` | 授权电脑分页，含可用性和不可用原因；不启用远控 |
| `observation/sessions` | `{deviceId?,limit?,cursor?,order?,workdir?,fromMs?,toMs?,agentKind?}` | 单台电脑既有任务分页与宿主生成的任务链接；不包含已删除任务 |
| `observation/history` | `{deviceId?,sessionId,limit?,cursor?,expectedRevision?,order?,workdir?,fromMs?,toMs?,agentKind?}` | 单个任务可见问答分页；排除清空边界及之前、工具、思考、已 rewind 内容或任意 agentMeta |
| `observation/inspect` | `{deviceId?,sessionIds}` | 最多 32 个明确目标的运行态与有界队列快照 |

`deviceId` 默认 `local`；远端只接受设备列表中的精确 id，不接受 `all` 或转发到第三台电脑。
`sessionId` 是该来源电脑上的不透明原 id，与 deviceId 分开传；不要自行拆装 id。
分页默认 50、最多 100 条，`order` 为 asc/desc；毫秒时间窗为 `[fromMs,toMs)`，agentKind 为
cc/codex/pi。下一页原样提交 `nextCursor`；游标绑定方法、设备、任务和查询条件，篡改或跨查询使用
拒绝，不静默回到首页。游标不是授权、也不是稳定快照；活动中的列表会变化。宿主换代后重新握手、
从所需起点重新读取，不将旧游标视为仍有效。

分页结果分别使用 `devices`、`sessions`、`messages` 数组，以及 `hasMore`、`nextCursor`；
设备页声明 `consistency:'live'`；任务目录同样是 live，并固定 `captureComplete:false`，不是原子全量清单。
目录行有 `clearBoundaryKnown`；只有确实取得源字段才返回 `clearedAt`（毫秒数或 null）。
旧源遗漏字段为 unknown，不补 null；此时目录 `partial:true`。`messageCount` 不是可见问答数或
一致性凭据，可能含清空前保留的记录。读取结果包含 `observedAt` 与 `partial`。
历史只交付正文文本，不下载附件；每条最多 8,000 字符，整批共享 12,000 字符预算。
源端已截断、结构化内容超限或可见媒体未交付时保留 `truncated:true`／`partial:true`，
不能声称拿到了完整要求，也不返回用于判定截断的内部 agentMeta。隐藏的合成续跑／UI 指令
不作为用户问答返回；队列仍保留真实计数和位置，但合成指令正文为空并标记 hidden/truncated。
该判定保留 Main 捕获的 autoResume／原始合成意图，不只检查可能已改写的正文前缀。
新的 Main 输入在改写前冻结 `originalSyntheticTrigger`：合成种类表示隐藏，显式 null 才表示
确知的普通输入；该值经发送事务保存在内部历史元数据，观察接口不导出元数据。
旧记录／恢复队列没有该依据时，不能从普通文字反推为真人输入：历史省略其 user 正文并返回
`unknownInputProvenance:true`／`partial:true`；队列正文为空、`provenanceUnknown:true`／truncated，
计数、顺序和 consuming 保留。已丢失的旧标记不做猜测回填；这会限制历史覆盖，不能声称完整旧问答。
分页为空也可能只是本页输入被过滤；必须继续遵循 hasMore／nextCursor，并汇总**所有页**的 partial
与 unknown 标记，不用最后一页的 false 覆盖先前的不完整。
`queue.count` 是检查投影总条数，包含 consuming 条目，不等于纯等待 backlog；items 已截断时，
不能由可见条目推算完整的等待／正在投递数量。
远端复用既有单任务历史通道的结构保留模式，先保留正文类型再过滤，不复用会先拍平
thinking/tool 对象的 MCP 正文摘要；远端原始响应超过 1 MiB 时明确拒绝，仍受设备互联原有
传输预算限制。原始结构与隐藏内容只在 Cindy 内判定，不交给本机调用方。
`inspect` 的每个 session 返回 `runtime:{state,authoritative}` 与 `queue`。运行态为
running/idle/not-active/unknown；本机 v2 运行时缺席只证明 not-active，不证明工作完成。
远端设备互联可能过滤后台任务，即使保留 v2 外壳也不能把缺席证明为空闲，故仍为 unknown。
队列未恢复／不可检查、远端不支持队列只读检查，均保留 unavailable/unsupported；
`queue.status:'available'` 才含 count/items/truncated，不用空数组或零代替未知值。
队列每个任务最多 20 条、每条正文摘要最多 500 字符；检查不恢复、不排空、不启动任务。
原有远端 `maker:input:get-projection` 可能恢复队列，因此不用于观察。离线、禁用、撤权、旧端不支持
与超时按设备报告；没有覆盖所有设备和各自游标时不能声称全量。单次编码结果上限 128 KiB；
分页返回 `RESPONSE_TOO_LARGE` 时保留原游标、缩小 limit 重读，不越过未交付行；
`inspect` 无 limit，应缩小 sessionIds、分批检查。

`history`／`inspect` 的明确目标还须在读取前后按来源电脑复核存在且未删除；保留旧 id
不允许继续读取软删除任务的正文或队列。缺失／已删除目标返回 NOT_FOUND，不能回落私人数据库
或把失败显示为空历史／零队列；inspect 混合批次应拆分检查并保留逐项失败。
调用在开始、每个异步读取与返回前复核调用方授权和账号代次；远端继续使用 Cindy 既有授权门。
撤销停止该授权的读取，不关闭被观察的既有任务；另一个应用的授权不受影响。读取不进入执行结果
去重缓存，重复读取会重新检查授权并取得新的观察结果。native-read-only 文件执行仍不受此声明支持。
真实授权、安装版能力、跨电脑可达性与源数据完整性须分别验收；源码或测试通过不代表已经部署。

### 历史清空与跨页一致性（`historyCoherence: 1`）

调用方须同时检查 `taskObservation:1` 和 `historyCoherence:1`；前者单独存在不证明一致性支持。
历史在 SQL 读取时执行 `rewindAt IS NULL`、未删除任务，以及
`clearedAt IS NULL OR messages.createdAt > sessions.clearedAt`，不是事后只按时间高水位补新行。
成功页返回 `clearedAt`、不透明 `sourceRevision`、`consistency:'mutation-checked'`、`snapshot:false`。
新清空边界意味着撤回之前已采集的对应旧证据；更新、rewind、删除同样不能按 append-only 合并。
目录的清空字段未知、读取失败或旧快照不能证明没有清空，更不能据此重新发布已撤回内容。

这是保守的乐观检查，不持有数据库事务、任务锁或可恢复快照：在读取前后核对实际连接代次、
SQLite `total_changes`／`data_version`／`schema_version`；工作线程重启、原始连接替换、账号库
切换均更换依据。同长度修改、改回原文、rewind、清空和其他连接提交不能靠相同条数／时间戳蒙混。
见证值覆盖整个账号数据库，所以**其他任务或元数据写入也会失效本次采集**；繁忙源不保证可完成。
游标除查询和位置外还绑定源 revision；同一采集各页必须 revision 相同。可省略游标、携带
`expectedRevision` 做一次新的有界复核；与游标中的 revision 矛盾则为 `INVALID_CURSOR`。

- `HISTORY_CHANGED`：窗口中有变化／重启。丢弃本次拼接的全部页和游标，从所需起点按明确预算重取；
  不保留旧页再续新代次，不无界自动重试。预算用尽保留 partial／unknown，不声称采集完整。
- `COHERENCE_UNSUPPORTED`：源端不支持连接见证或仍是忽略新选项的旧版。不能降级为原始历史或凭
  空页声称完整；需升级兼容源端后重试。源能力和本机入口能力要分别判断。
- 已删除／缺失目标仍为 `NOT_FOUND`；不能当作空历史或继续使用缓存正文。

跨机复用既有单任务历史通道的可选 `observation` 参数，源端保留结构并执行清空过滤、前后检查；
控制端异步复核元数据及最后的设备目录资格之后，再用同通道的 `stateOnly` 读检查该源 revision；
它是交付前最后一个异步读取，之后只做同步的授权复核、时间和体积检查。旧请求省略此参数
保持原语义。见证不向共享任务访客开放，避免泄露账号级写入活动；原访客历史访问不变。
无新增 channel、数据库 schema、持久 revision／任务登记表、凭证或执行权限。
即使所有页耗尽且无截断，也只证明本次查询在最后见证时未检测到变更，不是持续有效、跨任务／
跨电脑的原子快照；调用方发布、刷新及撤回策略仍须保留来源、范围和时效，不用 `hasMore:false`
宣称所有任务或设备完整，也不把 SQLite 见证当作内存运行态或队列的 revision。

### 在 Cindy 中创建可见任务

每个已连接应用有独立的「在 Cindy 中创建可见任务」开关，默认关闭；未设置的旧授权同样保持关闭。只有 Cindy 本机的受信设置界面能更改此偏好，应用不能通过 RPC 开启。该偏好仅影响之后的 `session/open`，不改变已打开的执行会话；关闭或撤销授权不会删除已有任务和消息。它不授予执行权限：只有 `tasks:read` 的授权即使开启此偏好也不能创建执行。

开启后，每次 `session/open` 都创建新的普通可见任务，并沿用现有任务的消息持久化、实时事件与列表刷新。返回值可选追加 `cindySessionId`，是可用于 `cindy://session/<id>` 的任务编号，区别于应用自定的 `sessionId` 和不透明恢复句柄 `id`。传入 `resume` 仍按旧协议恢复本授权自己的原生执行，但不会查找、续接或改写之前的 Cindy 任务；之前的可见记录保留。应用不能指定 Cindy 任务编号，也不会取得由用户接管的运行时。

原问题、回复和工具活动保存在当前账号的任务历史中；图片先进入媒体总仓，临时输入回收后仍可查看。应用消息复用发送方元数据 `sourcePlugin` 的保留前缀 `local-app:<client-id>`，桌面、手机和交接文本均显示实际的本机应用来源，不提供插件详情跳转。来源名称仍是应用自报资料，不是认证依据。来源说明只追加到当次模型输入，不混入保存的正文，不增加 system 提示词。

可见任务仍沿用该应用原有的工具策略、授权隔离和独立原生历史，不装载私人记忆；仅凭可见任务开关不会取得其他任务访问权，观察读取仍须另行确认 `tasks:read`。仅查看任务不接管；用户在 Cindy 中发送、插话或修改运行设置前，宿主先拒绝该外部执行的新输入，关闭旧执行并完成持久上下文交接，再以普通 Cindy 任务继续。交接失败时阻止此次操作并保留重试，不回退到外部实例。外部执行正常关闭同样完成交接；应用的恢复句柄只保留接管前的原生历史，无法观察、控制或恢复接管后的 Cindy 运行时。此设置不提供未安装唤起、安装后重试或未登录期间的入站队列。

## 目录和会话操作

| method | params | result / 语义 |
|---|---|---|
| `models` | `{}` | `{models:[{id,label,provider,providerLabel?,engine,model,efforts,defaultEffort?,images,isDefault}]}` |
| `session/open` | `{sessionId,cwd,model,toolPolicy,tools,effort?,instructions?,resume?}` | `{sessionId,id,resumed}`；id 是供恢复使用的不透明句柄，不是原生线程 ID |
| `send` | `{sessionId,parts,effort?}` | `{}` 表示接收发送请求，轮次结果随后由 events 返回 |
| `steer` | `{sessionId,parts}` | 向正在运行的轮次插话；未运行返回 `NOT_RUNNING` |
| `interrupt` | `{sessionId}` | 请求实际引擎停止；最终状态看 events |
| `instructions` | `{sessionId,instructions}` | 更新追加说明，下一轮按原生恢复边界应用 |
| `events` | `{sessionId,cursor}` | `{events:[{seq,event}],cursor}`；无新事件最多等待 20 秒 |
| `tool/reply` | `{sessionId,callId,text,isError?}` | 回传该会话的一次客户端工具结果；重复或过期回传拒绝 |
| `session/close` | `{sessionId}` | 关闭当前执行会话并释放等待工具，保留属于此授权的恢复绑定 |

`models[].id` 唯一标识供应商 + 引擎 + 模型组合，客户端将其视为不透明值。`provider` 是稳定分组编号，`providerLabel` 是可选显示名，不从 label 解析路由；同名模型的不同来源不合并。目录来自当前已连接且可选的对话来源，不导出路由地址和凭据。空目录正常返回空数组，不悄悄更换来源。

目录包含本机、允许远程调用的同账号在线电脑，以及当前有效的供应商分享；按来源、供应商、引擎和模型区分身份。远程供应商显示电脑名，分享供应商显示分享者；`XD Gateway` 的内置显示名称与 Cindy 选择器一致为 `Cindy AI`。远程目录使用现有授权投影与模型可见性，单个不可达来源不阻塞其他来源；账号切换后丢弃迟到结果。来源 ID 和路由只保留在 Main，不进入公共模型 JSON。

选中远程来源后，Agent 通过既有 device-link 在该来源运行，客户端工具仍回到调用应用；不要求本机装有对应引擎，不回落到本机同名供应商。远端（包括供应商组的实际执行端）须声明 `localApplication: true`，否则返回 `REMOTE_AGENT_PEER_TOO_OLD` 并提示更新。旧端仍可能出现在目录中，其在线和已授权不代表支持外部应用执行。`client-only` 不收集本机项目/个人配置，反向入口拒绝文件与命令执行；Codex 原生存储按控制端、分享中转身份和应用授权分目录。Pi、Claude 沿用各自原生适配器的记录目录，应用间的恢复授权由 API 的 owner/grant 绑定约束，不承诺所有引擎都有应用级物理目录。分享凭据访问仍需主人确认，当前 API 无交互回执时明确拒绝。

本机供应商有组时，首次打开复用本机组路由器及 `localTask` 分配规则；同账号远程来源有组时复用 `provider-group:remote` 选机。两者都直连选中的组员（可为本机或分享来源），携带既有 `groupAssigned` 标记防止再次分组；组不可用或查询失败不直接落到组所在电脑。实际路由随原生线程封装在既有 owner/grant 恢复绑定中，修改指令及重新打开都回原组员，不重新选机；旧的裸线程绑定仍回原来源。启动失败向调用方报告，本 API 暂不自动重选成员：启动超时不代表远端没有创建执行，换机需要确认前一次清理并区分原生恢复，不能直接重放 open。该封装仅在 Main 存储，应用仍只收到不透明恢复句柄。目录与 Cindy 选择器共用组成员收起规则；组来源不可用时，其他可用成员恢复单独显示。实现见 `local-agent/groupRoute.ts`，回归见 `runtime.integration.test.ts` 与 `remote-agent/__tests__/roundtrip.test.ts`。

应用会话的运行负载纳入既有供应商组统计：本机执行（包括组选回调用端本机）计入本机目录的 `runningTurns`；经远程组分配的会话保留组所在电脑和成员键，与普通任务合并为同一份 lease 快照，沿用 60 秒心跳和结束释放。注册表按账号隔离，账号切换后旧回调不进入新账号报告，恢复绑定保留原组归属。实现见 `local-agent/load.ts`，回归见 `local-agent/__tests__/load.test.ts` 与 `provider-group/__tests__/runtime.test.ts`。

`sessionId` 是客户端自定的非空字符串，最多 128 字符；编号按授权隔离。`cwd` 为当前电脑上的现存绝对目录。`tools` 为至多 256 个 `{name,description,parameters}`，parameters 为 JSON Schema 对象；name 最多 64 字符，只含 `[A-Za-z0-9_-]` 且会话内唯一。新协议使用 `toolPolicy`：

- `client-only`：仅调用该会话登记的客户端工具。它不代表工具本身只读，客户端仍负责业务确认和工具权限。
- `native`：同时保留所选引擎的原生执行能力，能按当前系统用户权限读写文件、执行命令；**cwd 不是操作系统沙箱**。

旧 v1 的 `access:"none"|"full"` 分别映射上述两种模式，仍可使用；同时传两者时必须一致。原生只读尚未声明，不能用提示词或 `client-only` 推断存在只读文件沙箱。

`parts` 是 1–64 个 `{type:"text",text}` 或 `{type:"image",mimeType,data}`；图片 data 是 base64，只接受模型声明支持的 PNG/JPEG/WebP/GIF，单张解码最多 10 MiB。`client-only` 将以 `/` 开头的文本转义为字面消息，路径等普通内容仍可发送，不执行原生命令；`native` 保留既有引擎命令行为。模型、来源或引擎切换必须重新 open；相同模型可用原句柄恢复，不同模型返回新句柄和 `resumed:false`，客户端自行提供上下文交接，不重放旧工具或付费消息。

本机组只收起已由本机目录实际提供的同引擎、同模型成员选项。本机连接不可用、引擎未安装或模型不可选时，对应远程／分享成员仍单独显示，避免仅有组配置却没有可选组入口时把可用来源全部隐藏。

## 事件和工具往返

每个会话只安排一个有序事件消费者，初始 cursor 为 0，下一次请求使用已完整处理批次的返回 cursor。发送该 cursor 同时确认其之前事件可回收。事件有严格递增 seq；失去响应时可用**最后已处理**的 cursor 重新读取，不随意推进。不要并行提交相互矛盾的确认游标。

| event.type | event.data |
|---|---|
| `text` / `thinking` | 增量字符串，不重复发最终全文快照 |
| `host_tool` | `{id,name,arguments}`；id 是 callId，客户端执行自己的注册工具后回传 |
| `tool_started` | `{id,name,arguments}`；引擎自带活动的投影，不要求客户端再执行 |
| `tool_finished` | `{id,output,isError}` |
| `usage` | `{input,cached,output}`；input 包括缓存读取和写入，按引擎的当轮用量或请求增量投影，不由客户端猜计费金额 |
| `turn_end` | `{status:"completed"|"interrupted"|"failed",message?}` |

每个运行会话都有服务端生成的内部 MCP URL 和独立令牌，不由客户端提交，不会通过公共 RPC 返回。三个引擎使用通用 `client` 命名空间，桥接只列出该会话登记的工具；`host_tool` 已代表该调用，不再从原生活动重复执行。其他授权的 MCP token、工具 callId、恢复句柄或 sessionId 都不能取得此会话的调用权。

当前协议不转发原生人机确认：原生提问/计划批准会产生明确失败，不能替用户答应；需要交互的客户端应提供自己的交互工具。

## 执行、存储与兼容

远程执行不要求本机安装引擎的规则也适用于应用的可见任务：`Maker.createSession` 保留持久化、发送和关闭生命周期，缺少本机引擎时从远程句柄提供应用所需能力；本机执行仍须有本机引擎。回归见 `packages/maker-core/src/maker.test.ts`。

默认使用 `Maker.startLocalAgentSession` 复用三种引擎及既有内存 `Session`，由同一套发送、原生续段、终态归属、工具循环与关闭生命周期管理执行；不建立第二个 Agent 循环，也不写入 Cindy 的私人任务数据库或装载私人记忆。用户为应用开启可见任务后，改走既有 `Maker.createSession` 和 Desktop 消息记录管线，工具策略仍由原本机能力约束。原生带 continuation claim 的 done 只是 SDK 段落边界，不能提前宣布客户端执行完成或接受下一轮发送。原生 cancelled 投影为 interrupted。

Claude client-only 关闭原生 tools/settings/skills；Pi 仅开启客户端网关；Codex 使用独立模型工具目录、app-server 与原生历史配置，保留所选模型的窗口配置。client-only 不合入 Cindy 的其他 MCP。Cindy 固定身份、回答呈现、host system prompt 及既有动态段装配保持原样；插件花名册仍由原回调按工作目录、启用状态和账号可见性产生，通讯录说明沿用各引擎现有可用性判断。花名册与提示词不是工具授权；连接未注册的私人 MCP 仍不可调用，也不因此取得私人任务、记忆或供应商凭据。私人任务观察只有另行原生确认的 `tasks:read` 授权可用，不由执行会话的提示词或工具策略隐式授予。静态指引可能提及本连接未开放的能力，调用方须按本连接实际登记的工具与公开事件处理，不能仅凭文字假定能力已获授权。Codex native 排除自动继承的私有 MCP 连接与 Apps 账号连接（包括原生插件自带的 MCP 服务，它们可能携带账号凭据），同时保留工作目录的原生技能、原生插件与执行能力，不复用 Review 的全量技能禁用策略。native 模式仍可读取工作目录和引擎原生配置；其文件访问受本机系统用户权限支配，API 隔离不是对同一系统用户下恶意程序的 OS 沙箱。

关闭、撤销授权及晚到的启动结果以 account-boundary 原因关闭内存 Session，连同其持有的原生子执行收尾。无法确认进程退出时返回 `RUNTIME_CLOSE_UNCONFIRMED`，保留清理对象供宿主关闭重试；令牌及工具入口仍立即失效，不将不确定的停止报告为已经结束。

持久授权存放在 owner-scoped `local-agent/grants.json`：只含令牌 SHA-256、账号范围、服务端授权 id、自报身份及归属此授权的恢复绑定。它不存令牌明文、供应商凭据或消息正文。写入及异常恢复复用 Main 的 `atomicWriteFileSync` / `readAtomicFileSync`，不另造 Windows 替换协议。profile 根 `local-agent/host.lock` 复用既有跨进程锁：同一 profile 只有一个发现端点和授权快照写入者，共库预览实例不能覆盖撤销结果；Maker 替换等待旧端点释放。账号持久范围与运行期的 owner generation 分开，切走再切回同一账号也不会复活旧的在途确认。

新授权的临时输入和 Codex 运行历史配置位于 `local-agent/clients/<grant-hash>/`；Codex 的可重建模型工具目录仍在 `local-agent/codex-catalogs/`。其他引擎的原生转录由其原有适配器管理，执行 API 只保存自己签发的恢复绑定，不暴露其他授权的执行会话或恢复句柄。单独授权的任务观察只通过上述有界只读入口读取既有 Cindy 任务，不改变执行隔离。

授权文件使用 schema 3。校验 v1/v2 旧文件后保留令牌哈希、授权 id、账号、身份、legacyRuntime、可见任务偏好和恢复绑定，旧授权仅迁移为 `['agent:execute']`，不增加任务观察权限。首次写入前以独占创建保留原版本的 `grants.json.v1.bak` 或 `grants.json.v2.bak`，不覆盖已有备份，新格式仍复用原子替换。存量 v1 授权保留历史 `hhh` MCP 名称和旧原生存储定位，仅用于已存授权的恢复兼容；所有新连接都使用通用 namespace。旧字符串形式的 `client` 也保持支持。

不认识的版本、损坏文件或无效 v3 权限拒绝加载并保留原文件，不清空重建。不能把只读权限附在 v2 上：旧执行版会忽略权限字段，把观察 token 误当执行权。因此旧 schema 1/2 二进制必须拒绝 v3；降级应使用独立 profile，不自动恢复备份。备份只反映迁移时状态，不包含之后新增／撤销的授权，不是无损降级或撤销后的恢复源。

会话上限 16，授权上限 32，申请上限 8；这些是当前实例的资源预算，不是按品牌分配。请求最大 16 MiB，单会话事件队列最大 8 MiB，事件每批通常不超过 1 MiB（单个大事件可独占一批），空闲会话三分钟回收，单会话最多 64 个待回传工具。超限会返回明确错误或收尾该会话，不转发到另一个供应商。协议不自动重试模型和工具操作。

常见可判断错误：`UNAUTHORIZED`（重新授权）、`INSTANCE_CHANGED`（重新发现）、`MODEL_UNAVAILABLE`（重新选择有效来源）、`RESUME_UNAVAILABLE`（新会话并交接上下文）、`SESSION_UNAVAILABLE`（原会话已关闭或不属于此授权）、`UNSUPPORTED_ACCESS`（策略不支持/矛盾）、`ID_REUSED` / `REQUEST_EXPIRED`（未重复执行）、`CLIENT_LIMIT`（同时运行的客户端进程过多，稍后重试）、`GRANT_STORE_INVALID`（保留原文件并检查版本/存储）。

错误 code 保持稳定，展示文案、Cindy 确认及兼容结果页通过 Cindy 当前语言的五语资源提供。设置 IPC 复用受信顶层窗口校验与统一 IPC 错误协议；等待 Cindy 确认后再次校验发起窗口及 owner generation，不向 Renderer 返回原始存储异常。

此入口只管理当前电脑的本机应用，不执行 SSH 工作区任务，不加入 device-link 的通用 invoke/push 白名单，也未新增 Mobile 入口。远程管理此类授权需要另行定义目标电脑的 Cindy 确认和授权范围，不能把本机 handler 隐式开放给远端。

## 验证入口

- `apps/desktop/src/main/local-agent/__tests__/server.integration.test.ts`：真实 loopback、独立示例进程、同编号并行、越权拒绝、单项撤销、重启恢复及旧存储迁移；模型执行可注入，不能把它说成真实供应商验收。
- `runtime.test.ts`：目录和事件不重复投影，通用及历史 namespace。
- `maker-core` 对应适配器：Claude SDK 隔离选项；Pi 真二进制 + 本机模型响应夹具；Codex 真 app-server（需 `CINDY_CODEX_TEST_BINARY`）。
- `apps/desktop/scripts/fixtures/local-agent/`：真实设置组件，多应用单项撤销、取消、失败、手机宽度、五种语言与深浅主题；宿主接口由场景提供，不替代真实授权与 IPC 验收。

- `service.test.ts`：真实 service/确认桥接/可信 IPC handler 联动，批准、取消、abort、超时、导航/关闭、账号换代、伪造回包和并发撤销隔离。
- `apps/desktop/scripts/fixtures/local-agent-confirmation/`：生产确认 Host 与共用 ConfirmDialog，五语言、双主题、320px、默认取消焦点、Tab/Esc、队列取消；主进程与实际授权另由隔离 Desktop 验证。
