import { db } from './db.js';
import { tokenize, initTokenizer, contentWord, wordKey } from './tokenizer.js';
import * as ai from './deepseek.js';

// ---------- 常量 ----------
const TOPICS = [['all', 'すべて'], ['ai', 'AI'], ['anime', 'アニメ'], ['game', 'ゲーム'], ['society', '社会'], ['history', '歴史'], ['mine', '自分']];
const MODE_NAMES = { beginner: '起步', advanced: '进阶', pure: '纯享' };
const MODE_DESC = {
  beginner: '全部注音 + 帖子下方「生词条」显示中文核心义（需 API Key 自动补全）',
  advanced: '全部注音 + 语法透视：助词胶囊、动词/助动词虚线；点词查释义',
  pure: '眼熟词（见过≥3次且没查过，或标记为已掌握）隐藏注音，点一下显示；顽固生词（查过≥2次）黄色下划线',
};
const PERSONAS = [
  { name: '草生えるマン', handle: 'kusa_www', avatar: '🤣', persona: '何でも面白がる乐子人。語尾にwwwや「草」を多用' },
  { name: '反論おじさん', handle: 'hanron_oji', avatar: '😤', persona: '必ず反対意見を言う杠精。ただし人格攻撃はしない' },
  { name: '解説ニキ', handle: 'kaisetsu_niki', avatar: '🤓', persona: '背景知識や豆知識を語る懂哥。少し早口' },
  { name: '限界オタク', handle: 'genkai_otaku', avatar: '😭', persona: '感情が爆発しがちなオタク。「尊い」「無理」などを使う' },
  { name: '冷静な社会人', handle: 'calm_salaryman', avatar: '🧐', persona: '落ち着いて丁寧語で現実的なことを言う' },
  { name: '古参ねらー', handle: 'nanashi_san', avatar: '👴', persona: '皮肉っぽい古参ネット民。阴阳怪气だが面白い' },
  { name: 'ほのぼの学生', handle: 'honobono_jk', avatar: '🌸', persona: '明るくてやさしい若者。絵文字を少し使う' },
  { name: '歴史警察', handle: 'rekishi_police', avatar: '📜', persona: '歴史や事実の細かい間違いを指摘したがる' },
];
const S_DEFAULT = { mode: 'beginner', level: 1, apiKey: '', apiBase: 'https://api.deepseek.com', model: 'deepseek-chat' };

const st = {
  view: 'home', prevView: 'home', thread: null, topic: 'all', ptab: 'mine',
  settings: { ...S_DEFAULT }, words: new Map(), posts: new Map(), toks: new Map(),
  seen: new Set(), liked: new Set(), daily: {}, tokReady: false, tokErr: null,
  gq: [], glossAsked: new Set(), compose: null,
};

// ---------- 小工具 ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv');
function rel(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'たった今';
  if (d < 3600) return Math.floor(d / 60) + '分';
  if (d < 86400) return Math.floor(d / 3600) + '時間';
  const x = new Date(t); return (x.getMonth() + 1) + '月' + x.getDate() + '日';
}
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
const isMostlyJa = s => { const t = s.replace(/\s/g, ''); const kana = (t.match(/[ぁ-んァ-ヶ]/g) || []).length; return t.length > 0 && kana / t.length > 0.25; };
const saveSettings = () => db.put('kv', st.settings, 'settings');
const savePost = p => db.put('posts', p);
const dirty = new Set(); let saveT;
function saveWord(w) { dirty.add(w.k); clearTimeout(saveT); saveT = setTimeout(() => { const arr = [...dirty].map(k => st.words.get(k)); dirty.clear(); db.putMany('words', arr); }, 800); }
function touchDay() {
  const d = st.daily, t = today();
  if (d.date === t) return;
  const y = new Date(Date.now() - 86400000).toLocaleDateString('sv');
  d.streak = d.date === y ? (d.streak || 0) + 1 : 1;
  d.date = t; d.lookups = 0; d.newKnown = 0;
  db.put('kv', d, 'daily');
}
function bumpDaily(f) { touchDay(); st.daily[f] = (st.daily[f] || 0) + 1; db.put('kv', st.daily, 'daily'); }

