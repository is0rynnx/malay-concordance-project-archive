(() => {
  'use strict';

  const DEFAULT_PAGE_SIZE = 50;
  let pageSize = DEFAULT_PAGE_SIZE;
  let requestedPage = 1;
  const MAX_TERMS = 1500;
  const MAX_RESULTS = 25000;
  const DATA = 'data/';
  const tokenRe = /[\p{L}\p{M}\p{N}]+(?:[’'`´-][\p{L}\p{M}\p{N}]+)*/gu;
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
  const shardCache = new Map();
  const docCache = new Map();
  const vocabCache = new Map();
  let manifest = null;
  let lexicon = null;
  let foldMap = null;
  let searchResult = null;
  let currentPage = 1;
  let currentReader = null;
  let currentReaderChar = null;

  const modeHelp = {
    word: 'Find a word form. Add more words to require them in the same text; prefix a word with - to exclude it.',
    phrase: 'Find adjacent words in the order entered.',
    wildcard: 'Use * for any sequence of characters and ? for one character.',
    regex: 'Match a JavaScript regular expression against indexed word forms.',
    near: 'Use word1 ~5 word2 or word1 NEAR/5 word2.',
    morph: 'Expand one root through common Malay affix patterns.'
  };

  function norm(s) {
    return (s || '').normalize('NFKC').toLocaleLowerCase().replaceAll('’', "'").replaceAll('´', "'");
  }

  function fold(s) {
    return norm(s).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
  }

  function queryTokens(s) {
    return [...norm(s).matchAll(tokenRe)].map(m => m[0]);
  }

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(s)) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function bucket(term) {
    return (fnv1a(term) % 64).toString(16).padStart(2, '0');
  }

  async function json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
    return r.json();
  }

  async function loadShard(term) {
    const b = bucket(term);
    if (!shardCache.has(b)) shardCache.set(b, json(`${DATA}postings/${b}.json`));
    return shardCache.get(b);
  }

  function decodePosting(term, row) {
    const doc = row[0], packed = row[1];
    const hits = [];
    let t = 0, c = 0;
    for (let i = 0; i < packed.length; i += 2) {
      t += packed[i]; c += packed[i + 1];
      hits.push({ doc, token: t, char: c, term });
    }
    return hits;
  }

  async function postingsForTerms(terms) {
    const out = new Map();
    await Promise.all(terms.map(async term => {
      const shard = await loadShard(term);
      for (const row of (shard[term] || [])) {
        const arr = out.get(row[0]) || [];
        arr.push(...decodePosting(term, row));
        out.set(row[0], arr);
      }
    }));
    for (const arr of out.values()) arr.sort((a, b) => a.token - b.token || a.char - b.char);
    return out;
  }

  async function ensureLexicon() {
    if (!lexicon) lexicon = await json(`${DATA}lexicon.json`);
    return lexicon;
  }

  async function candidatesExact(term, loose) {
    term = norm(term);
    if (!loose) return [term];
    await ensureLexicon();
    if (!foldMap) {
      foldMap = new Map();
      for (const [t] of lexicon) {
        const f = fold(t);
        if (!foldMap.has(f)) foldMap.set(f, []);
        foldMap.get(f).push(t);
      }
    }
    return foldMap.get(fold(term)) || [term];
  }

  function docAllowed(docId) {
    const d = manifest.documents[docId];
    const selected = els.textFilter.value === '' ? null : Number(els.textFilter.value);
    if (selected !== null && selected !== docId) return false;
    if (els.centuryFilter.value) {
      const c = +els.centuryFilter.value;
      if (!d.year_min || d.year_min < c || d.year_min >= c + 100) return false;
    }
    const p = norm(els.provenanceFilter.value.trim());
    if (p && !norm(d.provenance).includes(p)) return false;
    return true;
  }

  function applyDocFilters(hits) {
    return hits.filter(h => docAllowed(h.doc));
  }

  async function exactSearch(q) {
    const rawParts = q.trim().split(/\s+/).filter(Boolean);
    const negative = rawParts.filter(x => x.startsWith('-') && x.length > 1).map(x => x.slice(1));
    const positive = rawParts.filter(x => !x.startsWith('-'));
    const posTokens = positive.flatMap(queryTokens);
    const negTokens = negative.flatMap(queryTokens);
    if (!posTokens.length) throw new Error('Enter at least one search word.');
    const loose = els.looseMatch.checked;
    const maps = [];
    for (const t of posTokens) maps.push(await postingsForTerms(await candidatesExact(t, loose)));
    let allowedDocs = new Set(maps[0].keys());
    for (const m of maps.slice(1)) allowedDocs = new Set([...allowedDocs].filter(d => m.has(d)));
    for (const t of negTokens) {
      const m = await postingsForTerms(await candidatesExact(t, loose));
      for (const d of m.keys()) allowedDocs.delete(d);
    }
    let hits = [];
    for (const d of allowedDocs) hits.push(...maps[0].get(d));
    return finalize(hits, posTokens.length, false);
  }

  async function phraseSearch(q) {
    const toks = queryTokens(q);
    if (!toks.length) throw new Error('Enter a phrase.');
    const loose = els.looseMatch.checked;
    const maps = [];
    for (const t of toks) maps.push(await postingsForTerms(await candidatesExact(t, loose)));
    let docs = new Set(maps[0].keys());
    for (const m of maps.slice(1)) docs = new Set([...docs].filter(d => m.has(d)));
    const hits = [];
    for (const d of docs) {
      const positionSets = maps.map(m => new Set(m.get(d).map(h => h.token)));
      for (const h of maps[0].get(d)) {
        let ok = true;
        for (let i = 1; i < positionSets.length; i++) if (!positionSets[i].has(h.token + i)) { ok = false; break; }
        if (ok) hits.push({ ...h, term: q.trim(), phraseLength: toks.length });
      }
    }
    return finalize(hits, toks.length, false);
  }

  function wildcardRegex(pattern) {
    const escaped = norm(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${escaped}$`, 'u');
  }

  async function vocabularyPatternSearch(q, kind) {
    await ensureLexicon();
    let re;
    if (kind === 'wildcard') re = wildcardRegex(q.trim());
    else {
      try { re = new RegExp(q.trim(), 'u'); } catch (e) { throw new Error(`Invalid regular expression: ${e.message}`); }
    }
    let terms = lexicon.filter(([t]) => re.test(t)).map(([t]) => t);
    const termTotal = terms.length;
    if (terms.length > MAX_TERMS) terms = terms.slice(0, MAX_TERMS);
    const map = await postingsForTerms(terms);
    let hits = [...map.values()].flat();
    return finalize(hits, termTotal, termTotal > MAX_TERMS, terms);
  }

  function morphologyPatterns(root) {
    root = norm(root);
    const forms = new Set([root, `ber${root}`, `be${root}`, `ter${root}`, `te${root}`, `di${root}`, `ke${root}`, `se${root}`, `per${root}`, `pe${root}`]);
    const first = root[0] || '';
    const rest = root.slice(1);
    if ('aiueoghq'.includes(first)) { forms.add(`meng${root}`); forms.add(`peng${root}`); }
    else if (first === 'k') { forms.add(`meng${rest}`); forms.add(`peng${rest}`); }
    else if (first === 'p') { forms.add(`mem${rest}`); forms.add(`pem${rest}`); }
    else if (first === 't') { forms.add(`men${rest}`); forms.add(`pen${rest}`); }
    else if (first === 's') { forms.add(`meny${rest}`); forms.add(`peny${rest}`); }
    else if ('bvf'.includes(first)) { forms.add(`mem${root}`); forms.add(`pem${root}`); }
    else if ('cdjz'.includes(first)) { forms.add(`men${root}`); forms.add(`pen${root}`); }
    else if (root.length <= 3) { forms.add(`menge${root}`); forms.add(`penge${root}`); }
    else { forms.add(`me${root}`); forms.add(`pe${root}`); }
    const escaped = [...forms].map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^(?:${escaped.join('|')})(?:kan|i|an|nya|lah|kah|pun)?$`, 'u');
  }

  async function morphologySearch(q) {
    const toks = queryTokens(q);
    if (toks.length !== 1) throw new Error('Word family search expects one root form.');
    await ensureLexicon();
    const re = morphologyPatterns(toks[0]);
    let terms = lexicon.filter(([t]) => re.test(t)).map(([t]) => t);
    const totalTerms = terms.length;
    if (terms.length > MAX_TERMS) terms = terms.slice(0, MAX_TERMS);
    const map = await postingsForTerms(terms);
    return finalize([...map.values()].flat(), totalTerms, totalTerms > MAX_TERMS, terms);
  }

  function parseNear(q) {
    let m = q.match(/^\s*(.+?)\s+(?:NEAR\/(\d+)|~\s*(\d+))\s+(.+?)\s*$/i);
    if (!m) m = q.match(/^\s*(\S+)\s*~\s*(\d+)\s*(\S+)\s*$/);
    if (!m) throw new Error('Near syntax: word1 ~5 word2 or word1 NEAR/5 word2');
    if (m.length === 5) return [m[1], +(m[2] || m[3]), m[4]];
    return [m[1], +m[2], m[3]];
  }

  async function nearSearch(q) {
    const [left, distance, right] = parseNear(q);
    if (distance < 1 || distance > 100) throw new Error('Near distance must be between 1 and 100 words.');
    const loose = els.looseMatch.checked;
    const a = await postingsForTerms(await candidatesExact(queryTokens(left)[0] || left, loose));
    const b = await postingsForTerms(await candidatesExact(queryTokens(right)[0] || right, loose));
    const hits = [];
    for (const [doc, ah] of a) {
      if (!b.has(doc)) continue;
      const bp = b.get(doc).map(h => h.token);
      let j = 0;
      for (const h of ah) {
        while (j < bp.length && bp[j] < h.token - distance) j++;
        if (j < bp.length && Math.abs(bp[j] - h.token) <= distance) hits.push({ ...h, near: `${left} ~${distance} ${right}` });
      }
    }
    return finalize(hits, 2, false);
  }

  function finalize(hits, candidateCount = 1, termTruncated = false, terms = null) {
    hits = applyDocFilters(hits);
    const total = hits.length;
    const distribution = new Map();
    for (const h of hits) distribution.set(h.doc, (distribution.get(h.doc) || 0) + 1);
    hits.sort((a, b) => {
      const sort = els.sortFilter.value;
      if (sort === 'text') return manifest.documents[a.doc].title.localeCompare(manifest.documents[b.doc].title) || a.char - b.char;
      if (sort === 'date') return (manifest.documents[a.doc].year_min || 9999) - (manifest.documents[b.doc].year_min || 9999) || a.char - b.char;
      return a.doc - b.doc || a.char - b.char;
    });
    const truncated = total > MAX_RESULTS || termTruncated;
    if (hits.length > MAX_RESULTS) hits = hits.slice(0, MAX_RESULTS);
    return { hits, total, candidateCount, truncated, terms, distribution: [...distribution.entries()] };
  }

  async function runSearch(pushUrl = true, page = 1) {
    const q = els.query.value.trim();
    if (!q) return;
    const mode = els.modeSelect.value;
    els.searchStatus.textContent = 'Searching…';
    els.searchStatus.className = 'status-line';
    els.results.innerHTML = '';
    els.resultStats.innerHTML = '';
    els.pagination.innerHTML = '';
    els.distribution.innerHTML = '<p class="sidebar-empty">Searching…</p>';
    els.exportCsv.disabled = true;
    currentPage = Math.max(1, Number(page) || 1);
    try {
      const start = performance.now();
      if (mode === 'word') searchResult = await exactSearch(q);
      else if (mode === 'phrase') searchResult = await phraseSearch(q);
      else if (mode === 'wildcard' || mode === 'regex') searchResult = await vocabularyPatternSearch(q, mode);
      else if (mode === 'near') searchResult = await nearSearch(q);
      else searchResult = await morphologySearch(q);
      searchResult.query = q;
      searchResult.mode = mode;
      searchResult.elapsed = performance.now() - start;
      if (pushUrl) syncUrl(false);
      await renderResults();
    } catch (e) {
      els.resultHeading.textContent = 'Search error';
      els.searchStatus.textContent = e.message || String(e);
      els.searchStatus.className = 'status-line error';
      els.distribution.innerHTML = '<p class="sidebar-empty">No distribution available.</p>';
    }
  }

  async function loadDoc(id) {
    if (!docCache.has(id)) docCache.set(id, json(`${DATA}texts/${manifest.documents[id].file_id}.json`));
    return docCache.get(id);
  }

  function spanAt(text, char) {
    const m = text.slice(char).match(/^[\p{L}\p{M}\p{N}]+(?:[’'`´-][\p{L}\p{M}\p{N}]+)*/u);
    return m ? m[0].length : 1;
  }

  function cleanSnippet(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function kwic(body, hit) {
    let matchLength = spanAt(body, hit.char);
    if (hit.phraseLength && hit.phraseLength > 1) {
      const tail = body.slice(hit.char);
      let seen = 0;
      let end = matchLength;
      for (const m of tail.matchAll(tokenRe)) {
        if (m.index !== 0 && seen === 0) break;
        seen++;
        end = m.index + m[0].length;
        if (seen >= hit.phraseLength) break;
      }
      if (seen >= hit.phraseLength) matchLength = end;
    }

    const matchEnd = hit.char + matchLength;
    const radius = 155;
    let leftStart = Math.max(0, hit.char - radius);
    let rightEnd = Math.min(body.length, matchEnd + radius);
    const leftClipped = leftStart > 0;
    const rightClipped = rightEnd < body.length;

    if (leftClipped) {
      while (leftStart < hit.char && !/\s/u.test(body[leftStart])) leftStart++;
      while (leftStart < hit.char && /\s/u.test(body[leftStart])) leftStart++;
    }
    if (rightClipped) {
      while (rightEnd > matchEnd && !/\s/u.test(body[rightEnd - 1])) rightEnd--;
      while (rightEnd > matchEnd && /\s/u.test(body[rightEnd - 1])) rightEnd--;
    }

    return {
      left: cleanSnippet(body.slice(leftStart, hit.char)),
      word: body.slice(hit.char, matchEnd),
      right: cleanSnippet(body.slice(matchEnd, rightEnd)),
      leftClipped,
      rightClipped
    };
  }

  async function renderResults() {
    const { hits, total, elapsed, candidateCount, truncated, mode, distribution } = searchResult;
    const pages = Math.max(1, Math.ceil(hits.length / pageSize));
    currentPage = Math.min(Math.max(1, currentPage), pages);
    const pageHits = hits.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const docs = new Set(hits.map(h => h.doc)).size;
    const modeLabel = els.modeSelect.options[els.modeSelect.selectedIndex]?.textContent || mode;

    els.resultHeading.textContent = total ? `Results for “${searchResult.query}”` : `No results for “${searchResult.query}”`;
    els.searchStatus.className = 'status-line';
    els.searchStatus.textContent = total
      ? `${total.toLocaleString()} occurrence${total === 1 ? '' : 's'} in ${docs.toLocaleString()} text${docs === 1 ? '' : 's'} · ${modeLabel.toLowerCase()} · ${elapsed.toFixed(0)} ms${truncated ? ' · display capped' : ''}`
      : 'No occurrences found with the current filters.';
    els.resultStats.innerHTML = '';
    if (['wildcard','regex','morph'].includes(mode)) addStat(`${candidateCount.toLocaleString()} matching form${candidateCount === 1 ? '' : 's'}`);
    if (truncated) addStat('Large result set capped for browser performance');
    renderDistribution(distribution || []);
    els.exportCsv.disabled = !hits.length;

    if (!total) {
      els.results.innerHTML = '<div class="empty-state">No matches. Try another spelling, search mode, or filter.</div>';
      els.pagination.innerHTML = '';
      return;
    }

    const needed = [...new Set(pageHits.map(h => h.doc))];
    await Promise.all(needed.map(loadDoc));
    els.results.innerHTML = '';

    const groups = [];
    const groupMap = new Map();
    for (const hit of pageHits) {
      let group = groupMap.get(hit.doc);
      if (!group) {
        group = { doc: hit.doc, hits: [] };
        groupMap.set(hit.doc, group);
        groups.push(group);
      }
      group.hits.push(hit);
    }

    let pageOrdinal = (currentPage - 1) * pageSize;
    for (const group of groups) {
      const d = manifest.documents[group.doc];
      const body = (await loadDoc(group.doc)).body;
      const section = document.createElement('section');
      section.className = 'result-group';
      const metaParts = [d.code, d.dates, d.provenance].filter(Boolean);
      section.innerHTML = `
        <header class="result-group-head">
          <div class="source-identity">
            <h3 class="source-title">${escapeHtml(d.title)}</h3>
            <p class="result-meta">${metaParts.map((x,i)=>i===0?`<span class="result-code">${escapeHtml(x)}</span>`:`<span>${escapeHtml(x)}</span>`).join('<span aria-hidden="true">·</span>')}</p>
          </div>
          <div class="source-actions">
            <button type="button" data-open-source>Open text</button>
            <button type="button" data-search-source>Search this text</button>
            <button type="button" data-meta>Metadata</button>
          </div>
        </header>
        <ol class="hit-list"></ol>`;
      section.querySelector('[data-open-source]').onclick = () => openReader(group.doc);
      section.querySelector('[data-search-source]').onclick = () => searchOnlyText(group.doc);
      section.querySelector('[data-meta]').onclick = () => openMetadata(group.doc);
      const list = section.querySelector('.hit-list');

      for (const hit of group.hits) {
        pageOrdinal++;
        const k = kwic(body, hit);
        const row = document.createElement('li');
        row.className = 'hit-row';
        row.innerHTML = `
          <span class="hit-number">${pageOrdinal}</span>
          <div class="context-line">${k.leftClipped ? '<span class="ellipsis">… </span>' : ''}${escapeHtml(k.left)}${k.left ? ' ' : ''}<mark>${escapeHtml(k.word)}</mark>${k.right ? ' ' : ''}${escapeHtml(k.right)}${k.rightClipped ? '<span class="ellipsis"> …</span>' : ''}</div>
          <button type="button" class="hit-open">Open in text</button>`;
        row.querySelector('.hit-open').onclick = () => openReader(hit.doc, hit.char);
        list.append(row);
      }
      els.results.append(section);
    }
    renderPagination(pages);
  }

  function addStat(text) {
    const s = document.createElement('span'); s.className = 'stat-pill'; s.textContent = text; els.resultStats.append(s);
  }

  function renderDistribution(rows) {
    els.distribution.innerHTML = '';
    const sorted = [...rows].sort((a, b) => b[1] - a[1] || manifest.documents[a[0]].title.localeCompare(manifest.documents[b[0]].title));
    if (!sorted.length) {
      els.distribution.innerHTML = '<p class="sidebar-empty">No matches.</p>';
      return;
    }
    for (const [docId, count] of sorted) {
      const d = manifest.documents[docId];
      const row = document.createElement('div');
      row.className = 'distribution-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${d.code} — ${d.title}`;
      button.title = 'Show matches from this text only';
      button.onclick = () => searchOnlyText(docId);
      const n = document.createElement('span');
      n.className = 'distribution-count';
      n.textContent = count.toLocaleString();
      row.append(button, n);
      els.distribution.append(row);
    }
  }

  function csvCell(value) {
    const s = String(value ?? '');
    return `"${s.replaceAll('"', '""')}"`;
  }

  async function exportResultsCsv() {
    if (!searchResult?.hits?.length) return;
    els.exportCsv.disabled = true;
    const original = els.exportCsv.textContent;
    els.exportCsv.textContent = 'Preparing…';
    try {
      const hits = searchResult.hits;
      await Promise.all([...new Set(hits.map(h => h.doc))].map(loadDoc));
      const rows = [['query','mode','mcp_code','title','dates','provenance','token_position','character_position','matched_form','context']];
      for (const hit of hits) {
        const d = manifest.documents[hit.doc];
        const body = (await loadDoc(hit.doc)).body;
        const k = kwic(body, hit);
        rows.push([searchResult.query, searchResult.mode, d.code, d.title, d.dates, d.provenance, hit.token, hit.char, k.word, `${k.left} ${k.word} ${k.right}`]);
      }
      const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mcp-${searchResult.mode}-${fold(searchResult.query).slice(0, 48) || 'search'}.csv`;
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } finally {
      els.exportCsv.textContent = original;
      els.exportCsv.disabled = false;
    }
  }

  function renderPagination(pages) {
    els.pagination.innerHTML = '';
    if (pages <= 1) return;

    const addButton = (label, page, options = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (options.current) {
        b.className = 'is-current';
        b.setAttribute('aria-current', 'page');
      }
      b.disabled = !!options.disabled;
      if (!b.disabled && !options.current) b.onclick = () => goToPage(page);
      els.pagination.append(b);
    };
    const addEllipsis = () => {
      const e = document.createElement('span');
      e.className = 'page-ellipsis';
      e.textContent = '…';
      els.pagination.append(e);
    };

    addButton('Previous', currentPage - 1, { disabled: currentPage === 1 });
    const windowStart = Math.max(2, currentPage - 2);
    const windowEnd = Math.min(pages - 1, currentPage + 2);
    addButton('1', 1, { current: currentPage === 1 });
    if (windowStart > 2) addEllipsis();
    for (let p = windowStart; p <= windowEnd; p++) addButton(String(p), p, { current: p === currentPage });
    if (windowEnd < pages - 1) addEllipsis();
    if (pages > 1) addButton(String(pages), pages, { current: currentPage === pages });
    addButton('Next', currentPage + 1, { disabled: currentPage === pages });

    const jump = document.createElement('form');
    jump.className = 'page-jump';
    jump.innerHTML = `<label>Page <input type="number" min="1" max="${pages}" value="${currentPage}" aria-label="Go to page"></label><button type="submit">Go</button>`;
    jump.onsubmit = e => {
      e.preventDefault();
      const p = Math.max(1, Math.min(pages, Number(jump.querySelector('input').value) || 1));
      goToPage(p);
    };
    els.pagination.append(jump);
  }

  async function goToPage(page) {
    currentPage = page;
    syncUrl(false);
    await renderResults();
    scrollResults();
  }

  async function searchOnlyText(docId) {
    els.textFilter.value = String(docId);
    filterCount();
    showView('search', false);
    await runSearch(true, 1);
  }

  function scrollResults() { els.searchStatus.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function showView(name, updateHistory = true) {
    const valid = new Set(['search','texts','help','about']);
    if (!valid.has(name)) name = 'search';
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === `${name}View`));
    document.querySelectorAll('[data-view-link]').forEach(a => a.classList.toggle('is-active', a.dataset.viewLink === name));
    if (name === 'texts') renderTextBrowser();
    if (updateHistory) {
      if (name === 'search' && searchResult && els.query.value.trim()) {
        syncUrl(false);
      } else {
        const p = new URLSearchParams();
        if (name !== 'search') p.set('view', name);
        const url = p.toString() ? `${location.pathname}?${p}` : location.pathname;
        history.pushState(null, '', url);
      }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function searchFromReader() {
    if (currentReader == null) return;
    els.textFilter.value = String(currentReader);
    filterCount();
    els.readerDialog.close();
    showView('search');
    els.query.focus();
  }

  function setReaderTab(name) {
    const map = { text: els.readerText, metadata: els.readerMeta, vocabulary: els.readerVocab };
    Object.entries(map).forEach(([key, button]) => button.classList.toggle('is-active', key === name));
  }

  async function openReader(id, char = null) {
    currentReader = id;
    currentReaderChar = char;
    setReaderTab('text');
    const d = manifest.documents[id], doc = await loadDoc(id);
    els.readerTitle.textContent = d.title;
    els.readerSubtitle.textContent = [d.code, d.dates, d.provenance].filter(Boolean).join(' · ');
    els.readerContent.className = 'reader-content';
    els.readerContent.innerHTML = '';
    if (char == null) els.readerContent.textContent = doc.body;
    else {
      const len = spanAt(doc.body, char);
      els.readerContent.append(document.createTextNode(doc.body.slice(0, char)));
      const mark = document.createElement('mark');
      mark.textContent = doc.body.slice(char, char + len);
      els.readerContent.append(mark);
      els.readerContent.append(document.createTextNode(doc.body.slice(char + len)));
      setTimeout(() => mark.scrollIntoView({ block: 'center' }), 60);
    }
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  async function openMetadata(id) {
    currentReader = id;
    setReaderTab('metadata');
    const d = manifest.documents[id];
    els.readerTitle.textContent = d.title;
    els.readerSubtitle.textContent = [d.code, d.dates, d.provenance].filter(Boolean).join(' · ');
    els.readerContent.className = 'reader-content metadata-view';
    const pairs = [['MCP code',d.code],['Title',d.title],['Edition',d.edition],['Manuscript',d.manuscript],['Dates',d.dates],['Provenance',d.provenance],['MCP word count',d.word_count_raw],['Reference scheme',d.reference_scheme],['Genre',d.genre],['Source file',d.source_file]];
    els.readerContent.innerHTML = `<dl>${pairs.filter(([,v])=>v).map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><div class="metadata-raw">${escapeHtml(d.metadata_raw)}</div>`;
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  async function openVocab(id) {
    currentReader = id;
    setReaderTab('vocabulary');
    const d = manifest.documents[id];
    if (!vocabCache.has(id)) vocabCache.set(id, json(`${DATA}vocab/${d.file_id}.json`));
    const vocab = await vocabCache.get(id);
    els.readerTitle.textContent = d.title;
    els.readerSubtitle.textContent = `${d.code} · ${vocab.length.toLocaleString()} indexed forms`;
    els.readerContent.className = 'reader-content';
    const table = document.createElement('table');
    table.className = 'vocab-table';
    const tbody = document.createElement('tbody');
    for (const [term,count] of vocab) {
      const tr=document.createElement('tr');
      const a=document.createElement('td');
      const b=document.createElement('td');
      a.textContent=term; b.textContent=count.toLocaleString();
      tr.append(a,b); tbody.append(tr);
    }
    table.append(tbody);
    els.readerContent.replaceChildren(table);
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  function renderTextBrowser() {
    const q = fold(els.textBrowserSearch.value);
    let docs = manifest.documents.filter(d => !q || fold([d.code,d.title,d.dates,d.provenance].join(' ')).includes(q));
    const sort = els.textBrowserSort.value;
    if (sort === 'title') docs = [...docs].sort((a,b) => a.title.localeCompare(b.title));
    else if (sort === 'date') docs = [...docs].sort((a,b) => (a.year_min || 9999) - (b.year_min || 9999) || a.title.localeCompare(b.title));
    else if (sort === 'words') docs = [...docs].sort((a,b) => b.indexed_tokens - a.indexed_tokens || a.title.localeCompare(b.title));

    els.textBrowser.innerHTML = '';
    els.textBrowserCount.textContent = `${docs.length.toLocaleString()} of ${manifest.documents.length.toLocaleString()} texts`;
    for (const d of docs) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><button class="text-title-button" type="button">${escapeHtml(d.title)}</button><br><span class="text-code-inline">${escapeHtml(d.code)}</span></td>
        <td>${escapeHtml(d.dates || '—')}</td>
        <td>${escapeHtml(d.provenance || '—')}</td>
        <td class="number-column">${(d.word_count || d.indexed_tokens).toLocaleString()}</td>
        <td class="action-column"><button class="table-open" type="button">Open</button></td>`;
      tr.querySelector('.text-title-button').onclick = () => openReader(d.id);
      tr.querySelector('.table-open').onclick = () => openReader(d.id);
      els.textBrowser.append(tr);
    }
  }

  function populateFilters() {
    els.textFilter.insertAdjacentHTML('beforeend', manifest.documents.map(d => `<option value="${d.id}">${escapeHtml(d.code)} — ${escapeHtml(d.title)}</option>`).join(''));
    els.corpusSummary.textContent = `${manifest.document_count.toLocaleString()} texts · ${manifest.indexed_tokens.toLocaleString()} indexed words`;
  }

  function updateModeHelp() {
    els.modeHelp.textContent = modeHelp[els.modeSelect.value];
  }

  function filterCount() {
    let n = 0;
    if (els.textFilter.value) n++;
    if (els.centuryFilter.value) n++;
    if (els.provenanceFilter.value.trim()) n++;
    if (els.sortFilter.value !== 'corpus') n++;
    if (els.looseMatch.checked) n++;
    els.filterCount.textContent = n ? `${n} filter${n === 1 ? '' : 's'} active` : '';
  }

  function syncUrl(replace = false) {
    const p = new URLSearchParams();
    const q = els.query.value.trim();
    if (q) p.set('q', q);
    if (els.modeSelect.value !== 'word') p.set('mode', els.modeSelect.value);
    if (els.textFilter.value) p.set('text', els.textFilter.value);
    if (els.centuryFilter.value) p.set('century', els.centuryFilter.value);
    if (els.provenanceFilter.value.trim()) p.set('prov', els.provenanceFilter.value.trim());
    if (els.sortFilter.value !== 'corpus') p.set('sort', els.sortFilter.value);
    if (els.looseMatch.checked) p.set('loose','1');
    if (currentPage > 1) p.set('page', String(currentPage));
    if (pageSize !== DEFAULT_PAGE_SIZE) p.set('per', String(pageSize));
    const url = `${location.pathname}${p.toString() ? `?${p}` : ''}`;
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }

  function restoreUrl() {
    const p = new URLSearchParams(location.search);
    const view = p.get('view') || 'search';
    if (p.has('q')) els.query.value = p.get('q');
    const mode = p.get('mode');
    if (mode && [...els.modeSelect.options].some(o => o.value === mode)) els.modeSelect.value = mode;
    const textId = p.get('text') || (p.get('texts') || '').split(',')[0];
    if (textId && [...els.textFilter.options].some(o => o.value === textId)) els.textFilter.value = textId;
    if (p.has('century')) els.centuryFilter.value = p.get('century');
    if (p.has('prov')) els.provenanceFilter.value = p.get('prov');
    if (p.has('sort')) els.sortFilter.value = p.get('sort');
    els.looseMatch.checked = p.get('loose') === '1';
    const per = Number(p.get('per'));
    pageSize = [25,50,100].includes(per) ? per : DEFAULT_PAGE_SIZE;
    els.pageSizeSelect.value = String(pageSize);
    requestedPage = Math.max(1, Number(p.get('page')) || 1);
    updateModeHelp();
    filterCount();
    showView(view, false);
    return view === 'search' && !!els.query.value.trim();
  }

  async function init() {
    try {
      manifest = await json(`${DATA}manifest.json`);
      populateFilters();
      renderTextBrowser();
      const hasQuery = restoreUrl();
      if (hasQuery) await runSearch(false, requestedPage);
      else {
        els.resultHeading.textContent = 'Ready to search';
        els.searchStatus.textContent = '';
        els.results.innerHTML = '<div class="empty-state">Enter a word, phrase, or pattern above.</div>';
      }
    } catch (e) {
      els.corpusSummary.textContent = 'Corpus index unavailable.';
      els.resultHeading.textContent = 'Unable to load corpus';
      els.searchStatus.textContent = e.message || String(e);
      els.searchStatus.className = 'status-line error';
    }
  }

  els.searchForm.addEventListener('submit', e => { e.preventDefault(); runSearch(true, 1); });
  document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', async () => {
    els.modeSelect.value = button.dataset.exampleMode;
    els.query.value = button.dataset.example;
    updateModeHelp();
    showView('search', false);
    await runSearch(true, 1);
  }));

  els.modeSelect.addEventListener('change', updateModeHelp);
  document.querySelectorAll('[data-view-link]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    showView(a.dataset.viewLink);
  }));
  els.textBrowserSearch.addEventListener('input', renderTextBrowser);
  els.textBrowserSort.addEventListener('change', renderTextBrowser);
  [els.textFilter,els.centuryFilter,els.provenanceFilter,els.sortFilter,els.looseMatch].forEach(x => x.addEventListener('change', filterCount));
  els.provenanceFilter.addEventListener('input', filterCount);
  els.clearFilters.addEventListener('click', async () => {
    els.textFilter.value = '';
    els.centuryFilter.value = '';
    els.provenanceFilter.value = '';
    els.sortFilter.value = 'corpus';
    els.looseMatch.checked = false;
    filterCount();
    if (searchResult) await runSearch(true, 1);
  });
  els.pageSizeSelect.addEventListener('change', async () => {
    pageSize = Number(els.pageSizeSelect.value) || DEFAULT_PAGE_SIZE;
    currentPage = 1;
    if (searchResult) {
      syncUrl(false);
      await renderResults();
      scrollResults();
    }
  });
  els.readerClose.addEventListener('click', () => els.readerDialog.close());
  els.readerText.addEventListener('click', () => currentReader != null && openReader(currentReader, currentReaderChar));
  els.readerMeta.addEventListener('click', () => currentReader != null && openMetadata(currentReader));
  els.readerVocab.addEventListener('click', () => currentReader != null && openVocab(currentReader));
  els.readerSearch.addEventListener('click', searchFromReader);
  els.readerDialog.addEventListener('click', e => { if (e.target === els.readerDialog) els.readerDialog.close(); });
  els.exportCsv.addEventListener('click', exportResultsCsv);
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      showView('search');
      els.query.focus();
    }
  });
  window.addEventListener('popstate', async () => {
    searchResult = null;
    els.query.value = '';
    els.modeSelect.value = 'word';
    els.textFilter.value = '';
    els.centuryFilter.value = '';
    els.provenanceFilter.value = '';
    els.sortFilter.value = 'corpus';
    els.looseMatch.checked = false;
    const hasQuery = restoreUrl();
    if (hasQuery) await runSearch(false, requestedPage);
  });

  init();
})();
