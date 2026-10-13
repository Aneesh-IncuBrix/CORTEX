'use strict';
const STOP = new Set('a an and are as at be by can do does for from has have how i in is it its me my of on or our please should so that the their them then this to use used uses using we what when where which who why will with you your agent agents task tasks'.split(' '));
const ALWAYS = ['Explore', 'jev-router:scout', 'jev-router:quick'];

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem);
}

function bm25Scores(docs, query, k1 = 1.2, b = 0.75) {
  const N = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(query)];
  return docs.map(d => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    return s;
  });
}

function shortlist(agents, prompt, k = 12) {
  const docs = agents.map(a => tokenize(`${a.name.replace(/[:_-]/g, ' ')} ${a.description}`));
  const scores = bm25Scores(docs, tokenize(prompt));
  const ranked = agents.map((a, i) => ({ ...a, score: scores[i] })).sort((x, y) => y.score - x.score);
  const top = ranked.filter(a => a.score > 0).slice(0, k);
  for (const name of ALWAYS) {
    if (top.some(a => a.name === name)) continue;
    const a = ranked.find(r => r.name === name);
    if (a) top.push(a);
  }
  return top;
}

module.exports = { shortlist, tokenize, bm25Scores, ALWAYS };
