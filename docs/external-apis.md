# 外部数据源实测契约（Lead 亲测，非文档抄录）

记录本项目中**实际验证过**的外部 API 行为。所有条目都由真实 HTTP 请求确认。

测试时间：2026-10-15
测试工具：`Invoke-WebRequest`

---

## 1. NextMoe·未萌 API v2（主力数据源）✅

**Base URL**：`https://api.nextmoe.dev/v2`

### 为什么用它
用户原本要求接 VNDB + KunGal + Bangumi 三个源。实测发现：

- `kungal.com/api/*` 全部返回 `401 {"code":205,"message":"用户登录失效"}` —— **KunGal 没有公开 API**，只有论坛会话接口。
- KunGal 的 Galgame 数据实际由 **NextMoe API** 提供（来源：KunGal 论坛帖 topic/4456，以及响应中 `claim.site = "kungal"`）。
- NextMoe 把 **六个源**（VNDB / Bangumi / DLsite / ErogameScape / Ci-en / Getchu）对齐成一条记录。

→ 所以一个 NextMoe 就同时覆盖了 VNDB + Bangumi + KunGal 的数据需求。

### 鉴权（实测）
| 方式 | 额度 | 是否需要注册 |
|---|---|---|
| 匿名（按 IP） | 30 次/分、1,000 次/天 | 否 |
| 应用密钥 `nmk_` | 60 次/分、50,000 次/天 | 否，控制台自助铸造 |

匿名的响应与带密钥时**逐字节相同**。

### 署名要求（官方文档明确要求）
> 目前阶段使用 NextMoe·未萌 API，可以将 API 的名字标记为『鲲 Galgame 论坛』（如果你使用 Galgame 数据）

**本项目界面上标注数据来源时必须写「鲲 Galgame 论坛」。**

### 实测可用的端点

#### 列表 / 搜索
```
GET /v2/catalog/works?limit=2
GET /v2/catalog/works?q=CLANNAD&limit=2
```
响应：
```json
{
  "object": "list",
  "items": [ { "object":"work", "id":"86", "display_name":"クラナド",
               "release_date":"2004-04-28", "cover": {"url":"https://..."},
               "claim": {"site":"kungal","site_work_id":"4"} } ],
  "next_cursor": "cur_..."
}
```
注意：端点返回裸 item，**没有 `{code,message,data}` 外壳**；`id` 是**字符串**；翻页只用 `next_cursor`。

#### 详情
```
GET /v2/catalog/works/86
GET /v2/catalog/works/86?include=titles,ratings,tags,covers,companies
```

#### 评价（多源评分）
```
GET /v2/catalog/works/86/ratings
```
返回多源评分，实测 CLANNAD (id=86)：
| source | score | vote_count | 量纲 |
|---|---|---|---|
| vndb | 8.72 | 11487 | 0-10 |
| bangumi | 8.9 | 6513 | 0-10 |
| erogamescape | 90 | 3298 | 0-100 |
| nextmoe | 8.5 | 11 | 0-10 |
| howlongtobeat | 88 | 134 | 0-100 |

⚠️ **量纲不统一**：vndb/bangumi/nextmoe 是 0-10，erogamescape/howlongtobeat 是 0-100。映射到本项目的 `games.rating`（0-10，保留小数）时必须先归一化。

#### 标签
```
GET /v2/catalog/works/86/tags
```
返回 `{id, display_name, source, tier, tag_kind, spoiler, is_sexual, work_count}`。
实测含「家族」「催泪弹」「key」「麻枝准」等，`source` 为 bangumi。

⚠️ 部分项的 `id` 为 `null`（来源站没有稳定 id），入库时要能处理。

### include 参数（重要陷阱）
`include=` 展开的块，其**形状与独立子资源端点不同**：

- 独立端点 `works/86/ratings` → `{object:"list", items:[...]}`
- `include=ratings` → **裸数组** `[{source:...},{...}]`，**没有 `items`**

实测：`?include=ratings,tags` 返回的 `ratings` 是 `System.Object[]`（裸数组），`.items` 为 `null`。
→ 代码里必须两种形状都能解析。

`include` 的可用 token 因面而异：详情面 18 个（`titles refs relations credits releases popularity ratings tags playtimes series platforms intros covers screenshots characters companies engines links`），列表面只有 8 个。

