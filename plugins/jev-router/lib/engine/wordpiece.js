'use strict';
// Zero-dependency BERT WordPiece tokenizer matching all-MiniLM-L6-v2's tokenizer.json
// (BertNormalizer lowercase + strip accents, BertPreTokenizer, WordPiece "##").

function isPunct(cp) {
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)
    || /\p{P}/u.test(String.fromCodePoint(cp));
}

function isChinese(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF)
    || (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF)
    || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

class WordPiece {
  constructor(tokenizerJson) {
    const m = tokenizerJson && tokenizerJson.model;
    if (!m || !m.vocab) throw new Error('tokenizer.json has no WordPiece vocab');
    this.vocab = new Map(Object.entries(m.vocab));
    this.prefix = m.continuing_subword_prefix || '##';
    this.maxChars = m.max_input_chars_per_word || 100;
    const id = t => {
      const v = this.vocab.get(t);
      if (v === undefined) throw new Error(`vocab is missing ${t}`);
      return v;
    };
    this.unk = id(m.unk_token || '[UNK]');
    this.cls = id('[CLS]');
    this.sep = id('[SEP]');
  }

  normalize(text) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xFFFD) continue;
      if (/\s/u.test(ch)) { out += ' '; continue; }
      if (/\p{Cc}/u.test(ch)) continue;
      out += isChinese(cp) ? ` ${ch} ` : ch;
    }
    return out.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  }

  preTokenize(text) {
    const words = [];
    for (const chunk of text.split(' ')) {
      if (!chunk) continue;
      let cur = '';
      for (const ch of chunk) {
        if (isPunct(ch.codePointAt(0))) {
          if (cur) words.push(cur);
          words.push(ch);
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  wordPiece(word) {
    const chars = [...word];
    if (chars.length > this.maxChars) return [this.unk];
    const ids = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found = null;
      while (start < end) {
        const sub = (start > 0 ? this.prefix : '') + chars.slice(start, end).join('');
        const v = this.vocab.get(sub);
        if (v !== undefined) { found = v; break; }
        end--;
      }
      if (found === null) return [this.unk];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  encode(text, maxLen = 256) {
    const ids = [];
    for (const w of this.preTokenize(this.normalize(text))) {
      for (const id of this.wordPiece(w)) ids.push(id);
      if (ids.length >= maxLen - 2) break;
    }
    return [this.cls, ...ids.slice(0, maxLen - 2), this.sep];
  }
}

module.exports = { WordPiece };
