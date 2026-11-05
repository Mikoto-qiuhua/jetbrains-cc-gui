# Codex 编辑记录与 JetBrains MCP 文件操作修复说明

## 1. 概述

本次修改解决了四类问题：Codex 通过 `exec` 脚本修改文件时编辑记录栏不显示、Codex 未发送终态 `fileChange` 时文件一直停留在 `inProgress`、JetBrains IDEA MCP 提供的文件操作完全不被统计，以及撤销修改时 IDEA 抛出的 read-action 线程断言异常。修改覆盖前端编辑账本（Webview）、Codex app-server 服务层和 Java 插件撤销处理器，并补充了对应单元测试、重新构建了可安装插件包。

## 2. 问题背景

### 2.1 Codex 默认通过 exec 修改文件

Codex 的默认工作方式不是直接调用 `apply_patch` 工具，而是在 `exec` / `exec_command` 脚本里调用 `tools.apply_patch(...)` 或执行 `apply_patch <<'EOF' ... EOF`。聊天记录里只出现一个 shell/exec 工具卡片，真正的 patch 文本藏在 `input.command`、`input.code`、`input.patch` 等字段中。

旧版编辑账本只识别 `apply_patch`、`file_change`、`edit`、`write` 等直接文件工具，因此：

- 文件确实被修改了；
- 状态面板 Edits / 编辑记录栏为空；
- 无法从编辑记录执行撤销。

### 2.2 fileChange 未终态

即使 Codex 发出了原生 `fileChange` 事件，也可能只有 `item/started`，没有对应的 `item/completed`。前端账本要求操作达到终态（`completed`）才展示可撤销记录，结果文件永远被判定为 `inProgress` 而无法进入列表。

### 2.3 JetBrains MCP 文件工具未纳入

IDEA 2025.2+ 内置 MCP Server 提供 `create_new_file`、`replace_text_in_file` 等文件工具。Codex 的 `mcpToolCall` 投影格式为：

```json
{
  "type": "mcpToolCall",
  "server": "jetbrains",
  "tool": "replace_text_in_file",
  "arguments": {
    "pathInProject": "src/app.ts",
    "oldText": "before",
    "newText": "after",
    "projectPath": "/path/to/project"
  }
}
```

它有三个与旧账本不兼容的地方：

1. 工具名 `replace_text_in_file` / `create_new_file` 不在 `FILE_MODIFY_TOOL_NAMES` 中；
2. 参数被包在 `input.arguments` 里，账本只读顶层字段；
3. 路径字段是 `pathInProject` + `projectPath`，而账本只读 `path` / `file_path` / `filePath`。

因此 MCP 文件操作此前同样不会被统计。

### 2.4 撤销时的线程断言异常

撤销在后台线程（`ApplicationImpl pooled thread`）执行，直接调用 `FileDocumentManager.getDocument(file)`。从 IDEA 2024.3 开始，该调用必须在 read action 内执行，否则抛出：

```text
com.intellij.openapi.diagnostic.RuntimeExceptionWithAttachments:
Read access is allowed from inside read-action only
```

异常发生在 native 编辑校验分支，普通编辑分支已经完成回滚，所以表现为“日志报错但内容其实撤回成功”。

## 3. 修改总览

| 文件 | 修改内容 |
|---|---|
| `webview/src/utils/codexPatch.ts` | 新增 `readEmbeddedPatches` 与 `decodePatchBody`，从 shell/exec 输入中提取 apply_patch 文本 |
| `webview/src/utils/toolConstants.ts` | 新增 `MCP_FILE_MODIFY_TOOL_NAMES` 并合并进 `FILE_MODIFY_TOOL_NAMES` |
| `webview/src/hooks/useFileChanges.ts` | 采集 shell/exec 调用；解包 MCP `arguments`；解析 `pathInProject`；支持 `text` 与空文件创建 |
| `ai-bridge/services/codex/codex-appserver-service.js` | 成功 turn 结算时把未终态的 `fileChange` 提升为 `completed` |
| `src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java` | 文档读取全部包进 `runReadAction` |
| `webview/src/hooks/useFileChanges.test.ts` | 新增 exec 内嵌 patch 与 JetBrains MCP 用例 |
| `webview/src/utils/codexPatch.test.ts` | 新增内嵌 patch 提取用例 |
| `webview/src/utils/toolConstants.test.ts` | 新增 MCP 工具名归一化用例 |
| `ai-bridge/services/codex/codex-appserver-service.test.js` | 新增 fileChange 终态提升用例 |
| `idea-claude-code-gui-0.6.3.zip` | 重新构建的可安装插件包 |

