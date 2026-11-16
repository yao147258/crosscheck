# Task2：模型实际查看截图与 DOM

## 范围与状态

- 基线：`9d3839a`；在现有 `worktree-worktree-plan2-browser` 分支完成，仅本地提交，不合并、不推送。
- 已读取 Task2 brief、计划 Global Constraints 和 spec 顶部当前有效裁定。仅实现证据呈现；未接 browser_action、浏览器认证或浏览器 runner 生命周期，不新增网络隔离研究。
- 全程无子代理、无会 fork 的 review 技能、无真实模型 token；完成代码与测试自审，独立审查由调用方另派。
- 用户已有 `.gitignore` 修改保持原样，不纳入提交。

## RED → GREEN 证据

1. 先新增 `packages/tools/test/browser-presentation.test.ts`，执行 `pnpm vitest run packages/tools/test/browser-presentation.test.ts`：**6 failed / 6**。截图被旧 presenter 当成文本读入，报“文本证据不存在或类型不符”，证明未实现截图呈现；此时尚未修改生产代码。
2. 再新增 agent 上下文测试，执行 `pnpm vitest run packages/agent/test/task8-context.test.ts`：**2 failed / 9 passed**。旧 multipart 附件未保留 `e-image` ID；DOM 被旧装配器拒绝。之后才修改生产实现。
3. 第一轮 GREEN 揭示测试对 SDK V4 provider 数据结构的假设错误：公开 `image` part 被规范化为 `file` part，且数据为 `{ type: 'data', data: Uint8Array }`，不是裸 Uint8Array。查本地已安装类型后修正边界断言，未凭旧 API 改生产代码。
4. 最终定向命令：`pnpm vitest run packages/agent/test packages/tools/test/task8-presenter.test.ts packages/tools/test/browser-presentation.test.ts packages/runner/test/task9.test.ts`：**8 files / 203 tests passed**。
5. `pnpm typecheck`：退出 0；`pnpm build`：退出 0，生产 CLI bundle 构建完成。
6. 构建后首次默认 `pnpm test`：**50 files passed / 2 failed / 2 skipped；839 tests passed / 2 failed / 19 skipped**。失败均为既有测试的 5000ms 超时：CLI redirect、report XML attribute 65534；无断言失败。
7. 不改超时、不改无关代码，`pnpm vitest run packages/report/test/report.test.ts packages/cli/test/e2e.test.ts --maxWorkers=1`：**2 files / 30 tests passed**。
8. 进一步串行完整回归 `pnpm vitest run --maxWorkers=1`：**52 files passed / 2 skipped；841 tests passed / 19 skipped**。支持首次超时与并发运行负载相关，但不将首次默认回归记作全绿。

## 实现及供 Task3 消费的明确接口

### agent/context

```ts
interface TextEvidence {
  id: string;
  type: 'network' | 'console' | 'db' | 'dom';
  text: string;
  truncated: boolean;
}
interface ImageEvidence {
  id: string;
  type: 'screenshot';
  bytes: Uint8Array;
  mediaType: 'image/png';
  truncated: boolean;
}
type PresentedEvidence = TextEvidence | ImageEvidence;
type EvidencePresentation = Pick<PresentedEvidence, 'id' | 'type' | 'truncated'>;
interface EvidencePresentedEvent {
  ref: string;
  evidence: readonly EvidencePresentation[];
}
type EvidencePresenter = (
  ids: readonly string[],
  context: { ref: string; signal: AbortSignal },
) => Promise<PresentedEvidence[]>;
```

- 保留 `TextEvidence` 为真正的文本分支，旧文本调用只需按 `type` 收窄，没有给联合虚构通用 `text` 字段或新增 any。
- `ContextPolicy.maxAttachmentBytes?: number`：默认 **8 MiB**，累计所有 PNG 原始字节；不切割 PNG。原 `maxAttachmentChars` 默认 **64000**，累计文本正文、类型头和附件截断标记；图片说明文字也计入字符额。缺失提示和 ID 历史为控制信息，不计入附件正文额，与既有缺失提示规则一致。
- `prepareContext(...)` 新返回 `presentedEvidence: EvidencePresentation[]`；只列最终实际附加项，缺失或图片超限项不入列，截断文本明确 `truncated: true`。
- 所有历史宿主附件在每候选请求前降为 ID，再从 presenter 重新装配；multipart 历史图片压缩为 ID，不复用旧图绕过能力/限额；不拆 tool-call/result 对。

### agent/loop 与 runner

```ts
RunAgentOptions.onEvidencePresented?:
  (event: EvidencePresentedEvent) => void | Promise<void>;
```

