// DeepSeek 前端直连（OpenAI 兼容格式）。大模型只负责产出“纯文本日语”，注音交给本地分词器。
let getS = () => ({});
export const configure = f => { getS = f; };
export const hasKey = () => !!getS().apiKey;

export async function call(messages, { json = true, temperature = 1.0, max_tokens = 1500 } = {}) {
  const s = getS();
  if (!s.apiKey) throw new Error('请先在 ⚙️ 设置里填入 DeepSeek API Key');
  const url = (s.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
        body: JSON.stringify({
          model: s.model || 'deepseek-chat', messages, temperature, max_tokens, stream: false,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (e) {
      throw new Error('网络/CORS 错误：' + e.message + '（可在设置里改用代理 API Base）');
    }
    if (!res.ok) throw new Error('API ' + res.status + ': ' + (await res.text()).slice(0, 160));
    const data = await res.json();
    const c = (data.choices?.[0]?.message?.content || '').trim();
    if (!json) return c;
    try { return JSON.parse(c.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { if (attempt) throw new Error('模型返回的 JSON 无法解析'); }
  }
}

const NOFURI = '日本語の本文には振り仮名・ローマ字・括弧付きの読みを一切付けないこと。';
const levelHint = l => l <= 1
  ? '語彙はJLPT N5〜N4の基本語を中心に、文は短く。ただし自然なネット口語で。'
  : l == 2 ? '語彙はJLPT N3程度まで。' : '語彙制限なし。ネイティブのネット表現で。';
const levelHintCn = l => l <= 1 ? '用词尽量是 JLPT N5~N4 基础词，句子短。' : l == 2 ? '用词控制在 N3 左右。' : '不限难度。';

export async function ping() {
  return call([{ role: 'user', content: '「OK」とだけ返して' }], { json: false, max_tokens: 10 });
}

export async function glossBatch(words, sentence) {
  const r = await call([
    { role: 'system', content: '你是日语词典。给出句子中每个日语词在该语境下最核心的中文释义，每个不超过4个汉字。只输出JSON：{"glosses":{"原词":"释义"}}，键必须与给定的词完全一致。' },
    { role: 'user', content: `句子：${sentence}\n词：${words.join('、')}` },
  ], { temperature: 0.2, max_tokens: 400 });
  return r.glosses || {};
}

export async function explain(surface, base, sentence) {
  return call([
    { role: 'system', content: '你是日语词典。根据句子语境解释该词。只输出JSON：{"cn":"不超过6字的中文核心义","note":"不超过50字的中文用法/语感说明"}' },
    { role: 'user', content: `句子：${sentence}\n词：${surface}（原形：${base}）` },
  ], { temperature: 0.2, max_tokens: 300 });
}

export async function translate(text) {
  return call([
    { role: 'system', content: '把下面的日语网帖翻译成自然的简体中文，保留网络语气。只输出译文。' },
    { role: 'user', content: text },
  ], { json: false, temperature: 0.3 });
}

export async function rewrite(input, level) {
  const r = await call([
    { role: 'system', content: `你是日本网友写作教练。把用户输入（可能是中文、中日混杂或不地道的日语）改写成日本 X 用户会发的地道日语帖子，保持原意。给出3个版本，只输出JSON：{"versions":[{"style":"普通吐槽","text":"..."},{"style":"2ch阴阳怪气","text":"..."},{"style":"极简口语","text":"..."}]}。${NOFURI}${levelHintCn(level)}` },
    { role: 'user', content: input },
  ], { temperature: 0.9 });
  return (r.versions || []).filter(v => v && v.text);
}

export async function polish(text) {
  return call([
    { role: 'system', content: `你是日语私教。用户写了一条日语网帖。请给出：corrected（只修正语法和用词错误，尽量保留原句）、natural（日本网友会写的更地道版本）、issues（最多5条，from 原文片段，to 修改后，why 用不超过40字的中文解释）。${NOFURI}只输出JSON：{"corrected":"","natural":"","issues":[{"from":"","to":"","why":""}]}` },
    { role: 'user', content: text },
  ], { temperature: 0.3 });
}

export async function npcReplies(thread, personas, targets, level) {
  const sys = `あなたは日本のSNS（X）の住人を演じる脚本家です。指定された複数のキャラクターとして、スレッドへの返信を書いてください。
ルール：
- 全て自然な日本語のネット口語。中国語は使わない。
- ${NOFURI}
- 1件あたり20〜80文字程度。キャラごとに口調をはっきり変える。
- ${levelHint(level)}
- ユーザーの日本語の間違いをいちいち指摘せず、自然な返しの中で正しい表現を使う。
- 次の単語を、スレッド全体でそれぞれ最低1回は自然に使うこと：${targets.length ? targets.join('、') : '（なし）'}
出力はJSONのみ：{"replies":[{"handle":"キャラのhandle","text":"本文"}]}`;
  const user = `キャラクター：
${personas.map(p => `- handle:${p.handle} 名前:${p.name} 性格:${p.persona}`).join('\n')}

スレッド（古い順）：
${thread.map(x => `[${x.who}] ${x.text}`).join('\n')}

各キャラ1件ずつ、合計${personas.length}件の返信を書いて。`;
  const r = await call([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 1.1 });
  return (r.replies || []).filter(x => x && x.text);
}