## 4. 详细实现

### 4.1 从 shell / exec 输入中提取 patch

文件：`webview/src/utils/codexPatch.ts`

```ts
export function readEmbeddedPatches(input?: ToolInput): string[] {
  if (!input) return [];
  for (const field of ['patch', 'input', 'code', 'command', 'cmd']) {
    const candidate = input[field];
    if (typeof candidate !== 'string') continue;
    const patches: string[] = [];
    let from = 0;
    while (true) {
      const begin = candidate.indexOf('*** Begin Patch', from);
      if (begin < 0) break;
      const end = candidate.indexOf('*** End Patch', begin);
      if (end < 0) break;
      const next = end + '*** End Patch'.length;
      patches.push(decodePatchBody(candidate.slice(begin, next)));
      from = next;
    }
    if (patches.length > 0) return patches;
  }
  return [];
}
```

设计要点：

- 支持一个脚本里包含多个 patch；
- 支持真实换行和 JSON 转义后的 `\n` 两种形态；
- 普通命令（如 `ls -la`）返回空数组，不产生误判；
- 只负责抽取文本，解析和统计仍复用已有的 `readPatchFiles` / `collectPatchLedger`。

### 4.2 让账本采集 shell / exec 调用

文件：`webview/src/hooks/useFileChanges.ts`

新增 shell 工具集合：

```ts
const SHELL_PATCH_TOOL_NAMES = new Set([...BASH_TOOL_NAMES, 'exec']);
```

采集门槛同步放开：

```ts
// Shell/exec blocks are collected too: Codex wraps apply_patch in them.
if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)
  && !isToolName(toolName, SHELL_PATCH_TOOL_NAMES)) return;
```

收集逻辑中增加分支：

```ts
if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) {
  if (!isToolName(toolName, SHELL_PATCH_TOOL_NAMES) || !isSuccessfulResult(result)) return;
  for (const patch of readEmbeddedPatches(toolInput)) {
    for (const file of readPatchFiles({ patch })) {
      out.push(...collectPatchLedger(file, { sourceId, toolUseId, agentId }));
    }
  }
  return;
}
```

这样处理的原因：

- 不在聊天区额外插入工具卡片，只把 shell 命令里隐藏的 patch 计入编辑账本；
- 仅对成功的 shell 调用生效，失败或未完成的命令不会产生可撤销记录。

### 4.3 app-server 终态提升

文件：`ai-bridge/services/codex/codex-appserver-service.js`

```js
&& !['completed', 'failed', 'declined', 'interrupted'].includes(item.status)
// A successful turn proves every started edit landed, even when Codex
// omits the trailing item/completed marker; without this promotion the
// ledger keeps rejecting the file as inProgress forever.
&& (outcome !== 'completed' || item.type === 'reasoning'
  || item.type === 'fileChange' && !item.proposed)) {
```

含义：当整个 turn 成功结束时，所有已开始但未收到完成事件的 `fileChange` 都被视为已完成并补发终态标记。`proposed` 的 fileChange 表示“待审批的提议”，不会被误判为已落盘。

### 4.4 支持 JetBrains MCP 文件工具

#### 4.4.1 工具名登记

文件：`webview/src/utils/toolConstants.ts`

```ts
export const MCP_FILE_MODIFY_TOOL_NAMES = new Set([
  'create_new_file',
  'replace_text_in_file',
]);

export const FILE_MODIFY_TOOL_NAMES = new Set([
  ...MCP_FILE_MODIFY_TOOL_NAMES,
  'write',
  'write_file',
  'edit',
  // ...
]);
```

`normalizeToolName` 会剥离 `mcp__server__` 前缀，因此 `mcp__jetbrains__replace_text_in_file` 也能匹配。

#### 4.4.2 解包 `arguments`

文件：`webview/src/hooks/useFileChanges.ts`

```ts
function unwrapToolArguments(input: Record<string, unknown>): Record<string, unknown> {
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return input;
  return { ...input, ...(args as Record<string, unknown>) };
}
```

合并后同时保留 `server` 等外层字段，且不改动原始消息对象。该逻辑对所有 MCP 文件工具生效，不只 JetBrains。

#### 4.4.3 解析 `pathInProject` / `projectPath`