// ---------- 词库 ----------
function getWord(t) {
  const k = wordKey(t);
  let w = st.words.get(k);
  if (!w) { w = { k, b: t.b, r: t.r, pos: t.pos, seen: 0, clicked: 0, known: false, cn: '', note: '', srs: 0, t0: Date.now() }; st.words.set(k, w); }
  return w;
}
const isFamiliar = w => !!w && (w.known || (w.seen >= 3 && w.clicked === 0));
const isStubborn = w => !!w && !w.known && w.clicked >= 2;

async function tokFor(id, text) {
  if (!st.toks.has(id)) st.toks.set(id, await tokenize(text));
  return st.toks.get(id);
}
function markSeen(id, toks) {
  if (st.seen.has(id)) return;
  st.seen.add(id);
  const ks = new Set();
  toks.forEach(t => { if (contentWord(t) && !ks.has(wordKey(t))) { ks.add(wordKey(t)); const w = getWord(t); w.seen++; saveWord(w); } });
}

// ---------- 渲染：tokens ----------
function rubyHTML(t) {
  return t.ruby ? t.ruby.map(([x, r]) => (r ? `<ruby>${esc(x)}<rt>${esc(r)}</rt></ruby>` : esc(x))).join('') : esc(t.s);
}
function tokHTML(t, i, ctx) {
  if (t.br) return '<br>';
  const m = st.settings.mode, cw = contentWord(t), w = cw ? st.words.get(wordKey(t)) : null;
  const cls = ['t'];
  if (m === 'advanced') { if (t.pos === '助詞') cls.push('pt'); if (t.pos === '動詞' || t.pos === '助動詞') cls.push('vb'); }
  if (m === 'pure' && isStubborn(w)) cls.push('stub');
  if (m === 'pure' && t.ruby && isFamiliar(w)) cls.push('hr');
  return `<span class="${cls.join(' ')}" data-ctx="${esc(ctx)}" data-i="${i}">${rubyHTML(t)}</span>`;
}
const toksHTML = (toks, ctx) => toks.map((t, i) => tokHTML(t, i, ctx)).join('');

function glossHTML(toks, ctx, sentence) {
  const ks = new Set(), items = [];
  toks.forEach((t, i) => {
    if (!contentWord(t)) return;
    const k = wordKey(t); if (ks.has(k)) return; ks.add(k);
    const w = st.words.get(k); if (isFamiliar(w)) return;
    items.push({ t, i, w, k });
  });
  items.sort((a, b) => (a.w?.seen || 0) - (b.w?.seen || 0));
  const top = items.slice(0, 5);
  const need = top.filter(x => !x.w?.cn && !st.glossAsked.has(x.k)).map(x => x.k);
  if (need.length && ai.hasKey() && sentence) { need.forEach(k => st.glossAsked.add(k)); st.gq.push({ ctx, keys: need, sentence }); }
  return top.map(({ t, i, w }) => `<button class="chip" data-ctx="${esc(ctx)}" data-i="${i}">${esc(t.b)}<em>${w?.cn ? esc(w.cn) : '?'}</em></button>`).join('');
}
let glossBusy = false;
async function pumpGloss() {
  if (glossBusy || !ai.hasKey()) return;
  glossBusy = true;
  while (st.gq.length) {
    const job = st.gq.shift();
    const need = job.keys.filter(k => !st.words.get(k)?.cn);
    if (!need.length) continue;
    try {
      const g = await ai.glossBatch(need.map(k => st.words.get(k).b), job.sentence);
      need.forEach(k => { const w = st.words.get(k); const v = g[w.b]; if (v) { w.cn = String(v).slice(0, 6); saveWord(w); } });
      document.querySelectorAll(`[data-gloss="${CSS.escape(job.ctx)}"]`).forEach(el => { el.innerHTML = glossHTML(st.toks.get(job.ctx), job.ctx, null); });
    } catch (e) { console.warn(e); toast(e.message); st.gq = []; break; }
  }
  glossBusy = false;
}

// ---------- 渲染：帖子 ----------
const repliesOf = id => [...st.posts.values()].filter(p => p.parentId === id).sort((a, b) => a.time - b.time);

