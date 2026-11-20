# X-JP Feed

仿日本 X（Twitter）暗黑模式的个人日语学习 PWA。在“吃瓜”和“对线”中练阅读和写作。

## 特性
- **注音由本地分词器生成**：使用 kuromoji.js（形态素分析）为所有汉字自动加 `<ruby>` 假名。大模型只输出纯文本，避免读音错误。
- **三种阅读模式**：起步（生词条显示中文）/ 进阶（助词胶囊 + 动词虚线）/ 纯享（眼熟词隐藏注音）。
- **点词即查**：底部弹窗显示读音、原形、词性和语境释义，并支持标记“已掌握”。
- **🪄 日网化改写**：输入中文或中日混杂文本，生成 3 种地道日语版本。
- **📝 私教润色**：自己用日语写的帖子会提供纠错和更地道的写法。
- **NPC 对线 + 隐形复习**：从 8 种人设中随机抽取网友来回复，并在回复中自然使用你查得最多的顽固生词。
- **难度分级**：帖子分 Lv1–3，按你的难度优先推送。
- **数据全部在本机**：IndexedDB 存储，支持 JSON 导出/导入。

## 部署
1. **GitHub Pages**：Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。
   访问 `https://yijun-yu.github.io/X-JP-feed/`，手机上用“添加到主屏幕”。
2. **自动内容生成**：Settings → Secrets and variables → Actions → 新建 `DEEPSEEK_API_KEY`。
   Actions 每天北京时间 8/12/16/21 点运行，也可以在 Actions 页面手动 `Run workflow`。
3. **在 App 里填 Key**：⚙️ 设置 → DeepSeek API Key（只存在本机浏览器）。

## CORS 备用方案
如果浏览器直连 `api.deepseek.com` 报 CORS 错误，可以用 Cloudflare Worker 做一个转发代理，然后在设置里把 API Base 改成 Worker 地址：

```js
export default {
  async fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const r = await fetch('https://api.deepseek.com' + url.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: req.headers.get('Authorization') }, body: req.body });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
```

## 结构
```
index.html / css / js/        前端（无需构建，原生 ES Modules）
  js/tokenizer.js             文本 → tokens（kuromoji 注音）
  js/deepseek.js              DeepSeek 调用与 Prompt
  js/db.js                    IndexedDB
packs/index.json + *.json     内容包（只存纯文本，注音在前端生成）
scripts/generate.mjs          Actions 用的内容生成脚本
sw.js / manifest.json         PWA 离线缓存
```
