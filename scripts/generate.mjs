// 由 GitHub Actions 定时运行：抓取 Google News RSS 标题 → DeepSeek 生成日网风帖子（纯文本）→ 写入 packs/
// 注音不在这里做，统一由前端 kuromoji 生成。
import fs from 'node:fs/promises';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('缺少 DEEPSEEK_API_KEY'); process.exit(1); }

const TOPICS = {
  ai: '生成AI OR LLM OR オープンソースモデル',
  anime: 'アニメ 新作',
  game: 'ノベルゲーム OR ギャルゲー OR 美少女ゲーム',
  society: '政治 OR 社会問題',
  history: '日本史 OR 歴史 新発見',
};
const AVATAR = { ai: '🤖', anime: '📺', game: '🎮', society: '🗞️', history: '📜' };

const decode = s => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function headlines(topic, q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=ja&gl=JP&ceid=JP:ja`;
  const xml = await (await fetch(url)).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => ({
    topic,
    title: decode(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
    url: decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] || ''),
  })).filter(x => x.title);
  return items.sort(() => Math.random() - 0.5).slice(0, 2);
}

async function deepseek(messages) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 1.0, max_tokens: 4000, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(res.status + ' ' + await res.text());
  return JSON.parse((await res.json()).choices[0].message.content);
}

const news = (await Promise.all(Object.entries(TOPICS).map(([t, q]) => headlines(t, q).catch(() => [])))).flat();
if (!news.length) { console.log('没有抓到新闻，跳过'); process.exit(0); }

const sys = `あなたは日本のX（旧Twitter）のタイムラインを再現する脚本家です。与えられたニュース見出しそれぞれについて、日本のネット民が書きそうなポストを1件ずつ作ってください。
ルール：
- 本文は自然な日本語のネット口語。振り仮名・ローマ字・括弧付きの読みは絶対に付けない。
- 見出しにない事実を勝手に作らない。感想・ツッコミ・疑問の形にする。
- level は 1〜3。1=JLPT N5〜N4の語彙で短文、2=N3程度、3=制限なし。全体の半分以上を level 1 にする。
- 本文は30〜120文字。各ポストに性格の違う返信を1〜2件付ける（各20〜70文字）。
- author は面白い日本風のハンドルネーム、handle は英数字と_のみ、avatar は絵文字1つ。
出力はJSONのみ：{"posts":[{"index":0,"level":1,"author":"","handle":"","avatar":"","text":"","replies":[{"author":"","handle":"","avatar":"","text":""}]}]}`;
const user = news.map((n, i) => `${i}. [${n.topic}] ${n.title}`).join('\n');

const out = await deepseek([{ role: 'system', content: sys }, { role: 'user', content: user }]);
const now = new Date();
const stamp = now.toISOString().slice(0, 13).replace(/[-T]/g, '');
const ok = s => typeof s === 'string' && s.trim().length >= 5 && s.length <= 300;
const posts = (out.posts || []).filter(p => ok(p.text) && news[p.index]).map((p, i) => {
  const n = news[p.index];
  return {
    id: `${stamp}-${i}`, topic: n.topic, level: [1, 2, 3].includes(+p.level) ? +p.level : 2,
    time: new Date(now.getTime() - i * 90000).toISOString(),
    author: String(p.author || '名無しさん').slice(0, 20), handle: String(p.handle || 'nanashi').replace(/\W/g, '').slice(0, 20) || 'nanashi',
    avatar: p.avatar || AVATAR[n.topic], text: p.text.trim(), ai: true,
    source: { title: n.title, url: n.url },
    replies: (p.replies || []).filter(r => ok(r.text)).slice(0, 2).map(r => ({
      author: String(r.author || '名無しさん').slice(0, 20), handle: String(r.handle || 'nanashi').replace(/\W/g, '').slice(0, 20) || 'nanashi',
      avatar: r.avatar || '🙂', text: r.text.trim(),
    })),
  };
});
if (!posts.length) { console.log('生成结果为空，跳过'); process.exit(0); }

const file = `${stamp}.json`;
await fs.writeFile(`packs/${file}`, JSON.stringify({ generated: now.toISOString(), posts }, null, 1));
const idx = JSON.parse(await fs.readFile('packs/index.json', 'utf8'));
idx.files = [...new Set([...(idx.files || []), file])];
await fs.writeFile('packs/index.json', JSON.stringify(idx, null, 2));
console.log(`写入 ${file}，${posts.length} 条`);
