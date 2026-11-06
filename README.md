# 花艺图库 · 花艺师图片标签整理小程序

上传作品照片 → 视觉模型自动生成「颜色 / 花材（主花·辅花·叶材）/ 种类 / 风格 / 用途」五维标签 → 按标签组合筛选历史作品。

- 原图**无损**存入云存储；AI 分析使用长期保存的缩略图，与作品列表共用
- AI 密钥只放在云函数环境变量里，小程序前端不包含任何密钥
- 无需独立登录，云函数按 openid 判定管理员、花艺师、其他用户并隔离数据

## 一、项目结构

```
florist-tags/
├── project.config.json          # 工程配置
├── miniprogram/                 # 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── utils/
│   │   ├── tagdict.js           # 标签词库（颜色/种类/风格/用途枚举、常见花材）
│   │   └── api.js               # 云存储/云函数/数据库封装
│   └── pages/
│       ├── index/               # 作品墙（Tab）
│       ├── filter/              # 标签筛选（Tab）
│       ├── upload/              # 上传（Tab）
│       ├── my/                  # 我的：校验码开通、名字、统计、管理员花艺师列表与撤销
│       ├── confirm/             # AI 标签确认页
│       ├── detail/              # 作品详情（查看/编辑/删除）
│       └── tags/                # 标签管理
└── cloudfunctions/
    ├── accessGate/              # 用户体系、作品/词库、管理员清理、单件分享
    ├── imgSecCheck/             # 图片内容审核
    └── analyzeImage/            # Qwen / Kimi 视觉模型打标
```

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
- 进入云开发控制台 → 云函数 `analyzeImage` → 配置 → 环境变量，按提供方配置：
  - 默认 Qwen：`AI_PROVIDER=qwen`（可省略）、`DASHSCOPE_API_KEY`（必填）、`QWEN_MODEL`（可选，默认 `qwen-vl-plus`）。
  - Kimi：`AI_PROVIDER=kimi`、`KIMI_API_KEY`（此模式必填）、`KIMI_MODEL`（可选，默认 `moonshot-v1-32k-vision-preview`）。
  - 使用支持图片输入且账号可调用的模型；只填写 Kimi 密钥不会改变默认 Qwen 提供方。

### 5. 创建数据库集合
云开发控制台 → 数据库，现有集合：
- `records`（标签记录）
- `tags`（标签词库与计数）
v1.3 使用 `accessAccounts`（名字、所用校验码、开通时间、撤销与清理状态）；`accessAccounts`、`records`、`tags` **均禁止小程序客户端直接读写**，由云函数访问。自定义权限可配置 `{"read": false, "write": false}`。
管理员可在 `admins` 集合中配置：`openid` 为该管理员真实微信 OPENID（字符串），`name`、`remark` 为可选备注；`_id` 可由数据库自动生成，不用于身份匹配。此集合也必须设置 `{"read": false, "write": false}`，仅控制台或可信服务端维护，不允许用户自助添加管理员。没有额外的启用字段要求，存在匹配记录即授予管理员身份。

在“索引管理 → 添加索引”配置以下非唯一索引，字段顺序如下：

| 集合 | 字段与方向 | 用途 |
| --- | --- | --- |
| accessAccounts | `activated` 升序、`activatedAt` 降序 | 花艺师列表分页 |
| accessAccounts | `cleanupPending` 升序 | 查询待继续清理的账号 |
| admins | `openid` 升序 | 管理员身份匹配 |
| records | `_openid` 升序、`createdAt` 降序 | 本人作品分页 |
| records | `ownerOpenid` 升序、`createdAt` 降序 | 仅有旧归属字段的作品分页 |
| records | `shareToken` 升序、`isPublic` 升序 | 指定作品分享读取 |
| tags | `_openid` 升序 | 本人词库查询 |

已有 `_id`、`_openid` 单字段索引保留。管理员身份来自 `ADMIN_OPENIDS` 或 `admins.openid`，每次请求由云端检查，优先于花艺师开通状态；历史 `floristApplications` 不参与当前角色判断。仅名单环境可不创建 `admins`；若管理员集合读取超时或权限异常，返回身份确认失败，禁止误显示开通表单或放行操作。
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

- 该脚本会删除数据库文档，以及该批文档中可追踪到的 `cloud://` 文件引用；微信云开发当前 SDK 不支持按目录枚举云存储，因此不包含完全失联的历史孤儿文件。
- `floristApplications` 属于历史遗留集合，当前版本代码不再读写它，但清库时会一并处理。

### 6. 运行
- 点「编译」即可在模拟器体验；真机预览请用正式 AppID。

## 三、工作机制说明

### 无损存储链路
1. 选图时默认 `sizeType: original`，取相册原图；
2. 原图上传至当前用户目录下的 `works/`，**全程无再压缩、无转码**；
3. 生成 `quality=20` 缩略图上传至同用户目录下的 `thumbs/`，用于审核、AI 分析与列表展示；
4. 缩略图长期保留；删除作品、放弃上传或管理员撤销身份时清理相应文件。
> 「我的 → 原图无损上传」开关可切换为省流模式（上传前高画质压缩，有损，页面会明确提示）。

### 隐私
- 作品与标签由云函数按账号隔离；主动开启分享后，持令牌的人只能读取指定作品；管理员能看到花艺师名字、使用的校验码和开通时间，并可撤销权限及清理其作品。
- API Key 仅在云函数环境变量中，前端代码与安装包中均不包含；
- 上线发布时记得在小程序后台「用户隐私保护指引」中声明：使用相册、上传图片。

## 四、常见问题

| 现象 | 排查 |
|---|---|
| 分析失败：未配置 KIMI_API_KEY | 云函数环境变量没配或没重新部署 |
| 分析失败：401 / 余额不足 | 检查 Moonshot Key 是否有效、账户是否欠费 |
| 图片不显示 | 检查 accessGate 已更新、账号有权限、文件存在及云存储创建者权限；确认 envId 正确 |
| 云函数超时 | 单张分析正常 3-8 秒；在云函数配置里把超时时间调到 60 秒 |
| 真机无法上传 | 测试号不支持云开发，请用正式 AppID |
| 「我的」或「上传」显示无法确认账号 | 先确认开发工具登录仍有效、项目云环境正确、`accessGate` 已部署且 `accessAccounts` 已创建；不要把连接错误当成校验码错误 |
| `admins` 中已有管理员，但「我的」仍要求校验码 | 更新部署 `accessGate`，确认 `admins.openid` 与真实微信 OPENID 一致、云环境与 `envId` 一致；随机文档 `_id` 或 `_openid` 不作为管理员身份 |
| 页面提示“账号服务初始化未完成” | 进入云开发控制台创建 `accessAccounts` 集合，再重新调用 `accessGate`；必要时同步补建 `activated + activatedAt` 组合索引 |
| 控制台出现 `ECONNREFUSED 127.0.0.1:7897` | 当前本地代理端口没有服务监听；如无需代理，在开发工具的代理设置中切换直连，再重新登录并重试云环境连接 |

部署后验收：管理员无需输码；其他用户填名字和有效码成为花艺师，退出再进入免输码；管理员可查看原码及时间；开启单件分享后由另一账号只读打开；撤销后旧链接失效且关联文件清空；清理失败可继续；管理员和其他花艺师的数据不受影响。当前仅完成本地模拟回归，尚未宣称真实环境验收通过。

## 五、成本参考
- 云开发：个人用量（千级图片）基本在免费额度内；
- Kimi API：按 token 计费，每张图片一次分析调用，单张成本约几分钱量级（以平台实时价格为准）。