async function postCard(p, root = false) {
  const toks = await tokFor(p.id, p.text);
  markSeen(p.id, toks);
  const sentence = toks.map(t => t.s).join('');
  const q = p.quoteId && st.posts.get(p.quoteId);
  const qt = q ? await tokFor(q.id, q.text) : null;
  const nRep = repliesOf(p.id).length;
  const liked = st.liked.has(p.id);
  return `<article class="post${root ? ' root' : ''}" data-id="${esc(p.id)}">
  <div class="av">${esc(p.avatar || '🙂')}</div>
  <div class="pb">
    <div class="hd"><b>${esc(p.author)}</b><span class="mut">@${esc(p.handle)} · ${rel(p.time)}</span>${p.level ? `<span class="lv lv${p.level}">Lv${p.level}</span>` : ''}${p.ai ? '<span class="aitag">AI生成</span>' : ''}</div>
    <div class="txt" lang="ja">${toksHTML(toks, p.id)}</div>
    ${q ? `<div class="quote" data-open="${esc(q.parentId || q.id)}"><div class="mut small"><b>${esc(q.author)}</b> @${esc(q.handle)}</div><div lang="ja">${toksHTML(qt, q.id)}</div></div>` : ''}
    ${st.settings.mode === 'beginner' ? `<div class="gloss" data-gloss="${esc(p.id)}">${glossHTML(toks, p.id, sentence)}</div>` : ''}
    ${p.source?.url ? `<a class="src" href="${esc(p.source.url)}" target="_blank" rel="noopener">🔗 ${esc(p.source.title || '出典')}</a>` : ''}
    <button class="trbtn" data-act="tr">ポストを翻訳</button>
    <div class="trout">${esc(p.tr || '')}</div>
    ${p.mine && p.polishable ? `<details class="polish" data-id="${esc(p.id)}"><summary>📝 私教润色</summary><div class="pbody">加载中…</div></details>` : ''}
    <div class="acts">
      <button data-act="reply">💬 <span>${nRep || ''}</span></button>
      <button data-act="rt">🔁</button>
      <button data-act="like" class="${liked ? 'on' : ''}">${liked ? '❤️' : '🤍'}</button>
    </div>
  </div>
</article>`;
}

async function polishHTML(p) {
  const r = p.polish || {};
  const c = await tokFor(p.id + '_pc', r.corrected || '');
  const n = await tokFor(p.id + '_pn', r.natural || '');
  const iss = r.issues || [];
  return `<div class="pl"><div class="small mut">✏️ 纠错版</div><div lang="ja">${toksHTML(c, p.id + '_pc')}</div></div>
<div class="pl"><div class="small mut">🇯🇵 更地道</div><div lang="ja">${toksHTML(n, p.id + '_pn')}</div></div>
${iss.length ? `<ul class="iss">${iss.map(x => `<li><s>${esc(x.from)}</s> → <b>${esc(x.to)}</b><div class="small mut">${esc(x.why)}</div></li>`).join('')}</ul>` : '<div class="small">没有发现明显问题 👍</div>'}`;
}

