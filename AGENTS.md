# 仓库指南

## 项目结构与模块组织

本仓库包含一个使用 TypeScript 编写的 Cloudflare Worker。运行时代码位于 `src/index.ts`；功能规模较大时，应拆分为 `src/` 下职责单一的模块。测试位于 `test/index.test.ts`。`wrangler.jsonc` 定义入口文件、兼容性设置、缓存 TTL 和可观测性配置。生成的绑定类型保存在 `worker-configuration.d.ts`。

## 构建、测试与开发命令

- `npm install`：安装锁定版本的依赖。要求 Node.js 22 或更高版本。
- `npm run dev`：通过 Wrangler 启动本地 Worker。
- `npm test`：运行一次 Vitest 测试套件。
- `npm run typecheck`：执行严格的 TypeScript 类型检查，不生成文件。
- `npm run types`：绑定或环境变量变更后，重新生成 `worker-configuration.d.ts`。
- `npx wrangler deploy --dry-run`：验证部署包，但不发布。
- `npm run deploy`：发布 Worker。仅在明确需要部署时运行。

提交拉取请求前，运行测试、类型检查和部署预检。

## 编码风格与命名约定

遵循现有 TypeScript 风格：使用两个空格缩进、双引号、分号、多行结构尾随逗号，并为公共边界声明显式类型。函数和变量使用 `camelCase`，类型使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。辅助函数应保持简短、纯粹。保留严格的编译器设置；不要使用 `any` 或未经检查的类型断言绕过错误。

## 测试规范

使用 Vitest、`describe`/`it` 代码块和描述行为的测试名称。相关功能变更时，覆盖 URL 参数转发、协议转换、缓存降级、身份认证和响应元数据。优先使用确定性测试数据和 `MemoryCache` 等内存替身。测试不得访问线上端点，也不得包含真实的服务 ID、UUID 或令牌。项目未设置数值化覆盖率门槛，应优先覆盖分支和失败路径。

## 提交与拉取请求规范

提交信息遵循 Conventional Commits 规范，格式为 `<type>(<scope>): <description>`，例如 `feat(subscription): add Loon conversion`。常用类型包括 `feat`、`fix`、`docs`、`test`、`refactor` 和 `chore`。每个提交应聚焦单一改动，主题使用简洁的祈使句。提交时使用 `git commit --no-verify`，跳过全局 Git Hook 检查。拉取请求应说明行为变化、列出验证命令、在适用时关联 Issue，并为 API 变更提供请求和响应示例。仅在 Dashboard 或文档存在可见变化时添加截图。

## 安全与配置

将 `.dev.vars.example` 复制为 `.dev.vars`，用于保存本地密钥。不得提交密钥、订阅 UUID 或上游响应。使用 `npx wrangler secret put ACCESS_TOKEN` 保存生产环境令牌。修改缓存键时，应确认凭据不会通过 URL、日志或缓存载荷泄露。
