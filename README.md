# 王者插件 · 营地ID 共享库（服务端）

一个自建的「QQ → 营地ID」共享池。用户在 A 群的机器人上绑过营地ID，到 B 群另一个 bot
的机器人上发 `#查询战绩` 时就不用重新绑定。

**这是一个参考实现，不是公共服。** 插件里默认不填任何地址，想用就自己搭一个，
或者用朋友已经搭好的。自己的库自己管：谁能接、数据留多久、要不要公开，都由搭的人决定。

> 本分支（`server`）是 [GloryOfKings-Plugin](https://github.com/cchanlan/GloryOfKings-Plugin)
> 仓库里**只含服务端**的分支，根目录就是这个项目本身，可以脱离插件独立克隆部署：
>
> ```bash
> git clone --depth 1 -b server https://gitcode.com/ccxhan/GloryOfKings-Plugin.git gok-share-server
> ```

---

## 先读这一节：它保护什么、不保护什么

把话说明白比什么都重要，免得用户以为这库是「加密保险箱」。

| | 说明 |
|---|---|
| **能防** | 数据库文件被单独拖走。库里只有 `HMAC-SHA256(盐, QQ)`，没有明文 QQ |
| **防不了** | 拿到 token 的接入方，用群成员表里的 QQ 逐个查。QQ 号不是秘密，哈希挡不住这条 |
| **也防不了** | 盐和数据库被一起拿走。QQ 空间现实中是 10⁹ 量级，有盐就是分钟级暴力破解 |
| **所以** | 盐必须和备份分开存，绝不能跟着 db 一起进备份包 |

另外两个设计上的取舍，也要一并告诉用户（插件端的 README 里写了一遍）：

- **共享数据会落到对方本机**。查询时拿到的那份会写进对方的 `UserData.yaml`（带来源标记），
  所以「只有查询指令认」这句已经不成立了 —— 落下来之后排行榜、推送那些读本机绑定的地方也都认。
  代价是按需落地：没人查过的号不会主动同步过去。
- **撤销几乎立刻生效**。别的机器人那边几秒后（下次查询时）就看不到你的数据了。

被冒名共享的人（有人拿他的 QQ 传了个不属于他的营地ID）可以找管理员用
`POST /api/v1/admin/binds/delete` 强制删掉——这个出口必须有，否则「共享即公开」
这句话就不成立。

---

## 环境要求

- **Node.js ≥ 24**。用到内置的 `node:sqlite`，低版本没有这个模块（22.x 要开实验开关且 API 未定型）
- **零 npm 依赖**，不需要 `npm install`
- 单实例部署。限流计数在进程内存里，PM2 cluster 模式会按 worker 数放宽

---

## 快速开始

> **装了云崽插件的人不用看这一节**：私聊发一句 `#营地共享库部署`，插件会自动把本分支
> 克隆到 `<云崽根>/gok-share-server/`，下面这些步骤（查 Node 版本、拉代码、生成密钥、
> 写配置、起进程、签发令牌）它会一次做完，还会把令牌私聊给你。
> 配套的 `#营地共享库状态` 看运行情况、`#营地共享库卸载` 停掉服务。
>
> 这份文档是给**手工部署**、或者想把服务端搬到另一台机器上跑的人看的。

```bash
# 三个源任选一个，内容完全一样（推荐国内的 gitcode 或 gitee）
git clone --depth 1 -b server https://gitcode.com/ccxhan/GloryOfKings-Plugin.git gok-share-server
# 也可以换成 gitee.com/longhengmu/GloryOfKings-Plugin.git 或 github.com/cchanlan/GloryOfKings-Plugin.git
cd gok-share-server

# 1. 生成两把密钥。它们必须不同，程序会检查
export GOK_SALT=$(openssl rand -hex 32)
export GOK_ADMIN_SECRET=$(openssl rand -hex 32)

# 2. 先把它们存好（只要这两行，别带 export）
cat > /etc/gok-share.env <<EOF
GOK_SALT=$GOK_SALT
GOK_ADMIN_SECRET=$GOK_ADMIN_SECRET
EOF
chmod 600 /etc/gok-share.env

# 3. 起服务
node bin/start.mjs
```

默认监听**所有网卡**（IPv4 和 IPv6 都通）。在**服务器防火墙**和**云主机安全组**放行 8787 端口，
外面就能直接连，不用先折腾反代。

> ⚠️ 这样跑的是**明文 HTTP**，令牌会明文过网络。想避免就在前面配个 HTTPS 反代
> （见下面「可选」那一节），配完把 `GOK_HOST` 改成 `127.0.0.1` 就不会再对外裸着。

### 用 pm2 常驻

```bash
pm2 start bin/start.mjs --name gok-share --interpreter node --env-from-file /etc/gok-share.env
pm2 save
```

（pm2 不认识 `.mjs`，`--interpreter node` 不能省。）

### 用 systemd

```ini
# /etc/systemd/system/gok-share.service
[Unit]
Description=GloryOfKings 营地ID共享库
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gok-share-server
EnvironmentFile=/etc/gok-share.env
ExecStart=/usr/bin/node bin/start.mjs
Restart=always
RestartSec=5
# 密钥在环境里，别让普通用户读到进程环境
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

---

## 可选：配 HTTPS 反代

> 不配也能用 —— 默认就监听所有网卡，放行防火墙端口即可。这一节是给**想走 HTTPS**
> 或者已经有域名的人看的。

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    # 请求体很小，卡死上限防滥用
    client_max_body_size 128k;
}
```

> **⚠️ 反代场景必读**：服务在**监听回环**时会**自动信任** `X-Forwarded-For`
> （不这样，所有请求的来源 IP 都变成反代那一个，按 IP 的限流会退化成全局限流，
> 一个 120 次/分钟的桶会把整个服务卡死）。所以配反代时记得把 `GOK_HOST` 改成 `127.0.0.1`，
> 信任逻辑会自动跟上。
>
> 反过来，监听 `0.0.0.0` 直连公网时默认**不信任**这个头——不然谁都能伪造它绕过限流。
> 想手动指定就设 `GOK_TRUST_PROXY=1` 或 `0`。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GOK_SALT` | **必填** | QQ 哈希用的盐，≥32 字符。缺了直接拒绝启动 |
| `GOK_ADMIN_SECRET` | **必填** | 管理接口的钥匙，≥32 字符，且不能和 `GOK_SALT` 相同 |
| `GOK_HOST` | 空（所有网卡） | 监听地址。留空 = 绑双栈地址，IPv4/IPv6 都能连；配了反代想只给本机用就设 `127.0.0.1`。⚠️ 别填 `0.0.0.0`，那只开 IPv4 |
| `GOK_PORT` | `8787` | 监听端口 |
| `GOK_DB` | `./data/share.db` | SQLite 文件路径 |
| `GOK_TRUST_PROXY` | 跟随监听地址 | 是否信任 `X-Forwarded-For` |
| `GOK_READ_COOLDOWN_MS` | `10000` | 同一 client 重复查同一 QQ 的响应冷却，只用来防抖，`0` = 关闭 |
| `GOK_IP_RATE_PER_MINUTE` | `120` | 单个来源 IP 每分钟请求数。多个 bot 共用出口 IP（NAT/反代后）时调大 |
| `GOK_IP_BURST` | `60` | 单 IP 的突发额度 |
| `GOK_PUBLIC_URL` | 空 | 只用于展示，服务本身不依赖 |

---

## 签发 token

一个 bot 主人一个 token。**明文 token 只在签发响应里出现这一次**，之后管理面只能看到前缀。

```bash
ADMIN=<你的 GOK_ADMIN_SECRET>
BASE=http://127.0.0.1:8787

# 签发
curl -s $BASE/api/v1/admin/tokens \
  -X POST -H "X-Admin-Secret: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"某某的机器人","quotaPerDay":2000,"writePerHour":60}'
# → {"ok":true,"id":1,"token":"gok_1_xxxx","tokenPrefix":"gok_1_xxxx",...}

# 列出（不含 token 材料）
curl -s $BASE/api/v1/admin/tokens -H "X-Admin-Secret: $ADMIN"

# 吊销
curl -s $BASE/api/v1/admin/tokens/1 -X DELETE -H "X-Admin-Secret: $ADMIN"

# 轮换（旧 token 立即失效，返回新的）
curl -s $BASE/api/v1/admin/tokens/1/rotate -X POST -H "X-Admin-Secret: $ADMIN"

# 统计
curl -s $BASE/api/v1/admin/stats -H "X-Admin-Secret: $ADMIN"

# 按明文 QQ 强制删除（给被冒名的人用）
curl -s $BASE/api/v1/admin/binds/delete \
  -X POST -H "X-Admin-Secret: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"qq":"2606138772"}'
```

拿到 token 后，让 bot 主人填进插件配置（`#设置营地共享库令牌 <token>` 或锅巴面板）。

---

## 接口一览

除 `/api/v1/health` 外都要 `Authorization: Bearer <token>`。
**token 不走 query 传参，QQ 只在 POST body 里出现**——放 URL 会落进反代的 access log。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/health` | 存活检查。**不返回任何计数**（库多大是运维信息） |
| `PUT` | `/api/v1/bind` | `{"qq","campIds":[],"current"}`，上传**本实例**对该 QQ 的全量绑定 |
| `DELETE` | `/api/v1/bind` | `{"qq"}`，撤销共享（全局删除 + 留墓碑） |
| `POST` | `/api/v1/bind/query` | `{"qq","since"}`，查询；`since` 命中未变更时回 `{"unchanged":true}` |

### 上传是「本实例的全量」，不是「追加」

这是多实例场景下唯一说得通的口径：

- 用户在 bot A 绑了 `1234`、在 bot B 绑了 `5678`，两个实例各传各的，**谁都不覆盖谁**
- 用户在 bot A 上删掉一个号 → bot A 传剩下的那组 → 只影响 bot A 贡献的记录
- 查询返回的是所有实例的**并集**，所以用户在哪儿绑的号都能用

`campIds: []` 会回 422。撤销有专门的 `DELETE`，两者混在一起会让「在本实例删光绑定」
误伤别的实例贡献的记录。

---

## 运维

**备份**：db 用 WAL 模式，热备要连 `-wal` 一起拿：

```bash
sqlite3 data/share.db ".backup /path/to/backup-$(date +%F).db"
```

`GOK_SALT` **必须和备份分开存放**。放一起等于没加盐。

**自动清理**：服务每天自己跑一次，删 180 天没更新的绑定、30 天前的审计。
想改周期只能改代码里的 `setInterval`。

**审计表**只记动作和 QQ 摘要，不记明文（`detail` 字段写死不含 QQ 和营地ID）。

---

## 已知边界

- **限流计数在内存里**，所以只能单实例。要开 cluster 得换成 Redis，
  或者把按 IP 那层删掉、只留数据库里的日配额（那份是按 client 算的，cluster 下依然准）
- **没有「列出」接口**。服务端只存哈希，回答不了「库里都有谁」。
  这是哈希存储的必然代价，也是跨实例排行榜类功能做不了的原因
- 批量查询接口（`/api/v1/bind/batch`）在计划里但**没有实现**，默认也不打算实现：
  它是刻意的枚举面，开口子等于把「拿群成员表刷库」变得更容易