// ---------- 视图 ----------
async function feedHTML() {
  const lvl = +st.settings.level;
  let list = [...st.posts.values()].filter(p => !p.parentId && (st.topic === 'all' || p.topic === st.topic));
  list.sort((a, b) => (((a.level || 0) > lvl) - ((b.level || 0) > lvl)) || b.time - a.time);
  list = list.slice(0, 60);
  if (!list.length) return `<div class="empty">这里还没有帖子。点右下角 ＋ 发一条吧。</div>`;
  return (await Promise.all(list.map(p => postCard(p)))).join('');
}
async function threadHTML(id) {
  const root = st.posts.get(id);
  if (!root) return '<div class="empty">帖子不存在</div>';
  const reps = repliesOf(id);
  const cards = await Promise.all([postCard(root, true), ...reps.map(p => postCard(p))]);
  return cards.join('') + `<div class="replybar"><button class="btn wide" data-act="reply" data-id="${esc(id)}">💬 返信をポスト…</button></div>`;
}
async function profileHTML() {
  const ws = [...st.words.values()];
  const known = ws.filter(w => w.known).length, learning = ws.filter(w => !w.known && w.clicked > 0).length;
  touchDay();
  const tabs = [['mine', '我的帖子'], ['likes', '金句收藏'], ['words', '生词本']];
  let body = '';
  if (st.ptab === 'mine') {
    const l = [...st.posts.values()].filter(p => p.mine).sort((a, b) => b.time - a.time);
    body = l.length ? (await Promise.all(l.map(p => postCard(p)))).join('') : '<div class="empty">还没发过帖子</div>';
  } else if (st.ptab === 'likes') {
    const l = [...st.liked].map(id => st.posts.get(id)).filter(Boolean);
    body = l.length ? (await Promise.all(l.map(p => postCard(p)))).join('') : '<div class="empty">点 🤍 收藏喜欢的句子</div>';
  } else {
    const l = ws.filter(w => w.clicked > 0 || w.known).sort((a, b) => (a.known - b.known) || b.clicked - a.clicked);
    body = l.length ? `<div class="wlist">${l.map(w => `<div class="witem${w.known ? ' known' : ''}"><div><b lang="ja">${esc(w.b)}</b> <span class="mut">${esc(w.r)}</span> <span>${esc(w.cn)}</span><div class="small mut">见 ${w.seen} · 查 ${w.clicked} · 复习 ${w.srs || 0}${isStubborn(w) ? ' · 🔥顽固' : ''}</div></div><button class="btn sm" data-act="known" data-k="${esc(w.k)}">${w.known ? '↩︎' : '✅'}</button></div>`).join('')}</div>` : '<div class="empty">点过的词会出现在这里</div>';
  }
  return `<div class="stats">
  <div><b>${known}</b><span>已掌握</span></div><div><b>${learning}</b><span>学习中</span></div>
  <div><b>${ws.length}</b><span>见过的词</span></div><div><b>🔥${st.daily.streak || 1}</b><span>连续天数</span></div>
  <div><b>${st.daily.lookups || 0}</b><span>今日点查</span></div></div>
  <div class="tabs">${tabs.map(([k, n]) => `<button data-ptab="${k}" class="${st.ptab === k ? 'on' : ''}">${n}</button>`).join('')}</div>${body}`;
}
function settingsHTML() {
  const s = st.settings;
  return `<div class="set">
  <h3>阅读模式</h3>
  ${Object.keys(MODE_NAMES).map(m => `<label class="opt"><input type="radio" name="mode" value="${m}" ${s.mode === m ? 'checked' : ''}><div><b>${MODE_NAMES[m]}模式</b><div class="small mut">${MODE_DESC[m]}</div></div></label>`).join('')}
  <h3>难度</h3>
  <select data-set="level">${[1, 2, 3].map(l => `<option value="${l}" ${+s.level === l ? 'selected' : ''}>Lv${l}${['', '（N5~N4 冷启动）', '（N3）', '（原生）'][l]}</option>`).join('')}</select>
  <div class="small mut">决定优先推送哪些帖子，以及 NPC / 改写时的用词难度。</div>
  <h3>DeepSeek API</h3>
  <label class="small mut">API Key（只保存在本机浏览器）</label>
  <input type="password" data-set="apiKey" value="${esc(s.apiKey)}" placeholder="sk-...">
  <label class="small mut">API Base（若遇到 CORS 报错，填你的代理地址）</label>
  <input data-set="apiBase" value="${esc(s.apiBase)}">
  <label class="small mut">模型</label>
  <input data-set="model" value="${esc(s.model)}">
  <button class="btn" data-act="testapi">测试连接</button>
  <h3>数据</h3>
  <div class="row"><button class="btn" data-act="export">导出 JSON</button><label class="btn">导入 JSON<input type="file" id="imp" accept=".json" hidden></label><button class="btn danger" data-act="reset">清空本地数据</button></div>
  <div class="small mut">导出文件不含 API Key。可用于跨设备同步。</div>
  <h3>关于</h3><div class="small mut">X-JP v0.4 原型 · 注音由 kuromoji 本地分词生成 · 内容由 GitHub Actions 定时生成</div>
</div>`;
}