- 每个真实候选（含重试、fallback、后续轮次）装配后、调用 provider 前 await 通知。通知异常走宿主错误传播，不能被当成 provider 失败重试；通知不表示 provider 一定成功。
- runner 使用通知的最终元数据**清空并替换** shown，删除另算 64000 的模拟代码；首选/执行器 shown 不沿用到 fallback/reviewer。
- `validateJudgements(..., shown: ReadonlyMap<string, EvidencePresentation>)` 接受最小呈现元数据，仍对所有引用核验归属、执行阶段、文件哈希、类型一致及 `truncated`，沿用 pass/fail 对全部要求证据类型的既有要求。
- 必需证据未完整呈现仍保留既有 finish 门禁，没有放宽不完整证据判定。

### tools/presenter 与 store

```ts
createEvidencePresenter(store, options?: {
  maxTextChars?: number;
  capabilities?: Readonly<Record<string, { images: boolean }>>;
}): EvidencePresenter;
EvidenceStore.readEvidenceType(id: string): Promise<EvidenceRecord['type']>;
```

- runner 已传 `input.config.capabilities`；能力缺省 `{}` 即全部 images=false。每次使用候选 `ref` 选择截图，不看首选 ref。
- 每个候选按 ID 重读并核验 PNG（无图候选也核验，避免损坏文件被伪装成能力缺失）。DOM 继续消费既有 `readTextEvidence`，`sourceIncomplete` 与呈现截断做逻辑或，不能因正文短而洗成完整。
- **唯一 Task1 接口必要修改**：store 新增按已登记 ID 查询类型的小方法，避免“先读文本失败再 try PNG”吞掉真实磁盘/哈希故障。原采集、遮罩、saveScreenshot、readScreenshotEvidence、readTextEvidence 算法均未改。

### 盲审输入

```ts
buildReviewInput(
  clauses: Pick<Clause, 'id' | 'text' | 'source'>[],
  expectations: Expectation[],
  evidenceIds: readonly string[],
): ModelMessage[];
```

- 仅白名单条款/来源、预期及 ID，拒绝结构外额外结论/推理/消息/审计字段进入 JSON。
- runner 删除 reviewer 调用前按首选预物化 evidence 的步骤；图片只由实际候选 presenter 加入 multipart，不把 bytes 转成 JSON。
- Task3 应继续复用当前 presenter、required 列表、`onEvidencePresented` 与 validateOutput；接 BrowserHost/createBrowserTools 和认证即可，不应再实现一份呈现限额或 reviewer 证据预读。

## 实际附件与安全边界测试

- 真 ArtifactStore/EvidenceStore 登记 PNG（读取测试夹具，不伪造可信采集能力），经 presenter→runAgent→AI SDK→MockLanguageModelV4，最终 provider prompt `file.data.data` 与原 PNG **逐字节相等**。
- 图片主模型失败→无图 fallback：首选有图，fallback 每次无 file part、保留完整 DOM 正文和缺失提示，shown 中无截图，反复 PASS finish 最终 blocked。
- 单图超限、两图累计限额、文字超限；元数据精确反映最终附件，不把省略图片算作完整、不输出损坏 PNG。
- DOM 全文/定位信息进入实际 prompt；DOM 源 omitted 的短正文仍 truncated 并阻止 finish。
- pass/fail 引用未呈现截图、类型不符、源不完整 DOM 均拒绝；完整截图+DOM可判；未放宽要求的类型覆盖。
- 未声明图片能力默认不附截图；哈希损坏、签名损坏均为宿主错误；坏盘/通知错误不增加 provider 调用或触发主备重试。
- reviewer 主/备真实 prompt 隔离 executor messages/conclusion/reasoning/audit 哨兵；现有 runner 独立盲审哨兵、HTTP/DB 文本和取消/预算回归通过。

## 自审与局限

- 自审覆盖每候选重新物化、最终元数据与实际附件一致、shown 替换时机、读盘异常优先、调用对配对、盲审白名单和旧文本完整性；`git diff --check` 无空白错误。
- 本地 `@ai-sdk/provider-utils@5.0.79` 的 `ImagePart` 支持 Buffer/Uint8Array，但 SDK 运行时给出 `AISDK_DEP_IMAGE_CONTENT_PART` **弃用警告**。本任务依已确认真实 image 类型交付，最终 provider 的 PNG 数据已验证；未隐藏警告或顺带迁移 SDK API。
- Context7 resolve 成功，query 请求 `fetch failed`；以本地实际 provider-utils 与 provider V4 声明及运行时测试确认 API。
- 首次默认全量有两个并发超时，串行完整回归全绿；未声称默认首次全绿。
- Task3 尚未接入浏览器执行/认证，故本任务不宣称真实浏览器双判闭环可用。没有运行真实 Chromium、真实 PostgreSQL、最低 Node 或厂商模型联调；默认跳过项保留，未消耗真实模型 token。
- 图片能力是用户配置声明，不自动探测厂商；图片上限按原始 bytes，不声称是精确 token 或 provider 编码后的请求大小。