未知 token 返回 `400`，**不会静默忽略**。

### 用外部 id 反查（消灭 N+1）
```
GET /v2/catalog/works?refs=vndb:v19658,bangumi:302835&include=covers
```
- 一次最多 100 个，超了 `400 TOO_MANY_IDS`
- 不存在/被挡的键回在 `missing[]` 里，不会整体 404

### 自省端点（带密钥也不需要）
```
GET /v2/catalog/schemas/work     # 该族可用的 include / fields 词表
GET /v2/catalog/openapi.json     # 完整 OpenAPI（实测 693KB）
```

---

## 2. VNDB Kana API ✅

**Endpoint**：`https://api.vndb.org/kana`

- 查询用 **POST**，body 是 JSON
- 无需鉴权
- 限流：200 请求 / 5 分钟
- 官方要求：**User-Agent 必须标识应用**

```bash
POST https://api.vndb.org/kana/vn
{"filters":["search","=","CLANNAD"],"fields":"id,title,alttitle,image.url,rating,votecount,tags{id,name,rating},developers{id,name},released,description","results":5}
```

常用 filters：`search` / `id` / `lang` / `released` / `rating` / `tag` / `developer`
常用 fields：`id title alttitle titles{lang,title,latin} aliases olang released image.url image.thumbnail rating average votecount length length_minutes description tags{id,name,rating,spoiler} developers{id,name} screeshots{url}`

注意：
- `rating` 与 `average` 是 **0-100** 数值（本项目除以 10，保留来源精度）
- `tags` 只在**直接**应用时返回，不含父标签
- 描述 `description` 可能含 VNDB 私有格式标记，需要清洗

---

## 3. Bangumi API v0 ✅

**Endpoint**：`https://api.bgm.tv/v0`

- 无需鉴权（公开读）
- **User-Agent 必须设置**，否则可能被拒

### 实测可用的两个端点

**搜索（POST）**
```
POST https://api.bgm.tv/v0/search/subjects?limit=2
{"keyword":"CLANNAD","filter":{"type":[4]}}
```
`type: 4` = 游戏。实测返回 CLANNAD，含 `images.large`、`date`、`summary`。

**详情（GET）**
```
GET https://api.bgm.tv/v0/subjects/13
```
实测返回：
```
name      : CLANNAD
name_cn   : (空)
date      : 2004-04-28
rating    : 8.9 (6516 votes)     ← 0-10 量纲，正好匹配本项目
tags      : key, CLANNAD, Galgame, 麻枝准, 催泪弹
image     : https://lain.bgm.tv/pic/cover/l/c5/1c/13_tQxwM.jpg
infobox   : 21 条
```

注意：
- `rating.score` 是 **0-10** 浮点，与本项目 `games.rating` 量纲一致，直接保留小数，不做四舍五入。
- `name_cn` 经常为空，不能假设有中文名
- `infobox` 是键值数组，含 developer/开发、发行日期等，需要按 key 取

---

## ⚠️ NextMoe 的三个实测陷阱

这三条都是**编译不会报错、只有真机请求才会暴露**的类型，全部由 `src-tauri/src/metadata/live_tests.rs` 的联网测试抓出。

### 陷阱 1：`include=titles` 在集合面上无效

文档把 `titles` 列进了集合面的 include 词表，但**实测集合面根本不返回它**：

| 请求 | `titles` | `ratings` | `tags` |
|---|---|---|---|
| `?ids=86&include=titles,ratings,tags` | **缺失** | 5 | 101 |
| `?refs=vndb:v4&include=…` | **缺失** | 5 | 101 |
| `?q=CLANNAD&limit=1&include=…` | **缺失** | 5 | 101 |
| `/works/86?include=titles,ratings,tags` | **7 条** | 5 | 101 |

**影响**：集合面拿不到中文名，而中文名正是用 NextMoe 的主要理由。
`display_name` 只是**有时**是中文 —— CLANNAD 返回的是日文「クラナド」，而命运石之门返回的就是中文。

**对策**：`nextmoe::detail_by_ref` 走**两步** —— 先用 `refs=` 解析出 NextMoe 的 work id，再调详情面取 `titles`。