let rv = 0;
async function render() {
  const my = ++rv;
  let top = '', html = '';
  const needTok = st.view !== 'settings';
  if (needTok && !st.tokReady) {
    html = st.tokErr ? `<div class="empty">分词词典加载失败：${esc(st.tokErr)}<br>请检查网络后刷新。</div>` : '<div class="empty"><div class="spin"></div>首次加载分词词典（约 18MB，之后离线可用）…</div>';
  }
  if (st.view === 'home') {
    top = `<div class="tb-title">X-JP <span class="mode">${MODE_NAMES[st.settings.mode]} · Lv${st.settings.level}</span></div><div class="tabs scroll">${TOPICS.map(([k, n]) => `<button data-topic="${k}" class="${st.topic === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    if (st.tokReady) html = await feedHTML();
  } else if (st.view === 'thread') {
    top = `<div class="tb-title"><button class="back" data-act="back">←</button>ポスト</div>`;
    if (st.tokReady) html = await threadHTML(st.thread);
  } else if (st.view === 'profile') {
    top = `<div class="tb-title">我的主页</div>`;
    if (st.tokReady) html = await profileHTML();
  } else {
    top = `<div class="tb-title">设置</div>`; html = settingsHTML();
  }
  if (my !== rv) return;
  $('#top').innerHTML = top; $('#main').innerHTML = html;
  $('#fab').style.display = st.view === 'settings' ? 'none' : '';
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === (st.view === 'thread' ? st.prevView : st.view)));
  pumpGloss();
}
function go(view) { st.view = view; render(); window.scrollTo(0, 0); }
function openThread(id) { if (st.view !== 'thread') st.prevView = st.view; st.thread = id; go('thread'); }

// ---------- 查词弹窗 ----------
async function openWord(ctx, i) {
  const toks = st.toks.get(ctx); const t = toks?.[i];
  if (!t || t.br || t.pos === '記号') return;
  const w = contentWord(t) ? getWord(t) : null;
  if (w) { w.clicked++; w.last = Date.now(); saveWord(w); bumpDaily('lookups'); }
  const sentence = toks.map(x => x.s).join('');
  const sheet = $('#sheet');
  const paint = (cn, note) => {
    sheet.innerHTML = `<div class="sh-bg" data-act="closesheet"></div><div class="sh">
      <div class="sh-word" lang="ja">${rubyHTML(t)}</div>
      <div class="mut">${esc(t.r || t.s)} · 原形 <span lang="ja">${esc(t.b)}</span> · ${esc(t.pos)}${t.pos1 && t.pos1 !== '*' ? '/' + esc(t.pos1) : ''}</div>
      <div class="sh-cn">${esc(cn)}</div><div class="sh-note">${esc(note)}</div>
      ${w ? `<div class="small mut">见过 ${w.seen} 次 · 查过 ${w.clicked} 次${isStubborn(w) ? ' · 🔥 顽固生词，NPC 会在对线中复习它' : ''}</div>
      <button class="btn wide" data-act="known" data-k="${esc(w.k)}">${w.known ? '↩︎ 取消已掌握' : '✅ 我已掌握这个词'}</button>` : ''}
    </div>`;
  };
  sheet.classList.remove('hidden');
  if (w && w.cn && w.note) return paint(w.cn, w.note);
  if (!ai.hasKey()) return paint(w?.cn || '', '未设置 DeepSeek API Key，只显示读音和词性。');
  paint(w?.cn || '…', '查询中…');
  try {
    const r = await ai.explain(t.s, t.b, sentence);
    if (w) { w.cn = w.cn || String(r.cn || '').slice(0, 6); w.note = r.note || ''; saveWord(w); }
    if (!sheet.classList.contains('hidden')) paint(w?.cn || r.cn, r.note);
  } catch (e) { paint(w?.cn || '', e.message); }
}

// ---------- 发帖 / 改写 / NPC ----------
function openCompose(opt) {
  st.compose = { parentId: opt.parentId || null, quoteId: opt.quoteId || null, viaRewrite: false, vers: [] };
  const target = st.posts.get(opt.parentId || opt.quoteId);
  const title = opt.parentId ? '返信' : opt.quoteId ? '引用ポスト' : '新しいポスト';
  $('#modal').innerHTML = `<div class="md">
    <div class="md-hd"><button class="back" data-act="closemd">✕</button><b>${title}</b><button class="btn pri" data-act="send">ポスト</button></div>
    ${target ? `<div class="quote small"><b>${esc(target.author)}</b>：${esc(target.text.slice(0, 80))}</div>` : ''}
    <textarea id="cin" lang="ja" placeholder="日语 / 中混日 / 纯中文都可以&#10;例：このアニメの作画は神级だけど、剧情太拉胯了"></textarea>
    <div class="md-tools"><button class="btn" data-act="rewrite">🪄 日网化改写</button><span class="small mut">建议选一个版本后自己再敲一遍，记得更牢</span></div>
    <div id="vers"></div>
  </div>`;
  $('#modal').classList.remove('hidden');
  setTimeout(() => $('#cin')?.focus(), 50);
}
const closeCompose = () => { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; st.compose = null; };

