# 花艺图库 · 花艺师图片标签整理小程序

上传作品照片 → 视觉模型自动生成「颜色 / 色系 / 花材（主花·辅花·叶材）/ 种类 / 风格 / 用途」六维标签 → 按标签组合筛选历史作品。

> 2026-11-16 反馈/关于本地实现完成：11 页，独立验证 115/115（新增 38 + 既有回归 77）；22 JS、22 JSON、12 WXML、13 WXSS、路由与事件检查通过，69 产品文件运行前后及收尾哈希一致。未部署或上线；真实云端权限/审核/事务、双账号、真机及正式版未测。下列作品集 39/39、标题/描述 77/77 保留为各自前轮证据。

- 原图**无损**存入云存储；AI 分析使用长期保存的缩略图，与作品列表共用
- AI 密钥只放在云函数环境变量里，小程序前端不包含任何密钥
- 上传展示真实阶段与上传百分比；AI 等待时显示秒数并轮换提示。`qwen3.7-flash` 默认关闭思考以减少等待，可用 `QWEN_ENABLE_THINKING=true` 恢复。
- 无需独立登录，云函数按 openid 判定管理员、花艺师、其他用户并隔离数据
- 管理员撤销花艺师须二次确认，确认按钮为“确认撤销”；弹窗失败显示重试提示。2026-11-09 的点击无反馈修复只涉及前端，重新编译即可，无需因此重新部署云函数。
- 2026-11-16 本地补独立作品集分享：从「我的」创建全部动态范围或精选固定 ID 链接，接收方只读分页浏览，与单件分享分别管理。源码已核对；后端 25 组、reader 25/25、作者 26 场景 mock 及独立 39/39 组通过（分别记录，不合并计数）；独立 16 JS、10 WXML、11 WXSS 原生编译/语法和差异检查通过，详见[开发日志](./开发日志.md)。历史 v1.4.0 列表已上线记录不是本次源码或部署证据；本次未部署、发布，云端权限/索引/容量/事务性能、双微信账号、真机、正式转发及完整相册上传未测。
- 前轮作品集标题/描述增量：创建后编辑每个有效本人分享集，保留原链接和全部/精选范围；卡片自定义文本与固定范围说明分开，访客页展示标题、作者和描述，微信卡片优先用自定义标题。该轮三方源码、实施证据及独立最终 77/77 已复核，不作本次反馈/关于新增验收。
- 前轮标题/描述独立最终证据：77/77 组通过（后端 17、作者 12、读页 7、真实 API 源码 mock 联调 2、原范围/授权/只读回归 39）；实施证据后端 64/64、作者 42/42 + 原流程 7/7、读页 26/26 分别记录，不并入独立总数。16 JS、10 WXML、11 WXSS 通过，wcc/wcsc 在项目外副本各限时 10 秒、exit 0、无超时，运行前后产品哈希一致、该轮 59 份产品文件 SHA256 匹配，差异检查通过、仅 CRLF 提示。见[报告](file:///C:/Temp/portfolio-metadata-verification-20261116/REPORT.md)、[最终证据](file:///C:/Temp/portfolio-metadata-verification-20261116/final-evidence.json)、[编译日志](file:///C:/Temp/portfolio-metadata-verification-20261116/compile.run.log)。
- 原分页旧脚本初次 16/17，1 项旧断言与当前预期保留内容但隐藏分享不符；仅调整项目外隔离断言并补首页回退/重试重鉴权后 17/17，无产品修复，不宣称初次全过。真实文本审核、云端权限/实际索引/容量/事务重试时限及性能、双微信账号、真机渲染/键盘、正式转发及已发送旧卡片效果未测；未提交、部署、迁移或发布。
- 新增「我的 → 意见反馈／关于与隐私说明」公共入口，未开通、管理员、清理中也可使用。反馈需选择类型、填写内容，可手填手机号，确认后保存并显示编号；不读取微信手机号权限，无客户端反馈列表，维护人员仅从云控制台排查。关于页使用实际运行版本或明确的本地基线，历史产品记录与本次开发更新分开，隐私说明可单独打开。
- 本次独立证据见[正式报告](file:///C:/Temp/feedback-about-independent-verification-20261116/REPORT.md)、[场景与源码哈希](file:///C:/Temp/feedback-about-independent-verification-20261116/final-evidence.json)、[编译/路由汇总](file:///C:/Temp/feedback-about-independent-verification-20261116/final-checks.json)。新增后端 14、反馈页 15、关于/API 9 共 38 组，另 77 组既有回归；原生编译项目外副本各 10 秒限时 exit 0、无超时/error/signal/stderr，差异仅 CRLF 提示。实施后端 92/92、反馈 14/14 + 6/6、关于 26/26 + 7/7 不并入独立总数。G7 旧五维/固定模型文案本地已验证修复，线上未更新，G1/G3～G6 保留。

## 一、项目结构

```
florist-tags/
├── project.config.json          # 工程配置
├── miniprogram/                 # 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── utils/
│   │   ├── tagdict.js           # 标签词库（颜色/种类/风格/用途枚举、常见花材）
│   │   ├── api.js               # 云存储/云函数/数据库封装
│   │   └── app-info.js          # 运行版本、产品历史、本次开发更新
│   └── pages/
│       ├── index/               # 作品墙（Tab）
│       ├── filter/              # 标签筛选（Tab）
│       ├── upload/              # 上传（Tab）
│       ├── my/                  # 我的：账号、统计、作品集、反馈/关于公共入口
│       ├── confirm/             # AI 标签确认页
│       ├── detail/              # 作品详情（查看/编辑/删除）
│       ├── tags/                # 标签管理
│       ├── portfolio-manage/    # 本人全部/精选作品集与链接管理
│       ├── portfolio-share/     # 凭 portfolioToken 只读作品集
│       ├── feedback/            # 反馈填写、确认、成功编号与重试
│       └── about/               # 运行版本、历史日志与隐私弹窗
└── cloudfunctions/
    ├── accessGate/              # 用户体系、作品/词库、分享；feedback.js 私有反馈服务
    ├── imgSecCheck/             # 图片内容审核
    ├── analyzeImage/            # Qwen / Kimi 视觉模型打标
    └── adminMaintenance/        # 管理员分批运维清理
```

补充文档入口：
- [修改影响范围清单](./修改影响范围清单.md)：每次改代码前先查，确认上下游影响范围与验收项。
- [环境变量说明](./环境变量.md)：环境变量配置位置、格式和常见问题。
- [作品集功能说明](./功能说明.md#28-作品集分享)：两种范围、只读入口与失效边界；当前 11 页面不含名片或公共大厅。
- [反馈与关于使用说明](./功能说明.md#29-意见反馈)：填写、确认、重试及关于/隐私说明。

## 二、部署步骤（约 15 分钟）

### 1. 准备
- 安装「微信开发者工具」（稳定版即可）。
- 一个小程序 AppID（没有可先用测试号体验，但**云开发需要正式 AppID**，建议注册一个个人小程序，免费）。
- Moonshot（Kimi）开放平台 API Key：登录 platform.moonshot.cn → API Key 管理 → 创建，并确保账户有余额。

### 2. 导入工程
- 微信开发者工具 → 导入项目 → 选择本目录 → 填入你的 AppID。

### 3. 开通云开发
- 工具栏点「云开发」→ 开通 → 创建环境（如 `florist-prod`），记下**环境 ID**。
- 把环境 ID 填到 `miniprogram/app.js` 的 `globalData.envId`。

### 4. 部署云函数
完整的变量位置、用途、填写格式及生成方法见 [环境变量.md](./环境变量.md)。

- 在工具左侧 `cloudfunctions/analyzeImage` 上右键 → 「上传并部署：云端安装依赖」。
- v1.3 起还必须部署 `cloudfunctions/accessGate`（云端安装依赖）；未部署时「我的」和「上传」都无法取得账号状态。
- `accessGate` 环境变量：
  - `ACCESS_CODES`：直接配置可用校验码及名额，格式如 `1125(10)\A2094(2)`，表示 `1125` 可开通 10 位花艺师，`A2094` 可开通 2 位。支持使用反斜杠、换行、逗号或分号分隔多组配置。
  - `ADMIN_OPENIDS`：可选的管理员微信 openid 名单，多人使用英文逗号分隔；也可通过当前云环境的 `admins.openid` 配置管理员，两种来源任意命中即可，均免校验码。
  - 兼容旧配置：若暂未迁移，代码仍兼容旧的 `ACCESS_CODE_HASH` 单码模式；但推荐尽快切换到 `ACCESS_CODES`，不再需要生成摘要或加密密钥。
- 同步更新部署 `analyzeImage` 和 `imgSecCheck`，两者复用 `accessGate` 身份检查。`accessGate/config.json` 声明 `security.msgSecCheck` 权限，函数超时 60 秒；名字审核须在真实环境验证通过。
- 配置完成后重新部署或更新 `accessGate`，再检查云函数运行日志。
- 作品集补实现当时改变了 `accessGate/adminMaintenance`；前轮标题/描述只需更新部署 `accessGate` 并编译前端，`adminMaintenance` 该轮未改，补实现若未部署仍需更新。标题/描述增量当时无新增环境变量、集合、索引或路由，仅重新编译前端不会更新服务端；本次文档维护不执行部署或发布。
- 本次反馈/关于新增 `feedbackRecords`：先人工创建或核对私有集合并关闭客户端读写，再更新部署 `accessGate`（包含 `feedback.js`）和编译前端。复用 `accessGate/config.json` 的 `security.msgSecCheck`，无新增云函数、索引或环境变量；不能仅编译前端。本次不执行部署、提交、重置或发布，真实审核、集合权限、事务并发、真机及正式版版本读取均未测。
- 进入云开发控制台 → 云函数 `analyzeImage` → 配置 → 环境变量，按提供方配置：
  - 默认 Qwen：`AI_PROVIDER=qwen`（可省略）、`DASHSCOPE_API_KEY`（必填）、`QWEN_MODEL`（可选，默认 `qwen-vl-plus`）。
  - Kimi：`AI_PROVIDER=kimi`、`KIMI_API_KEY`（此模式必填）、`KIMI_MODEL`（可选，默认 `moonshot-v1-32k-vision-preview`）。
  - 使用支持图片输入且账号可调用的模型；只填写 Kimi 密钥不会改变默认 Qwen 提供方。

### 5. 创建数据库集合
云开发控制台 → 数据库，现有集合：
- `records`（标签记录）
- `tags`（标签词库与计数）
- `shareLinks`（本次作品集独立授权，仅业务处理 `type:portfolio`，不覆盖未知历史类型；先核对已有集合再创建，客户端权限 `{"read": false, "write": false}`）
- `feedbackRecords`（本次新增私有反馈，人工创建或核对后配置 `{"read": false, "write": false}`；仅云函数写入，维护人控制台按反馈编号排查，无客户端读写/列表/回复管理）
v1.3 使用 `accessAccounts`（名字、所用校验码、开通时间、撤销与清理状态）；`accessAccounts`、`records`、`tags` **均禁止小程序客户端直接读写**，由云函数访问。自定义权限可配置 `{"read": false, "write": false}`。
管理员可在 `admins` 集合中配置：`openid` 为该管理员真实微信 OPENID（字符串），`name`、`remark` 为可选备注；`_id` 可由数据库自动生成，不用于身份匹配。此集合也必须设置 `{"read": false, "write": false}`，仅控制台或可信服务端维护，不允许用户自助添加管理员。没有额外的启用字段要求，存在匹配记录即授予管理员身份。

先核对现有索引，仅缺失时按下表配置非唯一索引，字段顺序如下。前轮作品集文本及本次反馈均不新增索引；用户提供截图所示已有同 key 索引报 `IndexOptionsConflict` 时直接复用，不删除重建。该截图不代表全部查询索引已验收。

| 集合 | 字段与方向 | 用途 |
| --- | --- | --- |
| accessAccounts | `activated` 升序、`activatedAt` 降序 | 花艺师列表分页 |
| accessAccounts | `cleanupPending` 升序 | 查询待继续清理的账号 |
| admins | `openid` 升序 | 管理员身份匹配 |
| records | `_openid` 升序、`createdAt` 降序 | 本人作品分页 |
| records | `ownerOpenid` 升序、`createdAt` 降序 | 仅有旧归属字段的作品分页 |
| records | `shareToken` 升序、`isPublic` 升序 | 指定作品分享读取 |
| tags | `_openid` 升序 | 本人词库查询 |
| shareLinks | `type` 升序、`token` 升序 | 作品集令牌定位 |
| shareLinks | `type` 升序、`ownerOpenid` 升序、`_id` 升序 | 本人作品集链接元数据键集扫描 |
| records | `_openid` 升序、`_id` 升序 | 作品集本人作品元数据扫描 |
| records | `ownerOpenid` 升序、`_id` 升序 | 作品集历史归属元数据扫描，缺 `_openid` 条件须云端核验 |

已有 `_id`、`_openid` 单字段索引保留。管理员身份来自 `ADMIN_OPENIDS` 或 `admins.openid`，每次请求由云端检查，优先于花艺师开通状态；历史 `floristApplications` 不参与当前角色判断。仅名单环境可不创建 `admins`；若管理员集合读取超时或权限异常，返回身份确认失败，禁止误显示开通表单或放行操作。
作品集 `scan` 每批 100 条按 `_id asc` 扫元数据，返回才内存按 `createdAt desc/_id desc` 排序并游标分页；不为内存排序误建数据库扫描索引。个人 `listRecords` 现有归属/`createdAt desc` 索引仍保留。上表是部署核对清单，不代表已在云端创建；需核对实际 OR/历史归属排除条件、分批 ID 容量及文档/请求大小。`accessAccounts.portfolioVersion` 永久保留，撤销轮换随机版本，重新开通不能重置。
全量扫描成本 O(N)，随后内存排序；公开翻页会重新扫描当前范围，每页 20 件不代表只查询 20 件。大规模性能/容量需云端实测，模拟 1000 件精选 50 页通过不等于生产性能已达标。
若已在 `admins` 添加管理员但「我的」仍要求输码，右键 `cloudfunctions/accessGate` →「上传并部署：云端安装依赖」，确认部署到小程序使用的同一环境，再重新编译并进入「我的」。本次兼容修复只需更新 `accessGate`；若前一轮用户体系尚未部署，仍须按上文同步部署三个函数。
若 `accessGate` 日志出现 `Db or Table not exist: accessAccounts` 或页面提示“账号服务初始化未完成”，表示函数已部署但集合尚未创建。
云存储维持“仅创建者可读写”，新文件位于 `userFiles/<openid SHA-256>/works/` 和 `thumbs/`。旧作品保留原文件路径与归属；已有 `activated:true` 的花艺师免重复输入，未开通旧账号需要校验码。部署更新后，旧的未保存上传队列需清理并重新上传。

### 管理员彻底清空脚本

- 仓库新增云函数 `cloudfunctions/adminMaintenance`，用于管理员批量清空数据库，并删除数据库文档中引用的云存储文件。
- 先部署：右键 `cloudfunctions/adminMaintenance` →「上传并部署：云端安装依赖」。
- 执行预演（推荐先跑一次，只统计各集合文档数）：

```js
wx.cloud.callFunction({
  name: 'adminMaintenance',
  data: { dryRun: true, batchSize: 10 }
}).then(console.log)
```

- 正式执行改为**单次只处理一小批**，避免小程序侧 3 秒调用超时。
- 默认保留 `admins` 集合，可直接在控制台执行下面这段，直到日志打印 `done: true`：

```js
async function wipeAll(includeAdmins = false) {
  const confirm = includeAdmins ? 'WIPE_ALL_DATA_AND_ADMINS' : 'WIPE_ALL_DATA';
  for (;;) {
    const res = await wx.cloud.callFunction({
      name: 'adminMaintenance',
      data: {
        dryRun: false,
        batchSize: 10,
        includeAdmins,
        confirm
      }
    });
    console.log(res.result);
    if (!res.result || !res.result.result || res.result.result.done) break;
  }
}

wipeAll(false);
```

- 若连 `admins` 也要一起清空：

```js
wipeAll(true);
```

- 默认清理 `records`、`tags`、`accessAccounts`、`floristApplications`、`shareLinks`、`florists`，仅在 `includeAdmins: true` 时清理 `admins`。
- 当前默认每次处理 `20` 条文档；若开发者工具里仍报 3 秒超时，建议把 `batchSize` 调成 `10`、`5` 甚至 `1`。
- 若某个集合特别大，也可以只处理单个集合，例如：

```js
wx.cloud.callFunction({
  name: 'adminMaintenance',
  data: {
    dryRun: false,
    collectionName: 'records',
    batchSize: 5,
    confirm: 'WIPE_ALL_DATA'
  }
}).then(console.log)
```

- 该脚本会删除数据库文档，以及该批文档中可追踪到的 `cloud://` 文件引用；仅 `shareLinks.type === 'portfolio'` 只删授权引用、不扫描或删除其引用图片，未知历史类型仍沿用原扫描规则。账号清理须保留授权版本失效依据。微信云开发当前 SDK 不支持按目录枚举云存储，因此不包含完全失联的历史孤儿文件。
- `floristApplications` 属于历史遗留集合，当前版本代码不再读写它，但清库时会一并处理。

### 6. 运行
- 点「编译」即可在模拟器体验；真机预览请用正式 AppID。
- 工程已关闭自动无依赖文件过滤：公共配置 `ignoreUploadUnusedFiles:false`、私有配置 `ignoreDevUnusedFiles:false`，避免新增页面在开发或上传时被误排除。若提示 `WXML file not found: ./pages/about/about.wxml`，先确认打开本工程，关闭并重新打开项目，清除编译缓存后重新编译、上传；不要删除页面注册或重建数据库。页面完整性及模板编译通过不代表完整上传已成功。

## 三、工作机制说明

### 无损存储链路
1. 选图时默认 `sizeType: original`，取相册原图；
2. 原图上传至当前用户目录下的 `works/`，**全程无再压缩、无转码**；
3. 生成 `quality=20` 缩略图上传至同用户目录下的 `thumbs/`，用于审核、AI 分析与列表展示；
4. 缩略图长期保留；删除作品、放弃上传或管理员撤销身份时清理相应文件。
> 「我的 → 原图无损上传」开关可切换为省流模式（上传前高画质压缩，有损，页面会明确提示）。

### 隐私
- 反馈只保存规范化类型/内容/选填手机号、真实用户标识、服务端安全账号快照、白名单版本/设备诊断、请求摘要/内容指纹、服务端时间与 `new` 状态，诊断标记为客户端上报且不用于授权。提交前说明用途并二次确认，反馈不公开，不自动读取手机号或微信个人资料，不存长期敏感草稿；详情见功能说明 2.9～2.10。
- 作品与标签由云函数按账号隔离；持单件令牌只读该作品，持作品集令牌只读授权全部/精选范围。`all` 自动纳入新增作品（含附加图、未开单件分享作品），`selected` 固定所选 ID；停一种分享不关闭另一种。管理员能看到花艺师名字、校验码和开通时间，并可撤销及清理。
- 作品集默认 20 件稳定游标分页及当前总数，精选提交上限 1000 件（含重复项）、去重 ID 的 UTF-8 JSON 上限 128 KiB，超限拒绝不截断。`portfolio-share?portfolioToken=` 进入只读页，再次显示刷新重鉴权；`detail?id=&portfolioToken=` 只读授权详情，原图重新鉴权。停止/删除/撤销阻断新请求，已下载图片及仍有效临时 URL 无法收回。名字复用已有审核，不新增名片/大厅；既有图片审核和退出清理缺口未因此修复。
- 创建后在有效本人卡片「编辑标题与描述」：两字段 trim，标题 1～40 Unicode 码点单行，描述 0～300、可清空且保留内部换行，超限拒绝不截断。完整标题及非空描述经 `security.msgSecCheck` 明确 pass 方写，审核在事务外，`userWrite` 内重新授权后原子写文本/时间；审核期间停止/撤销不能复活链接，管理员不能代改。取消不写、失败保留输入、防重复，身份失效清草稿，隐藏/卸载隔离旧请求。
- 新增 `updatePortfolioMetadata` action/API，本人列表增 `title/description/updatedAt`，公开列表增 `title/description`；不改 token、范围、createdAt、enabled 或授权版本，不影响排序/其他链接。旧/异常文本安全回退，不批量迁移。微信卡片无独立描述字段，已发送卡片标题不保证追溯更新；原链接重开/刷新可读取新文本，云端真实审核、双账号、真机和正式转发未测。
- API Key 仅在云函数环境变量中，前端代码与安装包中均不包含；
- 上线发布时记得在小程序后台「用户隐私保护指引」中声明：使用相册、上传图片。

## 四、常见问题

| 现象 | 排查 |
|---|---|
| 分析失败：未配置 KIMI_API_KEY | 云函数环境变量没配或没重新部署 |
| 分析失败：401 / 余额不足 | 检查 Moonshot Key 是否有效、账户是否欠费 |
| 图片不显示 | 检查 accessGate 已更新、账号有权限、文件存在及云存储创建者权限；确认 envId 正确 |
| 云函数超时 / 分析较慢 | 耗时取决于图片、模型、网络与平台负载；云函数运行超时建议 60 秒，模型请求超时 55 秒。查看 `analyzeImage timing` 日志区分下载与模型耗时；`qwen3.7-flash` 可关闭思考 |
| 真机无法上传 | 测试号不支持云开发，请用正式 AppID |
| 「我的」或「上传」显示无法确认账号 | 先确认开发工具登录仍有效、项目云环境正确、`accessGate` 已部署且 `accessAccounts` 已创建；不要把连接错误当成校验码错误 |
| `admins` 中已有管理员，但「我的」仍要求校验码 | 更新部署 `accessGate`，确认 `admins.openid` 与真实微信 OPENID 一致、云环境与 `envId` 一致；随机文档 `_id` 或 `_openid` 不作为管理员身份 |
| 页面提示“账号服务初始化未完成” | 进入云开发控制台创建 `accessAccounts` 集合，再重新调用 `accessGate`；必要时同步补建 `activated + activatedAt` 组合索引 |
| 添加索引报 `IndexOptionsConflict`，提示相同 key 索引已存在 | 直接复用既有同 key 索引，不删除重建；核对现有定义与真实查询，本轮文本字段不需要新索引 |
| 作品集文本审核未通过或服务不可用 | 保留输入并修改/重试，核对目标环境 `accessGate` 版本与已有 `security.msgSecCheck` 权限；不靠新增环境变量跳过审核，真实审核尚未验收 |
| 反馈服务初始化未完成 | 维护人员在同一环境核对 `feedbackRecords`、账号集合及 `accessGate` 部署；反馈集合规则必须 `read:false/write:false`，不要开放客户端权限 |
| 反馈提交失败或结果未确认 | 保留本页输入并重试，未确认成功的相同规范化内容沿用请求标识；无客户端反馈列表，成功编号供维护人控制台定位，不承诺回复时限 |
| 关于页显示本地基线或未知版本 | 未取到有效版本明确本地构建/产品基线 v1.5.0；实际未知版本显示暂无记录，不把开发更新冒充正式版历史 |
| 控制台出现 `ECONNREFUSED 127.0.0.1:7897` | 当前本地代理端口没有服务监听；如无需代理，在开发工具的代理设置中切换直连，再重新登录并重试云环境连接 |

部署后验收：管理员无需输码；其他用户填名字和有效码成为花艺师，退出再进入免输码；管理员可查看原码及时间；开启单件分享后由另一账号只读打开；撤销后旧链接失效且关联文件清空；清理失败可继续；管理员和其他花艺师的数据不受影响。当前仅完成本地模拟回归，尚未宣称真实环境验收通过。

## 五、成本参考
- 云开发：个人用量（千级图片）基本在免费额度内；
- Kimi API：按 token 计费，每张图片一次分析调用，单张成本约几分钱量级（以平台实时价格为准）。
