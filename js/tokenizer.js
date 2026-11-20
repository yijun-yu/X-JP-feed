// 统一的 文本 → tokens 管道（预制帖子 & DeepSeek 实时回复共用）
// 注音由 kuromoji 形态素分析得到，而不是让大模型生成，避免多音字/专有名词读错。
// kuromoji 及词典托管在本仓库 vendor/ 下，在 Web Worker 中构建，不阻塞页面。
let worker, readyP, seq = 0;
const pending = new Map();

export function initTokenizer() {
  return readyP ||= new Promise((res, rej) => {
    worker = new Worker(new URL('./tok-worker.js', import.meta.url));
    const timer = setTimeout(() => rej(new Error('词典加载超时（90 秒）')), 90000);
    worker.onmessage = e => {
      const d = e.data;
      if (d.type === 'ready') { clearTimeout(timer); res(); }
      else if (d.type === 'error') { clearTimeout(timer); rej(new Error(d.error)); }
      else if (d.type === 'result') {
        const p = pending.get(d.id); pending.delete(d.id);
        if (p) d.error ? p.rej(new Error(d.error)) : p.res(d.out);
      }
    };
    worker.onerror = e => { clearTimeout(timer); rej(new Error(e.message || 'Worker 出错')); };
  });
}
async function rawTokenize(lines) {
  await initTokenizer();
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ id, lines }); });
}

export const kata2hira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const hasKanji = s => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆ヶ]/.test(s);

// 把读音只挂在汉字部分上：食べる → [食,た][べる]
function splitRuby(s, r) {
  const hs = kata2hira(s);
  let i = s.length, j = r.length;
  while (i > 0 && j > 0 && !hasKanji(s[i - 1]) && hs[i - 1] === r[j - 1]) { i--; j--; }
  let a = 0, b = 0;
  while (a < i && b < j && !hasKanji(s[a]) && hs[a] === r[b]) { a++; b++; }
  const out = [];
  if (a) out.push([s.slice(0, a), null]);
  out.push([s.slice(a, i), r.slice(b, j) || null]);
  if (i < s.length) out.push([s.slice(i), null]);
  return out;
}

export async function tokenize(text) {
  const lines = String(text || '').split('\n');
  const res = await rawTokenize(lines);
  const out = [];
  res.forEach((toks, li) => {
    if (li) out.push({ s: '\n', br: true, pos: '記号' });
    for (const [s, reading, basic, pos, pos1] of toks) {
      const r = reading && reading !== '*' ? kata2hira(reading) : '';
      out.push({
        s, r,
        b: basic && basic !== '*' ? basic : s,
        pos, pos1,
        ruby: hasKanji(s) && r ? splitRuby(s, r) : null,
      });
    }
  });
  return out;
}

const CONTENT_POS = ['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞'];
export function contentWord(t) {
  if (!t || t.br || !CONTENT_POS.includes(t.pos)) return false;
  if (['数', '非自立', '接尾', '代名詞'].includes(t.pos1)) return false;
  return /[ぁ-んァ-ヶー\u4e00-\u9fff]/.test(t.s) && t.s.length + (hasKanji(t.s) ? 1 : 0) > 1;
}
export const wordKey = t => t.b + '|' + t.pos;
