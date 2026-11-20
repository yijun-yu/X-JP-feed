// 统一的 文本 → tokens 管道（预制帖子 & DeepSeek 实时回复共用）
// 注音由 kuromoji 形态素分析得到，而不是让大模型生成，避免多音字/专有名词读错。
const DIC = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
let tkp;

export function initTokenizer() {
  return tkp ||= new Promise((res, rej) => {
    if (!window.kuromoji) return rej(new Error('kuromoji 脚本未加载'));
    window.kuromoji.builder({ dicPath: DIC }).build((e, t) => (e ? rej(e) : res(t)));
  });
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
  const t = await initTokenizer();
  const out = [];
  String(text || '').split('\n').forEach((line, li) => {
    if (li) out.push({ s: '\n', br: true, pos: '記号' });
    if (!line) return;
    for (const m of t.tokenize(line)) {
      const s = m.surface_form;
      const r = m.reading && m.reading !== '*' ? kata2hira(m.reading) : '';
      out.push({
        s, r,
        b: m.basic_form && m.basic_form !== '*' ? m.basic_form : s,
        pos: m.pos, pos1: m.pos_detail_1,
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