### 陷阱 2：`include=` 展开的块，形状与独立端点不同

同一个逻辑字段，取决于请求方式，envelope 不一样：

- 独立端点 `works/86/ratings` → `{object:"list", items:[...]}`
- `?include=ratings` → **裸数组** `[{source:...}]`，**没有 `items`**

代码里必须两种都能解析（见 `RatingsField` / `TagsField` 的 `#[serde(untagged)]`）。
第一版按 `.items` 取值，实测拿到空数组才发现。

### 陷阱 3：NextMoe 覆盖率有限（约 27%）

用 VNDB 票数最高的 30 部实测，NextMoe **只认得 8 部**：

```
命运石之门 / シュタインズ・ゲート ゼロ / クラナド / 心跳文学部 /
planetarian / Rewrite / 極限脱出 9時間9人9扉 / 海猫鸣泣之时散
```

所以 `refs=` 反查**返回空是常态、不是错误**，必须静默降级（`Ok(None)`），不能报错打断流程。

反过来说，这 8 部都带来了 VNDB 没有的**中文名**，这正是三源互补的价值所在。

---

## 待办（阶段 2 起）

- [x] 评分归一化：统一到 0-10 并保留小数精度，多源时优先 Bangumi/VNDB
- [x] 多源合并：中文名优先、标签大小写不敏感去重、评分跨源择优
- [ ] 前端元数据搜索/匹配对话框
- [ ] 封面下载到本地缓存（前端调用 `metadata_cover_cache`）

---

## 已就绪的基础设施

### HTTP（已接入，走 Rust 侧）

依赖：`reqwest`（Cargo.toml），实现在 `src-tauri/src/metadata/`。

**为什么在 Rust 侧发请求，而不是前端 `fetch`**：
1. **绕开 CORS** —— WebView 里 fetch 第三方 API 会被同源策略挡
2. **能设 User-Agent** —— VNDB 与 Bangumi 都强制要求标识应用的 UA，浏览器 JS 改不了这个头

**`tauri-plugin-http` 已被移除**（曾短暂接入）。它只在**前端**发 HTTP 时才需要，而我们全部请求都在 Rust 侧，所以：

- 它是纯死依赖（`grep plugin-http src/` 零命中）
- 它引入 `http:default` ACL origin 白名单，而 Rust `reqwest` **完全不经过 ACL** —— 那份白名单是死配置
- 它制造了一个只在 `tauri build` 才报的版本耦合失败模式（见下节），而我们已经被它卡过一次

需要重新引入的唯一场景是「前端自己调 HTTP」。届时记得同时补 `http:default` 的 origins，否则运行时被 ACL 拒绝而**编译不报错**。

### 我们实际访问的外部主机

```
https://api.nextmoe.dev/*            六源对齐数据（主力）
https://api.vndb.org/*               VNDB Kana
https://api.bgm.tv/*                 Bangumi API v0
https://lain.bgm.tv/*                Bangumi 封面 CDN
https://image.kungal.iloveren.link/* NextMoe / KunGal 封面 CDN
```

封面**不直接在前端加载**，而是用 `metadata_cover_cache` 下载到游戏目录后走 asset 协议显示，这样离线也有图。

### ⚠️ Tauri 插件版本必须 Rust/npm 对齐
`tauri build` 会强校验 Rust crate 与 npm 包的 major/minor 是否一致，不一致直接拒绝出包：
```
Found version mismatched Tauri packages.
tauri-plugin-sql (v2.6.0) : @tauri-apps/plugin-sql (v2.5.0)
```
**这个检查只在 `tauri build` 阶段发生** —— `cargo check` 和 `tsc` 全都不会报。
加新插件时务必两边同时升到同一版本。这也是移除 `plugin-http` 的一个附带好处：少一组要对齐的版本。

### 联网验证怎么做

`src-tauri/src/metadata/live_tests.rs` 里有 9 个 `#[ignore]` 的真机测试。默认不跑（需要网络 + 会消耗 VNDB 限流额度）。手动跑：

```powershell
cargo test --lib live_tests -- --ignored --nocapture --test-threads=1
```

**它们不是可选的锦上添花** —— 上面那三个陷阱全是它们抓出来的，`cargo check` 和单元测试都发现不了。