async function submit(text) {
  const c = st.compose;
  const parentId = c.parentId;
  const id = 'u' + Date.now();
  const p = {
    id, author: 'あなた', handle: 'me', avatar: '🧑‍💻', time: Date.now(), text, mine: true,
    parentId, quoteId: c.quoteId, topic: parentId ? st.posts.get(parentId)?.topic : 'mine', level: 0,
    polishable: !c.viaRewrite && isMostlyJa(text),
  };
  st.posts.set(id, p); await savePost(p); touchDay();
  closeCompose();
  if (parentId) openThread(parentId); else openThread(id);
  const rootId = parentId || id;
  npcReply(rootId, parentId ? 1 + Math.round(Math.random()) : 3);
  setTimeout(() => { const n = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]; toast(`❤️ ${n.name} さんがいいねしました`); }, 4000 + Math.random() * 4000);
}

async function npcReply(rootId, n) {
  if (!ai.hasKey()) { toast('设置 API Key 后，NPC 网友会来回复你'); return; }
  const root = st.posts.get(rootId);
  const all = [root, ...repliesOf(rootId)];
  const thread = all.slice(-10).map(p => ({ who: p.mine ? 'ユーザー' : p.author, text: p.text }));
  const recent = new Set(all.slice(-3).map(p => p.handle));
  const pool = PERSONAS.filter(p => !recent.has(p.handle)).sort(() => Math.random() - 0.5).slice(0, n);
  const targets = [...st.words.values()].filter(w => !w.known && w.clicked > 0).sort((a, b) => b.clicked - a.clicked).slice(0, 4);
  toast('💭 网友们正在输入…');
  try {
    const reps = await ai.npcReplies(thread, pool, targets.map(w => w.b), +st.settings.level);
    const t0 = Date.now();
    for (const [i, x] of reps.entries()) {
      const per = pool.find(p => p.handle === x.handle) || pool[i % pool.length];
      const p = { id: `n${t0}_${i}`, parentId: rootId, author: per.name, handle: per.handle, avatar: per.avatar, text: String(x.text).trim(), time: t0 + i * 1000, npc: true, topic: root.topic };
      st.posts.set(p.id, p); await savePost(p);
      const toks = await tokFor(p.id, p.text);
      const hit = new Set(toks.map(t => t.b));
      targets.forEach(w => { if (hit.has(w.b)) { w.srs = (w.srs || 0) + 1; saveWord(w); } });
    }
    toast(`💬 ${reps.length} 件の返信`);
    if ((st.view === 'thread' && st.thread === rootId) || st.view === 'home') render();
  } catch (e) { toast('NPC 生成失败：' + e.message); }
}

// ---------- 内容包 ----------
async function loadPacks() {
  let idx;
  try { idx = await (await fetch('packs/index.json', { cache: 'no-cache' })).json(); } catch { return 0; }
  const loaded = new Set((await db.get('kv', 'loadedPacks')) || []);
  let n = 0;
  for (const f of idx.files || []) {
    if (loaded.has(f)) continue;
    try {
      const pk = await (await fetch('packs/' + f, { cache: 'no-cache' })).json();
      const items = [];
      for (const p of pk.posts || []) {
        if (st.posts.has(p.id)) continue;
        const { replies, ...rest } = p;
        const root = { ...rest, parentId: null, time: Date.parse(p.time) || Date.now() };
        items.push(root); n++;
        (replies || []).forEach((r, i) => items.push({ avatar: '🙂', ...r, id: `${p.id}_r${i}`, parentId: p.id, time: root.time + (i + 1) * 60000, topic: p.topic, ai: p.ai }));
      }
      await db.putMany('posts', items);
      items.forEach(x => st.posts.set(x.id, x));
      loaded.add(f);
    } catch (e) { console.warn('pack', f, e); }
  }
  await db.put('kv', [...loaded], 'loadedPacks');
  return n;
}