```ts
function resolvePathInProject(input: Record<string, unknown>): string | null {
  const pathInProject = input.pathInProject;
  if (typeof pathInProject !== 'string' || pathInProject.trim() === '') return null;
  const projectPath = typeof input.projectPath === 'string' ? input.projectPath.trim() : '';
  if (!projectPath || ABSOLUTE_PATH_PATTERN.test(pathInProject)) return pathInProject;
  const separator = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath.replace(/[\\/]+$/, '')}${separator}${pathInProject.replace(/^[\\/]+/, '')}`;
}
```

行为：

- 绝对路径直接使用；
- 有 `projectPath` 时按平台分隔符拼接，兼容 `C:\proj`；
- 缺少 `projectPath` 时保留原相对路径，不猜测项目根目录。

#### 4.4.4 内容字段与新增文件

- `extractEditPairs` 增加读取 `text` 字段，兼容 `create_new_file`；
- `create_new_file` 即使内容为空也会生成一条记录，状态为 `A`，避免“创建空文件”在编辑记录中消失；
- 该记录带 `fileChangeKind: 'add'`，用于正确计算新增文件状态。

#### 4.4.5 数据流

```text
Codex app-server
  └─ item.type = mcpToolCall
       └─ codex-item-projection.js
            name = item.tool
            input = { server, arguments }
                 └─ useFileChanges.unwrapToolArguments
                      ├─ pathInProject + projectPath → 文件路径
                      ├─ oldText / newText → 可撤销操作
                      ├─ text → 新建文件内容
                      └─ FILE_MODIFY_TOOL_NAMES 命中 → 写入编辑账本
```

### 4.5 撤销线程修复

文件：`src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java`

```java
Document document = ApplicationManager.getApplication().runReadAction(
        (Computable<Document>) () -> FileDocumentManager.getInstance().getDocument(file));
