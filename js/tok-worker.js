// 分词在 Web Worker 中运行，避免词典解压/构建时卡死页面
self.window = self; // kuromoji 的打包代码里引用了 window
importScripts('../vendor/kuromoji/kuromoji.js');
let tk = null;
kuromoji.builder({ dicPath: '../vendor/kuromoji/dict/' }).build((e, t) => {
  if (e) { postMessage({ type: 'error', error: String(e && e.message || e) }); return; }
  tk = t; postMessage({ type: 'ready' });
});
onmessage = e => {
  const { id, lines } = e.data;
  try {
    const out = lines.map(line => (line ? tk.tokenize(line).map(m => [m.surface_form, m.reading, m.basic_form, m.pos, m.pos_detail_1]) : []));
    postMessage({ type: 'result', id, out });
  } catch (err) { postMessage({ type: 'result', id, error: String(err) }); }
};