// ---------- 事件 ----------
async function onAct(act, a) {
  const postEl = a.closest('.post');
  const p = postEl && st.posts.get(postEl.dataset.id);
  switch (act) {
    case 'compose': return openCompose({});
    case 'back': return go(st.prevView || 'home');
    case 'closesheet': return $('#sheet').classList.add('hidden');
    case 'closemd': return closeCompose();
    case 'reply': return openCompose({ parentId: p ? (p.parentId || p.id) : a.dataset.id });
    case 'rt': return openCompose({ quoteId: p.id });
    case 'like': {
      st.liked.has(p.id) ? st.liked.delete(p.id) : st.liked.add(p.id);
      db.put('kv', [...st.liked], 'liked');
      const on = st.liked.has(p.id); a.classList.toggle('on', on); a.textContent = on ? '❤️' : '🤍';
      if (on) toast('已收藏到「金句收藏」');
      return;
    }
    case 'tr': {
      const out = postEl.querySelector('.trout');
      if (out.classList.contains('show')) { out.classList.remove('show'); a.textContent = 'ポストを翻訳'; return; }
      if (!p.tr) {
        if (!ai.hasKey()) return toast('翻译需要 DeepSeek API Key');
        a.textContent = '翻訳中…';
        try { p.tr = await ai.translate(p.text); savePost(p); } catch (e) { a.textContent = 'ポストを翻訳'; return toast(e.message); }
        out.textContent = p.tr;
      }
      out.classList.add('show'); a.textContent = '翻訳を隠す';
      return;
    }
    case 'known': {
      const w = st.words.get(a.dataset.k); if (!w) return;
      w.known = !w.known; saveWord(w); if (w.known) bumpDaily('newKnown');
      toast(w.known ? '✅ 已掌握' : '已取消');
      $('#sheet').classList.add('hidden');
      return render();
    }
    case 'rewrite': {
      const txt = $('#cin').value.trim(); if (!txt) return toast('先写点什么');
      if (!ai.hasKey()) return toast('改写需要 DeepSeek API Key');
      a.disabled = true; a.textContent = '改写中…';
      try {
        const vers = await ai.rewrite(txt, +st.settings.level);
        if (!st.compose) return;
        st.compose.vers = vers;
        const html = await Promise.all(vers.map(async (v, i) => {
          const ctx = `ver${Date.now()}_${i}`;
          const tk = await tokFor(ctx, v.text);
          return `<div class="ver"><div class="vs">${esc(v.style)}</div><div class="vt" lang="ja">${toksHTML(tk, ctx)}</div><button class="btn sm" data-act="use" data-v="${i}">填入</button></div>`;
        }));
        $('#vers').innerHTML = `<div class="small mut">原意：${esc(txt)}</div>` + html.join('');
      } catch (e) { toast(e.message); }
      a.disabled = false; a.textContent = '🪄 日网化改写';
      return;
    }
    case 'use': {
      $('#cin').value = st.compose.vers[+a.dataset.v].text; st.compose.viaRewrite = true; return;
    }
    case 'send': {
      const txt = $('#cin').value.trim(); if (!txt) return;
      return submit(txt);
    }
    case 'testapi': {
      a.textContent = '测试中…';
      try { await ai.ping(); toast('✅ 连接成功'); } catch (e) { toast(e.message); }
      a.textContent = '测试连接'; return;
    }
    case 'export': {
      const { apiKey, ...settings } = st.settings;
      const data = { app: 'x-jp', version: 1, exported: new Date().toISOString(), settings, words: [...st.words.values()], posts: [...st.posts.values()].filter(p => p.mine || p.npc), liked: [...st.liked], daily: st.daily };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const l = document.createElement('a'); l.href = url; l.download = `x-jp-backup-${today()}.json`; l.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    case 'reset': {
      if (!confirm('确定清空所有本地数据（词库、帖子、设置）？')) return;
      await Promise.all(['kv', 'words', 'posts'].map(s => db.clear(s)));
      location.reload(); return;
    }
  }
}

function bind() {
  document.addEventListener('click', e => {
    const el = e.target;
    const nav = el.closest('[data-nav]'); if (nav) return go(nav.dataset.nav);
    const tp = el.closest('[data-topic]'); if (tp) { st.topic = tp.dataset.topic; return render(); }
    const pt = el.closest('[data-ptab]'); if (pt) { st.ptab = pt.dataset.ptab; return render(); }
    const tok = el.closest('.t[data-ctx], .chip[data-ctx]');
    if (tok) {
      if (tok.classList.contains('hr')) { tok.classList.remove('hr'); return; }
      return openWord(tok.dataset.ctx, +tok.dataset.i);
    }
    const a = el.closest('[data-act]'); if (a) return onAct(a.dataset.act, a);
    const op = el.closest('[data-open]'); if (op) return openThread(op.dataset.open);
    const post = el.closest('.post');
    if (post && !el.closest('a,details')) {
      const p = st.posts.get(post.dataset.id);
      const rid = p.parentId || p.id;
      if (!(st.view === 'thread' && st.thread === rid)) openThread(rid);
    }
  });
  document.addEventListener('toggle', async e => {
    const d = e.target;
    if (!d.matches?.('details.polish') || !d.open) return;
    const p = st.posts.get(d.dataset.id); const body = d.querySelector('.pbody');
    try {
      if (!p.polish) {
        if (!ai.hasKey()) { body.textContent = '润色需要 DeepSeek API Key'; return; }
        p.polish = await ai.polish(p.text); savePost(p);
      }
      body.innerHTML = await polishHTML(p);
    } catch (err) { body.textContent = err.message; }
  }, true);
  document.addEventListener('change', async e => {
    const el = e.target;
    if (el.name === 'mode') { st.settings.mode = el.value; saveSettings(); toast(`已切换到${MODE_NAMES[el.value]}模式`); return; }
    if (el.dataset.set) { st.settings[el.dataset.set] = el.dataset.set === 'level' ? +el.value : el.value.trim(); saveSettings(); return; }
    if (el.id === 'imp' && el.files[0]) {
      try {
        const d = JSON.parse(await el.files[0].text());
        if (d.app !== 'x-jp') throw new Error('不是 X-JP 备份文件');
        await db.putMany('words', d.words || []); await db.putMany('posts', d.posts || []);
        await db.put('kv', d.liked || [], 'liked'); if (d.daily) await db.put('kv', d.daily, 'daily');
        await db.put('kv', { ...st.settings, ...(d.settings || {}), apiKey: st.settings.apiKey }, 'settings');
        alert('导入成功'); location.reload();
      } catch (err) { toast('导入失败：' + err.message); }
    }
  });
}

// ---------- 启动 ----------
async function init() {
  $('#app').innerHTML = `<header id="top"></header><main id="main"></main>
  <button id="fab" data-act="compose" aria-label="ポスト">＋</button>
  <nav id="nav"><button data-nav="home">🏠</button><button data-nav="profile">👤</button><button data-nav="settings">⚙️</button></nav>
  <div id="sheet" class="hidden"></div><div id="modal" class="hidden"></div><div id="toast"></div>`;
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  st.settings = { ...S_DEFAULT, ...((await db.get('kv', 'settings')) || {}) };
  ai.configure(() => st.settings);
  ((await db.all('words')) || []).forEach(w => st.words.set(w.k, w));
  ((await db.all('posts')) || []).forEach(p => st.posts.set(p.id, p));
  st.liked = new Set((await db.get('kv', 'liked')) || []);
  st.daily = (await db.get('kv', 'daily')) || {};
  touchDay();
  render();
  const [n] = await Promise.all([
    loadPacks(),
    initTokenizer().then(() => { st.tokReady = true; }).catch(e => { st.tokErr = e.message || String(e); }),
  ]);
  render();
  if (n) toast(`🆕 新しいポスト ${n} 件`);
  if (!st.settings.apiKey) setTimeout(() => toast('提示：在 ⚙️ 设置里填 DeepSeek Key 解锁释义、翻译、NPC 对线'), 1500);
}
init();