```

共修复三处文档访问：

- 普通编辑撤销路径的 `getDocument`；
- native 编辑路径的 `getCharset` 与 `getDocument`；
- 检查未保存文档的 `isDocumentUnsaved`。

线程模型保持不变：

- 文件系统读写仍在后台线程；
- 文档模型读取加 read action；
- `document.setText` 等写操作仍在 EDT 的 write action 中执行。

## 5. 测试

### 5.1 前端单测

**`webview/src/utils/codexPatch.test.ts`**

- 从 exec 脚本中恢复 apply_patch 文本；
- 支持反引号模板字符串和 `\n` 转义形式；
- 普通命令返回空数组；
- 保留多文件、移动目标与字面 patch 行。

**`webview/src/hooks/useFileChanges.test.ts`**

新增 exec 相关用例：

- `adds edits Codex performs through an exec script`：`functions.exec` + `input.patch`，断言 `+1 / -1` 且可撤销操作正确；
- `adds edits from a functions.exec_command apply_patch heredoc`：`apply_patch <<'EOF'` 形式。

新增 JetBrains MCP 相关用例（6 个）：

- `replace_text_in_file`：路径拼接、状态 `M`、增删行数、`replaceAll`；
- `create_new_file`：状态 `A`、内容行数、`fileChangeKind: 'add'`；
- 空内容 `create_new_file`：仍然出现在编辑列表；
- Windows 路径：`C:\proj` + `src\win.ts` 正确拼接；
- 通用 MCP `write_file`：验证 `arguments` 解包不只对 JetBrains 生效；
- 失败调用：`isError: true` 时不产生账本记录。

**`webview/src/utils/toolConstants.test.ts`**

- `create_new_file` / `replace_text_in_file` 命中 `FILE_MODIFY_TOOL_NAMES`；
- `mcp__jetbrains__replace_text_in_file` 前缀形式也能命中。

**`ai-bridge/services/codex/codex-appserver-service.test.js`**

- `started-only native file changes settle as completed on a successful turn`：断言同一 uuid 的 `file_change` 先出现 started，再被提升为 completed。

### 5.2 全量回归

```bash
cd webview
npm test
```

结果：

- `scripts/copy-dist.test.mjs` 通过；
- Vitest 全量：**243 个测试文件、2534 个用例全部通过**；
- `tsc -p tsconfig.test.json --noEmit` 类型检查通过。

### 5.3 Java 测试

```bash
gradle test --tests '*UndoFileHandlerTest'
```

结果：**11 个用例，0 failures，0 errors**。

说明：Java 全量测试中 `CodexHistoryPageIndexTest` 存在 3 个与本次改动无关的既有不稳定断言，重跑时失败用例数量会变化。

### 5.4 构建与产物校验

```bash
gradle buildPlugin
```

结果 `BUILD SUCCESSFUL`，产物：

- `build/distributions/idea-claude-code-gui-0.6.3.zip`（约 27 MB）
- 已复制到 `/workspace/idea-claude-code-gui-0.6.3.zip`

产物校验：

- 从 zip 中提取 `idea-claude-code-gui/lib/idea-claude-code-gui-0.6.3.jar`；
- 确认其中包含 `webview/assets/index-*.js.gz`；
- 解压后确认 bundle 内含 `pathInProject`、`create_new_file`，避免源码改了但包内是旧代码。

## 6. 已知限制

| 限制 | 说明 |
|---|---|
| `reformat_file` 不统计 | 该工具只提供路径，没有修改前后文本；强行记录会生成错误的撤销内容（撤销会把文件清空），因此主动跳过 |
| 未处理 `multi_tool_use.parallel` 内层参数 | 当前只扫描 shell/exec 输入的直接字段；若 patch 被包在并行调用的嵌套 JSON 中，需要额外解析 |
| `create_new_file` 覆盖已有文件 | 若设置 `overwrite: true` 覆盖旧文件，入参没有旧内容，撤销只能清空文件，无法恢复覆盖前内容 |
| 新建文件撤销语义 | 撤销后文件内容为空，不会删除文件本身 |
| 缺少 `projectPath` | 只保留 `pathInProject` 相对路径，可能导致撤销时无法解析到项目内文件 |
| 未做真实 IDE 端到端联调 | 单测消息结构按 app-server 投影逻辑还原，参数名来自 JetBrains 官方文档；最终需在真实 IDEA + 真实 MCP Server 上验证 |

## 7. 安装与验证

### 7.1 安装

1. IDEA → Settings → Plugins → Installed，卸载旧版；
2. 从磁盘安装 `/workspace/idea-claude-code-gui-0.6.3.zip`；
3. 完全重启 IDEA。

### 7.2 验证 exec 修改

让 Codex 修改任意文件后，检查状态面板 Edits / 编辑记录：

- 出现被修改文件；
- 状态为 `M`；
- 增删行数正确；
- 撤销可恢复内容。

### 7.3 验证 JetBrains MCP

先确认 MCP 可用（只读工具）：

```text
请使用 JetBrains MCP 的 get_file_text_by_path 工具，读取 src/main.ts 的前 20 行。
必须使用 MCP 工具，不要用 shell。
```

再验证修改：

```text
请只使用 JetBrains MCP 的 replace_text_in_file 工具，
把 src/ledger-test.ts 里的 'before' 改成 'after'。
不要使用 shell、apply_patch 或 exec。
```

预期：

- 对话区出现 `replace_text_in_file` 的 MCP 工具卡片；
- 编辑记录出现 `ledger-test.ts`，状态 `M`，约 `+1 / -1`；
- 撤销后恢复为 `before`。

新建文件：

```text
请只使用 JetBrains MCP 的 create_new_file 工具，
创建 docs/mcp-test.md，内容为两行：
# MCP Test
hello
```

预期状态 `A`、`+2 / -0`。

### 7.4 验证撤销不再报错

撤销后打开 `Help → Show Log in Explorer` 的 `idea.log`，确认不再出现：

```text
Read access is allowed from inside read-action only
```

## 8. 排查指引

如果编辑记录仍未出现，按顺序收集：

1. 对话区 MCP 工具卡片的完整工具名；
2. Codex 会话 JSONL 中该条 `mcp_tool_call` 的 `tool` 与 `arguments` 原文（默认在 `~/.codex/sessions`）；
3. 编辑记录是完全没有文件，还是路径 / 行数不正确。

映射关系：

| 现象 | 可能原因 |
|---|---|
| 完全没有文件 | 工具名未命中、调用失败、或不是 MCP 文件工具 |
| 路径是相对路径 | `arguments` 中缺少 `projectPath` |
| 行数不对 | 工具入参字段与 `oldText` / `newText` 不匹配 |
| 撤销无效 | 路径无法解析到项目内文件，或为新建文件撤销 |
| 仍有 read-action 报错 | 其他 `Document` / `VirtualFile` 访问点未包 read action，需要新的堆栈 |

## 9. 变更文件清单

```text
ai-bridge/services/codex/codex-appserver-service.js
ai-bridge/services/codex/codex-appserver-service.test.js
src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java
webview/src/hooks/useFileChanges.ts
webview/src/hooks/useFileChanges.test.ts
webview/src/utils/codexPatch.ts
webview/src/utils/codexPatch.test.ts
webview/src/utils/toolConstants.ts
webview/src/utils/toolConstants.test.ts
idea-claude-code-gui-0.6.3.zip
```
