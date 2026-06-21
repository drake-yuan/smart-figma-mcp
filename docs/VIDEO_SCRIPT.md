# 1 分钟对比视频脚本

> 录制工具：QuickTime + OBS | 格式：9:16 Shorts / 1:1 Twitter | 字幕：英文字幕，无配音

## 场景 1: 痛点（0:00–0:15）

### 画面
- Cursor 编辑器 + Figma 并排
- 用户手动选中 Figma 中的 Button 设计稿
- 复制链接 → 粘贴到 Cursor chat
- AI 回复：一个 div 堆砌的 Button，样式写死，没用项目的 shadcn/ui Button

### 字幕
```
✕ 传统方式：给 AI 发 Figma 链接
→ AI 不认识你的项目组件
→ 重新手写 div 堆砌 Button
→ 样式不一致、没有 variant、data-node-id 垃圾代码
```

### 标记
❌ `0.5x` 慢动作 + 红色边框

---

## 场景 2: 方案（0:15–0:30）

### 画面
- 终端运行 `npx smart-figma-mcp`
- Cursor MCP 配置中添加 smart-figma-mcp
- 粘贴同一 Figma 链接
- AI 识别到是 Button 组件，输出 `import { Button } from "@/components/ui/button"`
- 自动匹配 `variant="destructive"`

### 字幕
```
✓ smart-figma-mcp 接入后：
→ AI 识别 figma component 名
→ 映射到本地 shadcn/ui Button
→ variant 自动对齐 destructive
→ 代码就是项目的标准组件
```

### 标记
✅ 绿色边框 + 加速

---

## 场景 3: 结果（0:30–0:45）

### 画面
- `src/components/ui/ProductCard.tsx` 被自动生成
- `index.ts` barrel 导出自动更新
- 终端 `eslint --fix` 通过 ✓
- 文件中没有 `data-node-id` / `data-name` 垃圾属性

### 字幕
```
自动落盘 → 更新 index.ts → eslint 通过
data-node-id 被物理清洗
团队 code review 零污染
```

### 标记
✅ 3 秒完成，progressive reveal

---

## 场景 4: BYOK（0:45–0:55）

### 画面
- 显示环境变量 `OPENAI_API_KEY=sk-***` / `DEEPSEEK_API_KEY=sk-***`
- 标注 "TOKEN 走你账单"
- 免费档演示：纯数字编译，无 LLM 调用，0 Token

### 字幕
```
BYOK 模式：token 走你账单
免费档：纯本地编译，0 Token 消耗
License 验签全离线
```

---

## CTA（0:55–1:00）

### 画面
- 黑底白字
- 产品名 + 价格 + 链接

### 字幕
```
smart-figma-mcp
前 50 名 $19 买断
链接见 bio / 评论区置顶
```
