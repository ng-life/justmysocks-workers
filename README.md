# justmysocks-workers

运行在 Cloudflare Workers 上的 Just My Socks 订阅转换服务。服务从 Just My Socks 获取 Clash 订阅和流量信息，并提供 Clash、Quantumult X 与 Loon 格式的订阅接口。

## 功能

- `GET /clash`：返回原始 Clash YAML 订阅
- `GET /quanx`：返回 Quantumult X 节点订阅
- `GET /loon`：返回 Loon 节点订阅
- `GET /api/subscription`：返回总量、已用、剩余流量和下次重置时间
- `GET /healthz`：存活检查
- 支持 Clash 中的 `ss`、`vmess`、`vless`、`trojan`、`http` 和 `socks5` 节点
- 订阅响应包含标准 `subscription-userinfo` 响应头
- 支持 `noss`、`novless`、`exclude` 和 `usedomains` 等 Just My Socks 订阅参数
- 可选 Token 鉴权
- 使用 Cloudflare Cache API 缓存上游结果

## 本地开发

需要 Node.js 22 或更高版本。

```bash
npm install
npm run types
npm test
npm run typecheck
npm run dev
```

如需在本地启用访问鉴权：

```bash
cp .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars` 中的 `ACCESS_TOKEN`。`.dev.vars` 已加入 `.gitignore`，不要提交真实令牌。

## 缓存

上游 Clash 订阅和流量结果存入 `caches.default`：

- 默认 10 分钟内直接返回缓存结果
- 刷新失败时，可返回获取时间不超过 1 小时的旧数据
- 刷新失败后的 30 秒内不重复访问上游
- 响应通过 `X-Cache-Clash` 和 `X-Cache-Traffic` 暴露 `HIT`、`MISS` 或 `STALE` 状态

缓存时间可在 `wrangler.jsonc` 中调整：

```json
{
  "vars": {
    "CACHE_FRESH_TTL_SECONDS": "600",
    "CACHE_STALE_TTL_SECONDS": "3600",
    "CACHE_FAILURE_COOLDOWN_SECONDS": "30"
  }
}
```

`caches.default` 不需要额外的 binding 或存储资源。缓存按 Cloudflare 数据中心隔离，平台也可能在 TTL 到期前驱逐条目，因此不同地区或缓存刚失效时的并发请求仍可能重复访问上游。本项目不提供全局互斥，也不提供绕过缓存的入口。

Cloudflare Cache API 需要将 Worker 绑定到自定义域名或 Route。Dashboard、Playground 预览以及 `*.workers.dev` 地址不会实际写入缓存。

## 部署

登录 Cloudflare：

```bash
npx wrangler login
```

如需启用访问鉴权，将 Token 保存为 Worker Secret：

```bash
npx wrangler secret put ACCESS_TOKEN
```

部署 Worker：

```bash
npm run deploy
```

`wrangler.jsonc` 已启用 Workers 日志和调用日志，并关闭 traces。部署后，还需要在 Cloudflare Dashboard 中为 Worker 绑定自定义域名或 Route，Cache API 才会按预期工作。

## 使用

所有业务接口都需要提供 Just My Socks 的 `service` 和 `id`：

```text
https://你的域名/clash?service=SERVICE_ID&id=UUID
https://你的域名/quanx?service=SERVICE_ID&id=UUID
https://你的域名/loon?service=SERVICE_ID&id=UUID
https://你的域名/api/subscription?service=SERVICE_ID&id=UUID
```

订阅调整参数可以直接附加到请求：

```text
/quanx?service=SERVICE_ID&id=UUID&noss=1
/quanx?service=SERVICE_ID&id=UUID&novless=1
/quanx?service=SERVICE_ID&id=UUID&exclude=3,5&usedomains=1
/loon?service=SERVICE_ID&id=UUID&exclude=3,5&usedomains=1
/clash?service=SERVICE_ID&id=UUID&exclude=3,5&usedomains=1
```

启用 `ACCESS_TOKEN` 后，可使用查询参数或请求头鉴权：

```text
https://你的域名/quanx?service=SERVICE_ID&id=UUID&token=你的令牌
Authorization: Bearer <token>
```

## 检查

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
```
