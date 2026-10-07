(() => {
  'use strict';

  const PAGE_SIZE = 40;
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

  const modeHelp = {
    word: 'Multiple words are treated as AND. Prefix a word with - to exclude texts containing it.',
    phrase: 'Find adjacent indexed word forms in exactly this order.',
    wildcard: 'Use * for any sequence and ? for one character. Example: meng*kan',
    regex: 'Regular expression matched against vocabulary forms. Example: ^ber.*an$',
    near: 'Use word1 ~5 word2 or word1 NEAR/5 word2.',
    morph: 'Heuristic Malay prefix/suffix expansion around a root. Useful for discovery rather than formal analysis.'
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
    const selected = [...els.textFilter.selectedOptions].map(o => +o.value);
    if (selected.length && !selected.includes(docId)) return false;
    if (els.genreFilter.value && d.genre !== els.genreFilter.value) return false;
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

  async function runSearch(pushUrl = true) {
    const q = els.query.value.trim();
    if (!q) return;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    els.searchStatus.textContent = 'Searching…';
    els.searchStatus.className = 'status-line loading';
    els.results.innerHTML = '';
    els.resultStats.innerHTML = '';
    els.pagination.innerHTML = '';
    els.distribution.innerHTML = '';
    els.exportCsv.disabled = true;
    currentPage = 1;
    try {
      const start = performance.now();
      if (mode === 'word') searchResult = await exactSearch(q);
      else if (mode === 'phrase') searchResult = await phraseSearch(q);
      else if (mode === 'wildcard' || mode === 'regex') searchResult = await vocabularyPatternSearch(q, mode);
      else if (mode === 'near') searchResult = await nearSearch(q);
      else searchResult = await morphologySearch(q);
      searchResult.query = q; searchResult.mode = mode;
      searchResult.elapsed = performance.now() - start;
      if (pushUrl) syncUrl();
      await renderResults();
    } catch (e) {
      els.searchStatus.textContent = e.message || String(e);
      els.searchStatus.className = 'status-line error';
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

  function cleanSnippet(s) { return s.replace(/\s+/g, ' ').trim(); }

  function kwic(body, hit) {
    const len = spanAt(body, hit.char);
    const left = cleanSnippet(body.slice(Math.max(0, hit.char - 105), hit.char));
    const word = body.slice(hit.char, hit.char + len);
    const right = cleanSnippet(body.slice(hit.char + len, hit.char + len + 105));
    return { left, word, right };
  }

  async function renderResults() {
    const { hits, total, elapsed, candidateCount, truncated, mode, distribution } = searchResult;
    const pages = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, pages);
    const pageHits = hits.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const docs = new Set(hits.map(h => h.doc)).size;
    els.searchStatus.className = 'status-line';
    els.searchStatus.textContent = total ? `${total.toLocaleString()} occurrence${total === 1 ? '' : 's'} in ${docs} text${docs === 1 ? '' : 's'} · ${elapsed.toFixed(0)} ms${truncated ? ' · display capped' : ''}` : 'No matches.';
    els.resultStats.innerHTML = '';
    if (['wildcard','regex','morph'].includes(mode)) addStat(`${candidateCount.toLocaleString()} matching form${candidateCount === 1 ? '' : 's'}`);
    addStat(`${manifest.document_count} texts indexed`);
    renderDistribution(distribution || []);
    els.exportCsv.disabled = !hits.length;
    if (!total) { els.results.innerHTML = '<div class="empty">Try a different spelling, search mode, or remove filters.</div>'; return; }

    const needed = [...new Set(pageHits.map(h => h.doc))];
    await Promise.all(needed.map(loadDoc));
    els.results.innerHTML = '';
    for (const hit of pageHits) {
      const d = manifest.documents[hit.doc];
      const body = (await loadDoc(hit.doc)).body;
      const k = kwic(body, hit);
      const card = document.createElement('article'); card.className = 'result-card';
      card.innerHTML = `<div class="result-head"><span class="result-code">${escapeHtml(d.code)}</span><span class="result-title">${escapeHtml(d.title)}</span><span class="result-meta">${escapeHtml(d.dates || d.provenance || '')}</span></div><div class="kwic"><span class="kwic-left">${escapeHtml(k.left)}</span><mark class="kwic-hit">${escapeHtml(k.word)}</mark><span class="kwic-right">${escapeHtml(k.right)}</span></div><div class="result-actions"><button data-open>Open text</button><button data-meta>Metadata</button></div>`;
      card.querySelector('[data-open]').onclick = () => openReader(hit.doc, hit.char);
      card.querySelector('[data-meta]').onclick = () => openMetadata(hit.doc);
      els.results.append(card);
    }
    renderPagination(pages);
  }

  function addStat(text) {
    const s = document.createElement('span'); s.className = 'stat-pill'; s.textContent = text; els.resultStats.append(s);
  }

  function renderDistribution(rows) {
    els.distribution.innerHTML = '';
    const sorted = [...rows].sort((a, b) => b[1] - a[1] || manifest.documents[a[0]].title.localeCompare(manifest.documents[b[0]].title));
    if (!sorted.length) { els.distribution.textContent = 'No matches.'; return; }
    for (const [docId, count] of sorted) {
      const d = manifest.documents[docId];
      const row = document.createElement('div'); row.className = 'distribution-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${d.code} — ${d.title}`;
      button.title = 'Filter search to this text';
      button.onclick = async () => {
        [...els.textFilter.options].forEach(o => { o.selected = +o.value === docId; });
        filterCount();
        await runSearch();
      };
      const n = document.createElement('span'); n.className = 'distribution-count'; n.textContent = count.toLocaleString();
      row.append(button, n); els.distribution.append(row);
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
    const prev = document.createElement('button'); prev.textContent = 'Previous'; prev.disabled = currentPage === 1; prev.onclick = async () => { currentPage--; await renderResults(); scrollResults(); };
    const label = document.createElement('button'); label.textContent = `${currentPage} / ${pages}`; label.disabled = true;
    const next = document.createElement('button'); next.textContent = 'Next'; next.disabled = currentPage === pages; next.onclick = async () => { currentPage++; await renderResults(); scrollResults(); };
    els.pagination.append(prev, label, next);
  }

  function scrollResults() { els.searchStatus.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === `${name}View`));
    document.querySelectorAll('.nav-button').forEach(b => b.classList.toggle('is-active', b.dataset.view === name));
    if (name === 'texts') renderTextBrowser();
  }

  async function openReader(id, char = null) {
    currentReader = id;
    const d = manifest.documents[id], doc = await loadDoc(id);
    els.readerTitle.textContent = d.title;
    els.readerSubtitle.textContent = [d.code, d.dates, d.provenance].filter(Boolean).join(' · ');
    els.readerContent.className = 'reader-content';
    els.readerContent.innerHTML = '';
    if (char == null) els.readerContent.textContent = doc.body;
    else {
      const len = spanAt(doc.body, char);
      els.readerContent.append(document.createTextNode(doc.body.slice(0, char)));
      const mark = document.createElement('mark'); mark.textContent = doc.body.slice(char, char + len); els.readerContent.append(mark);
      els.readerContent.append(document.createTextNode(doc.body.slice(char + len)));
      setTimeout(() => mark.scrollIntoView({ block: 'center' }), 60);
    }
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  async function openMetadata(id) {
    currentReader = id;
    const d = manifest.documents[id];
    els.readerTitle.textContent = d.title;
    els.readerSubtitle.textContent = d.code;
    els.readerContent.className = 'reader-content metadata-view';
    const pairs = [['MCP code',d.code],['Title',d.title],['Edition',d.edition],['Manuscript',d.manuscript],['Dates',d.dates],['Provenance',d.provenance],['MCP word count',d.word_count_raw],['Reference scheme',d.reference_scheme],['Genre',d.genre],['Source file',d.source_file]];
    els.readerContent.innerHTML = `<dl>${pairs.filter(([,v])=>v).map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><div class="metadata-raw">${escapeHtml(d.metadata_raw)}</div>`;
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  async function openVocab(id) {
    currentReader = id;
    const d = manifest.documents[id];
    if (!vocabCache.has(id)) vocabCache.set(id, json(`${DATA}vocab/${d.file_id}.json`));
    const vocab = await vocabCache.get(id);
    els.readerTitle.textContent = `${d.title} — vocabulary`;
    els.readerSubtitle.textContent = `${vocab.length.toLocaleString()} indexed forms`;
    els.readerContent.className = 'reader-content';
    const table = document.createElement('table'); table.className = 'vocab-table';
    const tbody = document.createElement('tbody');
    for (const [term,count] of vocab) { const tr=document.createElement('tr'); const a=document.createElement('td'); const b=document.createElement('td'); a.textContent=term;b.textContent=count.toLocaleString();tr.append(a,b);tbody.append(tr); }
    table.append(tbody); els.readerContent.replaceChildren(table);
    if (!els.readerDialog.open) els.readerDialog.showModal();
  }

  function renderTextBrowser() {
    const q = fold(els.textBrowserSearch.value);
    const docs = manifest.documents.filter(d => !q || fold([d.code,d.title,d.dates,d.provenance,d.genre].join(' ')).includes(q));
    els.textBrowser.innerHTML = '';
    for (const d of docs) {
      const card = document.createElement('article'); card.className = 'text-card';
      card.innerHTML = `<div class="text-card-top"><span class="result-code">${escapeHtml(d.code)}</span><span class="result-meta">${d.indexed_tokens.toLocaleString()} tokens</span></div><h2>${escapeHtml(d.title)}</h2><p>${escapeHtml(d.dates || 'Date not specified')}</p><p>${escapeHtml(d.provenance || 'Provenance not specified')}</p><button>Open text →</button>`;
      card.querySelector('button').onclick = () => openReader(d.id);
      els.textBrowser.append(card);
    }
  }

  function populateFilters() {
    els.textFilter.innerHTML = manifest.documents.map(d => `<option value="${d.id}">${escapeHtml(d.code)} — ${escapeHtml(d.title)}</option>`).join('');
    const genres = [...new Set(manifest.documents.map(d => d.genre))].sort();
    els.genreFilter.insertAdjacentHTML('beforeend', genres.map(g => `<option>${escapeHtml(g)}</option>`).join(''));
    els.corpusSummary.textContent = `${manifest.document_count} archived texts · ${manifest.indexed_tokens.toLocaleString()} indexed tokens · ${manifest.declared_words.toLocaleString()} words reported by MCP metadata.`;
  }

  function updateModeHelp() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    els.modeHelp.textContent = modeHelp[mode];
  }

  function filterCount() {
    let n = [...els.textFilter.selectedOptions].length;
    if (els.genreFilter.value) n++; if (els.centuryFilter.value) n++; if (els.provenanceFilter.value.trim()) n++; if (els.sortFilter.value !== 'corpus') n++; if (els.looseMatch.checked) n++;
    els.filterCount.textContent = n ? `(${n} active)` : '';
  }

  function syncUrl() {
    const p = new URLSearchParams();
    p.set('q', els.query.value.trim()); p.set('mode', document.querySelector('input[name="mode"]:checked').value);
    const t = [...els.textFilter.selectedOptions].map(o => o.value); if (t.length) p.set('texts', t.join(','));
    if (els.genreFilter.value) p.set('genre', els.genreFilter.value); if (els.centuryFilter.value) p.set('century', els.centuryFilter.value); if (els.provenanceFilter.value.trim()) p.set('prov', els.provenanceFilter.value.trim()); if (els.sortFilter.value !== 'corpus') p.set('sort', els.sortFilter.value); if (els.looseMatch.checked) p.set('loose','1');
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
  }

  function restoreUrl() {
    const p = new URLSearchParams(location.search);
    if (p.has('q')) els.query.value = p.get('q');
    const mode = p.get('mode'); if (mode && document.querySelector(`input[name="mode"][value="${CSS.escape(mode)}"]`)) document.querySelector(`input[name="mode"][value="${CSS.escape(mode)}"]`).checked = true;
    if (p.has('texts')) { const ids = new Set(p.get('texts').split(',')); [...els.textFilter.options].forEach(o => o.selected = ids.has(o.value)); }
    if (p.has('genre')) els.genreFilter.value = p.get('genre'); if (p.has('century')) els.centuryFilter.value = p.get('century'); if (p.has('prov')) els.provenanceFilter.value = p.get('prov'); if (p.has('sort')) els.sortFilter.value = p.get('sort'); els.looseMatch.checked = p.get('loose') === '1';
    updateModeHelp(); filterCount();
    return !!els.query.value.trim();
  }

  async function init() {
    try {
      manifest = await json(`${DATA}manifest.json`);
      populateFilters();
      const hasQuery = restoreUrl();
      renderTextBrowser();
      if (hasQuery) await runSearch(false);
      else els.searchStatus.textContent = 'Ready. Search the full corpus or choose filters above.';
    } catch (e) {
      els.corpusSummary.textContent = 'The generated corpus index could not be loaded.';
      els.searchStatus.textContent = e.message || String(e); els.searchStatus.className = 'status-line error';
    }
  }

  els.searchForm.addEventListener('submit', e => { e.preventDefault(); runSearch(); });
  document.querySelectorAll('input[name="mode"]').forEach(x => x.addEventListener('change', updateModeHelp));
  document.querySelectorAll('.nav-button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  els.textBrowserSearch.addEventListener('input', renderTextBrowser);
  [els.textFilter,els.genreFilter,els.centuryFilter,els.provenanceFilter,els.sortFilter,els.looseMatch].forEach(x => x.addEventListener('change', filterCount));
  els.provenanceFilter.addEventListener('input', filterCount);
  els.clearFilters.addEventListener('click', () => { [...els.textFilter.options].forEach(o=>o.selected=false); els.genreFilter.value='';els.centuryFilter.value='';els.provenanceFilter.value='';els.sortFilter.value='corpus';els.looseMatch.checked=false;filterCount(); });
  els.readerClose.addEventListener('click', () => els.readerDialog.close());
  els.readerMeta.addEventListener('click', () => currentReader != null && openMetadata(currentReader));
  els.readerVocab.addEventListener('click', () => currentReader != null && openVocab(currentReader));
  els.readerDialog.addEventListener('click', e => { if (e.target === els.readerDialog) els.readerDialog.close(); });
  els.exportCsv.addEventListener('click', exportResultsCsv);
  document.addEventListener('keydown', e => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); showView('search'); els.query.focus(); } });

  init();
})();
