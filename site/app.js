(() => {
  'use strict';
  const DATA = 'data/';
  const PAGE_DEFAULT = 50;
  const MAX_EXPANSION = 1500;
  const MAX_RESULTS = 120000;
  const TOKEN_RE = /[\p{L}\p{M}\p{N}]+(?:[’'`´-][\p{L}\p{M}\p{N}]+)*/gu;
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(e => [e.id, e]));
  const postingCache = new Map(), textCache = new Map(), vocabCache = new Map(), tokenCache = new Map();
  let manifest = null, lexicon = null, foldMap = null;
  let searchResult = null, lastSearchUrl = location.pathname, activeSearch = 0;
  let currentPage = 1, currentView = 'search';
  let currentReader = null, readerDoc = null, readerPosition = null, readerTab = 'text';
  let readerFindMatches = [], readerFindIndex = 0, vocabPage = 1;
  let allDistribution = false;
  let timelineMode = 'rate';
  const COLLOCATION_SAMPLE = 4000;

  const modeHints = {
    word: 'Match a word form. Multiple words must appear in the same text.',
    phrase: 'Match adjacent words in the specified order.',
    wildcard: 'Use * for any number of characters and ? for one.',
    regex: 'Match a JavaScript regular expression against word forms.',
    near: 'Enter two words, such as anak ~5 raja.',
    morph: 'Find likely affixed forms of a Malay root.'
  };
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’´]/g, "'");
  const fold = s => norm(s).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
  const tokensOf = s => [...norm(s).matchAll(TOKEN_RE)].map(m => m[0]);
  const nice = n => Number(n || 0).toLocaleString('en-US');
  const numeric = (n, otherwise = 1) => Number.isFinite(+n) ? +n : otherwise;
  const setStatus = (message, error=false) => { els.searchStatus.textContent = message; els.searchStatus.className = error ? 'status-line error' : 'status-line'; };
  const routeParams = () => new URLSearchParams(location.search);

  async function json(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Cannot load corpus data (${response.status}).`);
    return response.json();
  }
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(s)) h = Math.imul((h ^ byte), 0x01000193) >>> 0;
    return h >>> 0;
  }
  function postingBucket(term) { return (fnv1a(term) % 64).toString(16).padStart(2, '0'); }
  function shardFor(term) {
    const key = postingBucket(term);
    if (!postingCache.has(key)) postingCache.set(key, json(`${DATA}postings/${key}.json`).catch(e => { postingCache.delete(key); throw e; }));
    return postingCache.get(key);
  }
  function loadText(id) {
    const d = manifest.documents[id];
    if (!d) return Promise.reject(new Error('Text not found.'));
    if (!textCache.has(id)) textCache.set(id, json(`${DATA}texts/${d.file_id}.json`).catch(e => { textCache.delete(id); throw e; }));
    return textCache.get(id);
  }
  function loadVocabulary(id) {
    const d = manifest.documents[id];
    if (!vocabCache.has(id)) vocabCache.set(id, json(`${DATA}vocab/${d.file_id}.json`).catch(e => { vocabCache.delete(id); throw e; }));
    return vocabCache.get(id);
  }
  async function getLexicon() {
    if (!lexicon) lexicon = await json(`${DATA}lexicon.json`);
    return lexicon;
  }
  async function candidatesExact(term, loose) {
    term = norm(term);
    if (!loose) return [term];
    const list = await getLexicon();
    if (!foldMap) {
      foldMap = new Map();
      for (const [form] of list) {
        const key = fold(form);
        if (!foldMap.has(key)) foldMap.set(key, []);
        foldMap.get(key).push(form);
      }
    }
    return foldMap.get(fold(term)) || [term];
  }
  function decode(row, term) {
    const [doc, pairs] = row;
    const result = [];
    let token = 0, char = 0;
    for (let i=0; i<pairs.length; i+=2) {
      token += pairs[i]; char += pairs[i+1];
      result.push({doc, token, char, term});
    }
    return result;
  }
  async function postingsFor(terms) {
    const map = new Map();
    await Promise.all([...new Set(terms)].map(async term => {
      const shard = await shardFor(term);
      for (const row of shard[term] || []) {
        if (!map.has(row[0])) map.set(row[0], []);
        map.get(row[0]).push(...decode(row, term));
      }
    }));
    for (const hits of map.values()) hits.sort((a,b) => a.token-b.token || a.char-b.char);
    return map;
  }
  function permittedDoc(id) {
    const d = manifest.documents[id];
    const selected = els.textFilter.value;
    if (selected !== '' && Number(selected) !== id) return false;
    if (els.centuryFilter.value) {
      const start = +els.centuryFilter.value;
      if (!d.year_min || d.year_min < start || d.year_min >= start+100) return false;
    }
    const origin = norm(els.provenanceFilter.value.trim());
    if (origin && !norm(d.provenance).includes(origin)) return false;
    return true;
  }
  function finalise(rawHits, expanded=1, truncatedTerms=false) {
    const filtered = rawHits.filter(h => permittedDoc(h.doc));
    const perDoc = new Map();
    for (const h of filtered) perDoc.set(h.doc, (perDoc.get(h.doc)||0)+1);
    const sort = els.sortFilter.value;
    filtered.sort((a,b) => {
      if (sort === 'text') return manifest.documents[a.doc].title.localeCompare(manifest.documents[b.doc].title) || a.token-b.token;
      if (sort === 'date') return (manifest.documents[a.doc].year_min||9999)-(manifest.documents[b.doc].year_min||9999) || a.doc-b.doc || a.token-b.token;
      if (sort === 'count') return (perDoc.get(b.doc)||0)-(perDoc.get(a.doc)||0) || a.doc-b.doc || a.token-b.token;
      return a.doc-b.doc || a.token-b.token;
    });
    const capped = filtered.length > MAX_RESULTS;
    return { hits: capped ? filtered.slice(0, MAX_RESULTS) : filtered,
      total: filtered.length, expanded, truncated: truncatedTerms || capped,
      capped, truncatedTerms, distribution:[...perDoc.entries()] };
  }
  async function wordSearch(query) {
    const parts = query.trim().split(/\s+/).filter(Boolean);
    const include = parts.filter(p => !p.startsWith('-')).flatMap(tokensOf);
    const exclude = parts.filter(p => p.startsWith('-') && p.length>1).flatMap(p=>tokensOf(p.slice(1)));
    if (!include.length) throw new Error('Enter at least one word.');
    const maps = await Promise.all(include.map(async t => postingsFor(await candidatesExact(t, els.looseMatch.checked))));
    const docs = new Set(maps[0].keys());
    for (const map of maps.slice(1)) for (const id of [...docs]) if (!map.has(id)) docs.delete(id);
    for (const term of exclude) {
      const map = await postingsFor(await candidatesExact(term, els.looseMatch.checked));
      for (const id of map.keys()) docs.delete(id);
    }
    const hits = [...docs].flatMap(d => maps[0].get(d) || []);
    return finalise(hits, include.length);
  }
  async function phraseSearch(query) {
    const terms = tokensOf(query);
    if (!terms.length) throw new Error('Enter a phrase.');
    const maps = await Promise.all(terms.map(async t => postingsFor(await candidatesExact(t, els.looseMatch.checked))));
    const docs = new Set(maps[0].keys());
    for (const map of maps.slice(1)) for (const d of [...docs]) if (!map.has(d)) docs.delete(d);
    const hits = [];
    for (const d of docs) {
      const sets = maps.slice(1).map(m => new Set((m.get(d)||[]).map(h=>h.token)));
      for (const hit of maps[0].get(d)) {
        if (sets.every((set,i)=>set.has(hit.token+i+1))) hits.push({...hit, phraseLength:terms.length});
      }
    }
    return finalise(hits, terms.length);
  }
  function wildcardRegex(query) {
    const s = norm(query).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${s}$`, 'u');
  }
  async function patternSearch(query, mode) {
    if (query.length > 160) throw new Error('Search pattern is too long (maximum 160 characters).');
    let re;
    try { re = mode==='wildcard' ? wildcardRegex(query.trim()) : new RegExp(query.trim(), 'u'); }
    catch(e) { throw new Error(`Invalid pattern: ${e.message}`); }
    const dictionary = await getLexicon();
    const matches = [];
    for (const [term] of dictionary) if (re.test(term)) {
      matches.push(term);
      if (matches.length > MAX_EXPANSION) break;
    }
    const truncated = matches.length>MAX_EXPANSION;
    const terms = truncated ? matches.slice(0,MAX_EXPANSION) : matches;
    const map = await postingsFor(terms);
    return finalise([...map.values()].flat(), matches.length, truncated);
  }
  function morphologyRegex(root) {
    root = norm(root);
    const base = new Set([root]);
    for (const p of ['ber','be','ter','te','di','ke','se','per','pe','memper','diper','keter','keber']) base.add(p+root);
    const initial = root[0] || '', rest = root.slice(1);
    if ('aiueoghq'.includes(initial)) for (const p of ['meng','peng']) base.add(p+root);
    else if (initial === 'k') for (const p of ['meng','peng']) base.add(p+rest);
    else if (initial === 'p') for (const p of ['mem','pem']) base.add(p+rest);
    else if (initial === 't') for (const p of ['men','pen']) base.add(p+rest);
    else if (initial === 's') for (const p of ['meny','peny']) base.add(p+rest);
    else if ('bvf'.includes(initial)) for (const p of ['mem','pem']) base.add(p+root);
    else if ('cdjz'.includes(initial)) for (const p of ['men','pen']) base.add(p+root);
    else if (root.length<=3) for (const p of ['menge','penge']) base.add(p+root);
    else for (const p of ['me','pe']) base.add(p+root);
    const escaped = [...base].map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    return new RegExp(`^(?:${escaped.join('|')})(?:kan|i|an|nya|lah|kah|pun)?$`, 'u');
  }
  async function morphSearch(query) {
    const toks = tokensOf(query);
    if (toks.length!==1) throw new Error('Word family search requires one root.');
    const pattern = morphologyRegex(toks[0]);
    const dictionary = await getLexicon();
    const terms = [];
    for (const [word] of dictionary) if (pattern.test(word)) terms.push(word);
    const truncated = terms.length>MAX_EXPANSION;
    const map = await postingsFor(terms.slice(0,MAX_EXPANSION));
    return finalise([...map.values()].flat(),terms.length,truncated);
  }
  async function nearSearch(query) {
    const m = query.match(/^\s*(\S+)\s*(?:~\s*(\d+)|NEAR\/(\d+))\s*(\S+)\s*$/i);
    if (!m) throw new Error('Enter proximity as word1 ~5 word2.');
    const wordsA = tokensOf(m[1]), wordsB = tokensOf(m[4]);
    const n = Number(m[2]||m[3]);
    if (wordsA.length!==1 || wordsB.length!==1 || n<1 || n>100) throw new Error('Proximity must contain two words and a distance from 1 to 100.');
    const [left,right] = await Promise.all([
      postingsFor(await candidatesExact(wordsA[0],els.looseMatch.checked)),
      postingsFor(await candidatesExact(wordsB[0],els.looseMatch.checked))
    ]);
    const hits = [];
    for (const [id, first] of left) {
      const second = right.get(id); if (!second) continue;
      let j = 0;
      for (const h of first) {
        while (j<second.length && second[j].token<h.token-n) j++;
        let picked = null;
        for (let k=j; k<second.length && second[k].token<=h.token+n; k++) {
          if (second[k].token===h.token) continue;
          if (!picked || Math.abs(second[k].token-h.token)<Math.abs(picked.token-h.token)) picked=second[k];
        }
        if (picked) hits.push({...h, nearChar:picked.char, nearTerm:picked.term});
      }
    }
    return finalise(hits,2);
  }
  async function runSearch(updateUrl=true) {
    const q = els.query.value.trim();
    if (!q) { els.query.focus(); return; }
    const mode = els.modeSelect.value;
    const ticket=++activeSearch;
    setStatus('Searching…');
    els.resultHeading.textContent='Search results';
    els.results.innerHTML='';els.pagination.innerHTML='';els.resultStats.textContent='';
    els.analysisPanel.hidden=true;
    els.exportCsv.disabled=true;els.copySearchLink.disabled=true;
    if (updateUrl) {
      currentPage=1;els.formFilter.value='';
      syncSearchUrl(true);
    }
    try {
      const start = performance.now();
      const work = mode==='word' ? wordSearch(q) : mode==='phrase' ? phraseSearch(q) : mode==='near' ? nearSearch(q) : mode==='morph' ? morphSearch(q) : patternSearch(q,mode);
      const result = await work;
      if (ticket!==activeSearch) return;
      searchResult={...result,query:q,mode,elapsed:performance.now()-start};
      setupFormFacet();
      await renderResults(ticket);
    } catch(e) {
      if (ticket!==activeSearch) return;
      searchResult=null;
      els.analysisPanel.hidden=true;
      els.resultHeading.textContent='Search could not be completed';
      setStatus(e.message || String(e),true);
      els.distribution.innerHTML='<p class="muted">No results.</p>';
      els.results.innerHTML='<div class="empty-state">Check the query or try a different search mode.</div>';
    }
  }
  function setupFormFacet() {
    const previouslySelected=els.formFilter.value || routeParams().get('form') || '';
    const counts=new Map();
    for (const h of searchResult.hits) counts.set(h.term,(counts.get(h.term)||0)+1);
    const options=[...counts].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    els.formFilter.replaceChildren(new Option('All forms',''));
    if (options.length>1) {
      for (const [term,count] of options.slice(0,400)) els.formFilter.add(new Option(`${term} (${nice(count)})`,term));
      els.formFilter.value=previouslySelected;
    }
    els.formFilter.closest('label').hidden=options.length<=1;
  }
  function displayedHits() {
    if (!searchResult) return [];
    const form=els.formFilter.value;
    return form ? searchResult.hits.filter(h=>h.term===form) : searchResult.hits;
  }
  function sourceCounts(hits) {
    const map = new Map();
    for (const h of hits) map.set(h.doc,(map.get(h.doc)||0)+1);
    return [...map].sort((a,b)=>b[1]-a[1] || manifest.documents[a[0]].title.localeCompare(manifest.documents[b[0]].title));
  }

  function eligibleDocuments(ignoreCentury=false) {
    return manifest.documents.filter((d,id) => {
      const selected=els.textFilter.value;
      if(selected!=='' && Number(selected)!==id) return false;
      if(!ignoreCentury && els.centuryFilter.value){
        const start=Number(els.centuryFilter.value);
        if(!d.year_min || d.year_min<start || d.year_min>=start+100) return false;
      }
      const origin=norm(els.provenanceFilter.value.trim());
      if(origin && !norm(d.provenance).includes(origin)) return false;
      return true;
    });
  }
  function per10k(count, words) { return words ? count / words * 10000 : 0; }
  function compactRate(value) { return value>=10 ? value.toFixed(1) : value>=1 ? value.toFixed(2) : value.toFixed(3); }
  function analysisMetrics(hits) {
    const scope=eligibleDocuments();
    const words=scope.reduce((n,d)=>n+(d.indexed_tokens||0),0);
    const matchingDocs=[...new Set(hits.map(h=>h.doc))];
    const dated=matchingDocs.map(id=>manifest.documents[id]).filter(d=>d.year_min);
    const counts=sourceCounts(hits);
    return {
      words,
      rate:per10k(hits.length,words),
      scopeDocs:scope.length,
      matchingDocs:matchingDocs.length,
      earliest:dated.length?Math.min(...dated.map(d=>d.year_min)):null,
      latest:dated.length?Math.max(...dated.map(d=>d.year_min)):null,
      topShare:hits.length&&counts.length?counts[0][1]/hits.length*100:0
    };
  }
  function renderProfile(hits) {
    const m=analysisMetrics(hits);
    const parts=[`${compactRate(m.rate)} per 10k indexed words`,`${nice(m.matchingDocs)} of ${nice(m.scopeDocs)} texts`];
    if(m.earliest!==null) parts.push(`dated sources ${m.earliest}\u2013${m.latest}`);
    if(hits.length>1) parts.push(`largest source ${m.topShare.toFixed(1)}% of matches`);
    els.profileLine.textContent=parts.join(' \u00b7 ');
  }
  function timelineBuckets(hits) {
    const hitCounts=new Map();
    for(const h of hits){
      const d=manifest.documents[h.doc];
      if(!d.year_min) continue;
      const century=Math.floor(d.year_min/100)*100;
      hitCounts.set(century,(hitCounts.get(century)||0)+1);
    }
    const wordCounts=new Map();
    for(const d of eligibleDocuments()){
      if(!d.year_min) continue;
      const century=Math.floor(d.year_min/100)*100;
      wordCounts.set(century,(wordCounts.get(century)||0)+(d.indexed_tokens||0));
    }
    const years=[...new Set([...hitCounts.keys(),...wordCounts.keys()])].sort((a,b)=>a-b);
    return years.map(year=>({year,hits:hitCounts.get(year)||0,words:wordCounts.get(year)||0,rate:per10k(hitCounts.get(year)||0,wordCounts.get(year)||0)}));
  }
  function centuryLabel(year){
    const n=Math.floor(year/100)+1;
    const suffix=n%10===1&&n%100!==11?'st':n%10===2&&n%100!==12?'nd':n%10===3&&n%100!==13?'rd':'th';
    return `${n}${suffix}`;
  }
  function renderTimeline(hits) {
    const rows=timelineBuckets(hits);
    els.timelineChart.replaceChildren();
    if(!rows.length){els.timelineChart.innerHTML='<span class="muted">No dated results in the current scope.</span>';return;}
    const values=rows.map(r=>timelineMode==='raw'?r.hits:r.rate);
    const max=Math.max(...values,0);
    for(const row of rows){
      const value=timelineMode==='raw'?row.hits:row.rate;
      const button=document.createElement('button');button.type='button';button.className='timeline-item';
      if(String(row.year)===els.centuryFilter.value) button.classList.add('is-selected');
      const amount=timelineMode==='raw'?`${nice(row.hits)} matches`:`${compactRate(row.rate)} / 10k`;
      button.title=`${centuryLabel(row.year)} century: ${amount}`;
      button.setAttribute('aria-label',button.title);
      const valueLabel=document.createElement('span');valueLabel.className='timeline-value';valueLabel.textContent=timelineMode==='raw'?nice(row.hits):compactRate(row.rate);
      const track=document.createElement('span');track.className='timeline-track';
      const fill=document.createElement('span');fill.className='timeline-fill';fill.style.height=`${max?Math.max(3,value/max*100):0}%`;track.append(fill);
      const label=document.createElement('span');label.className='timeline-label';label.textContent=centuryLabel(row.year);
      button.append(valueLabel,track,label);
      button.onclick=()=>{els.centuryFilter.value=String(row.year);updateFilterCount();runSearch(true);};
      els.timelineChart.append(button);
    }
  }
  async function tokenTermsForDoc(id) {
    if(tokenCache.has(id)) return tokenCache.get(id);
    const body=(await loadText(id)).body;
    const terms=[...body.matchAll(TOKEN_RE)].map(m=>norm(m[0]));
    tokenCache.set(id,terms);
    return terms;
  }
  function sampleHits(hits,max=COLLOCATION_SAMPLE) {
    if(hits.length<=max) return hits;
    const out=[];
    for(let i=0;i<max;i++) out.push(hits[Math.floor(i*hits.length/max)]);
    return out;
  }
  async function renderCollocations(hits,ticket=activeSearch) {
    els.collocationList.innerHTML='<span class="muted">Analysing nearby words\u2026</span>';
    els.collocationNote.textContent='';
    if(!hits.length) return;
    const sample=sampleHits(hits), windowSize=Number(els.collocationWindow.value)||5;
    const ids=[...new Set(sample.map(h=>h.doc))];
    await Promise.all(ids.map(tokenTermsForDoc));
    if(ticket!==activeSearch) return;
    const counts=new Map();
    const nodeForms=new Set(hits.map(h=>h.term));
    for(const hit of sample){
      const tokens=tokenCache.get(hit.doc)||[];
      const span=Math.max(1,hit.phraseLength||1);
      for(let i=Math.max(0,hit.token-windowSize);i<=Math.min(tokens.length-1,hit.token+span-1+windowSize);i++){
        if(i>=hit.token && i<hit.token+span) continue;
        const term=tokens[i];
        if(!term || term.length<2 || nodeForms.has(term)) continue;
        counts.set(term,(counts.get(term)||0)+1);
      }
    }
    const lex=await getLexicon();
    if(ticket!==activeSearch) return;
    const corpusFreq=new Map(lex);
    const scale=hits.length/sample.length;
    const ranked=[...counts].map(([term,observed])=>{
      const cooc=observed*scale, freqY=corpusFreq.get(term)||cooc;
      const score=14+Math.log2((2*cooc)/(hits.length+freqY));
      return {term,observed,score};
    }).filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score||b.observed-a.observed||a.term.localeCompare(b.term)).slice(0,10);
    els.collocationList.replaceChildren();
    if(!ranked.length){els.collocationList.innerHTML='<span class="muted">No nearby-word pattern available.</span>';return;}
    for(const item of ranked){
      const span=document.createElement('span');span.className='collocation-chip';span.title=`logDice ${item.score.toFixed(2)}`;
      span.innerHTML=`<strong>${escapeHtml(item.term)}</strong><small>${nice(Math.round(item.observed*scale))}</small>`;
      els.collocationList.append(span);
    }
    const sampled=sample.length<hits.length?` · sampled ${nice(sample.length)} of ${nice(hits.length)} occurrences`:'';
    els.collocationNote.textContent=`+/-${windowSize} words · ranked by logDice${sampled}`;
  }
  async function renderAnalysis(hits,ticket=activeSearch) {
    els.analysisPanel.hidden=!hits.length;
    if(!hits.length) return;
    renderProfile(hits);renderTimeline(hits);
    renderCollocations(hits,ticket).catch(()=>{if(ticket===activeSearch){els.collocationList.innerHTML='<span class="muted">Nearby-word analysis unavailable.</span>';}});
  }
  function kwicParts(body,hit) {
    const matchedEnd=termEnd(body,hit), before=body.slice(Math.max(0,hit.char-500),hit.char), after=body.slice(matchedEnd,Math.min(body.length,matchedEnd+500));
    const left=[...before.matchAll(TOKEN_RE)].slice(-7).map(m=>m[0]);
    const right=[...after.matchAll(TOKEN_RE)].slice(0,7).map(m=>m[0]);
    return {left,right,node:body.slice(hit.char,matchedEnd),l1:norm(left.at(-1)||''),l2:norm(left.at(-2)||''),r1:norm(right[0]||''),r2:norm(right[1]||'')};
  }
  async function orderedHitsForView(hits) {
    if(els.resultView.value!=='kwic' || els.kwicSort.value==='corpus') return hits;
    const ids=[...new Set(hits.map(h=>h.doc))], bodies=new Map();
    await Promise.all(ids.map(async id=>bodies.set(id,(await loadText(id)).body)));
    const key=els.kwicSort.value;
    return [...hits].sort((a,b)=>{
      const pa=kwicParts(bodies.get(a.doc),a), pb=kwicParts(bodies.get(b.doc),b);
      return pa[key].localeCompare(pb[key]) || a.doc-b.doc || a.token-b.token;
    });
  }
  async function renderKwic(page,startOrdinal) {
    const ids=[...new Set(page.map(h=>h.doc))], bodies=new Map();
    await Promise.all(ids.map(async id=>bodies.set(id,(await loadText(id)).body)));
    els.results.replaceChildren();
    const table=document.createElement('div');table.className='kwic-table';
    let ordinal=startOrdinal;
    for(const hit of page){
      ordinal++;
      const doc=manifest.documents[hit.doc], body=bodies.get(hit.doc), k=kwicParts(body,hit);
      const row=document.createElement('div');row.className='kwic-row';
      row.innerHTML=`<span class="kwic-number">${nice(ordinal)}</span><button type="button" class="kwic-source" title="${escapeHtml(doc.title)}">${escapeHtml(doc.code)}</button><span class="kwic-left">${escapeHtml(k.left.join(' '))}</span><mark class="kwic-node">${escapeHtml(k.node)}</mark><span class="kwic-right">${escapeHtml(k.right.join(' '))}</span><button type="button" class="hit-open">In text \u2192</button>`;
      row.querySelector('.kwic-source').onclick=()=>searchOnlyText(hit.doc);
      row.querySelector('.hit-open').onclick=()=>openText(hit.doc,hit.char,'text',termEnd(body,hit)-hit.char);
      table.append(row);
    }
    els.results.append(table);
  }
  function editDistance(a,b,max=3) {
    if(Math.abs(a.length-b.length)>max) return max+1;
    let prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      const cur=[i], min=Math.max(1,i-max), high=Math.min(b.length,i+max);
      for(let j=1;j<=b.length;j++) cur[j]=j<min||j>high?max+1:Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
      prev=cur;
    }
    return prev[b.length];
  }
  async function renderRescue(query) {
    if(searchResult?.mode!=='word') return;
    const forms=tokensOf(query);if(forms.length!==1) return;
    const target=fold(forms[0]);if(!target) return;
    const lex=await getLexicon();
    const suggestions=[];
    for(const [term,count] of lex){
      const f=fold(term);if(!f||f===target||Math.abs(f.length-target.length)>2||f[0]!==target[0]) continue;
      const d=editDistance(target,f,2);if(d<=2 || f.includes(target) || target.includes(f)) suggestions.push({term,count,d});
    }
    suggestions.sort((a,b)=>a.d-b.d||b.count-a.count||a.term.localeCompare(b.term));
    if(!suggestions.length) return;
    const box=document.createElement('div');box.className='search-rescue';box.innerHTML='<strong>Possible corpus forms</strong><div></div>';
    const row=box.querySelector('div');
    for(const item of suggestions.slice(0,8)){
      const button=document.createElement('button');button.type='button';button.textContent=`${item.term} (${nice(item.count)})`;
      button.onclick=()=>{els.query.value=item.term;els.modeSelect.value='word';runSearch(true);};row.append(button);
    }
    els.results.append(box);
  }
  function termEnd(body,hit) {
    if (!hit.phraseLength || hit.phraseLength===1) return hit.char+wordLength(body,hit.char);
    const tail=body.slice(hit.char,hit.char+1000);
    const forms=[...tail.matchAll(TOKEN_RE)];
    const last=forms[hit.phraseLength-1];
    return last ? hit.char+last.index+last[0].length : hit.char+wordLength(body,hit.char);
  }
  function wordLength(body,start) {
    const m=body.slice(start,start+160).match(/^[\p{L}\p{M}\p{N}]+(?:[’'`´-][\p{L}\p{M}\p{N}]+)*/u);
    return m?m[0].length:1;
  }
  function contextRange(body,hit,count) {
    const matchedEnd=termEnd(body,hit);
    const radius=Math.max(600,count*22);
    const beforeStart=Math.max(0,hit.char-radius), afterEnd=Math.min(body.length,matchedEnd+radius);
    const before=body.slice(beforeStart,hit.char), after=body.slice(matchedEnd,afterEnd);
    const beforeMatches=[...before.matchAll(TOKEN_RE)];
    let candidates=beforeMatches;
    if (beforeStart>0 && /[\p{L}\p{M}\p{N}]/u.test(body[beforeStart-1]) && beforeMatches[0]?.index===0) candidates=beforeMatches.slice(1);
    const last=candidates.slice(-count);
    let left=last.length?beforeStart+last[0].index:hit.char;
    if (beforeStart===0 && (!last.length || beforeMatches.length<=count)) left=0;
    const afterMatches=[...after.matchAll(TOKEN_RE)].slice(0,count);
    let right=afterMatches.length?matchedEnd+afterMatches.at(-1).index+afterMatches.at(-1)[0].length:matchedEnd;
    if (right===matchedEnd && afterEnd===body.length) right=body.length;
    if (hit.nearChar!==undefined) {
      const nearEnd=hit.nearChar+wordLength(body,hit.nearChar);
      left=Math.min(left,hit.nearChar);
      right=Math.max(right,nearEnd);
    }
    return {start:left,end:right,matchedEnd};
  }
  function contextMarkup(body,hit) {
    const count=Number(els.contextSize.value)||24;
    const {start,end,matchedEnd}=contextRange(body,hit,count);
    const ranges=[{start:hit.char,end:matchedEnd,cls:''}];
    if (hit.nearChar!==undefined && hit.nearChar!==hit.char)
      ranges.push({start:hit.nearChar,end:hit.nearChar+wordLength(body,hit.nearChar),cls:'near-mark'});
    const rangesInView=ranges.filter(x=>x.end>start&&x.start<end).sort((a,b)=>a.start-b.start);
    let cursor=start, html='';
    for (const range of rangesInView) {
      if (range.start<cursor) continue;
      html+=escapeHtml(body.slice(cursor,range.start));
      html+=`<mark${range.cls?` class="${range.cls}"`:''}>${escapeHtml(body.slice(range.start,range.end))}</mark>`;
      cursor=range.end;
    }
    html+=escapeHtml(body.slice(cursor,end));
    return `${start>0?'<span class="ellipsis">… </span>':''}${html}${end<body.length?'<span class="ellipsis"> …</span>':''}`;
  }
  function renderDistribution(hits) {
    const counts=sourceCounts(hits);
    const shown=allDistribution?counts:counts.slice(0,15);
    els.distribution.replaceChildren();
    if (!counts.length) {els.distribution.innerHTML='<p class="muted">No matches.</p>';els.showAllSources.hidden=true;return;}
    for (const [docId, count] of shown) {
      const doc=manifest.documents[docId];
      const row=document.createElement('div');row.className='distribution-row';
      const button=document.createElement('button');button.type='button';button.textContent=`${doc.code} · ${doc.title}`;
      button.title=`Show matches in ${doc.title}`;button.onclick=()=>searchOnlyText(docId);
      const value=document.createElement('span');value.className='distribution-count';value.textContent=nice(count);
      row.append(button,value);els.distribution.append(row);
    }
    els.showAllSources.hidden=counts.length<=15;
    els.showAllSources.textContent=allDistribution?'Show fewer':'Show all '+nice(counts.length)+' texts';
  }
  async function renderResults(ticket=activeSearch) {
    if (!searchResult) return;
    const base=displayedHits();
    const ordered=await orderedHitsForView(base);
    if(ticket!==activeSearch) return;
    const total=ordered.length;
    const pages=Math.max(1,Math.ceil(total/pageSize()));
    currentPage=Math.min(Math.max(1,currentPage),pages);
    const page=ordered.slice((currentPage-1)*pageSize(),currentPage*pageSize());
    const docs=new Set(base.map(h=>h.doc)).size;
    const metrics=analysisMetrics(base);
    els.resultsControls.hidden=false;
    els.kwicSortLabel.hidden=els.resultView.value!=='kwic';
    els.contextSize.closest('label').hidden=els.resultView.value==='kwic';
    els.resultHeading.textContent=`Results for \u201c${searchResult.query}\u201d`;
    const capped=searchResult.capped?' \u00b7 results limited':searchResult.truncatedTerms?' \u00b7 form expansion limited':'';
    setStatus(`${nice(total)} occurrence${total===1?'':'s'} in ${nice(docs)} text${docs===1?'':'s'} \u00b7 ${compactRate(metrics.rate)} per 10k indexed words${capped}`);
    els.resultStats.textContent=[['regex','wildcard','morph'].includes(searchResult.mode)?`${nice(searchResult.expanded)} indexed form${searchResult.expanded===1?'':'s'}`:'', `Page ${nice(currentPage)} of ${nice(pages)}`].filter(Boolean).join(' \u00b7 ');
    els.copySearchLink.disabled=false;els.exportCsv.disabled=!total;
    renderDistribution(base);
    await renderAnalysis(base,ticket);
    if (!total) {
      els.analysisPanel.hidden=true;
      els.results.innerHTML='<div class="empty-state">No matches. Check the spelling, remove a filter, or try another search mode.</div>';
      els.pagination.innerHTML='';
      await renderRescue(searchResult.query);
      return;
    }
    if(els.resultView.value==='kwic'){
      await renderKwic(page,(currentPage-1)*pageSize());
      renderPagination(pages);return;
    }
    await Promise.all([...new Set(page.map(h=>h.doc))].map(loadText));
    if (ticket!==activeSearch) return;
    els.results.replaceChildren();
    const groups=new Map();
    for (const hit of page) {
      if (!groups.has(hit.doc))groups.set(hit.doc,[]);
      groups.get(hit.doc).push(hit);
    }
    let ordinal=(currentPage-1)*pageSize();
    const allCounts=new Map(sourceCounts(base));
    for (const [id,hits] of groups) {
      const doc=manifest.documents[id], body=(await loadText(id)).body, count=allCounts.get(id);
      const docRate=per10k(count,doc.indexed_tokens||0);
      const section=document.createElement('section');section.className='result-group';
      section.innerHTML=`<div class="result-group-head"><div><h3 class="source-title">${escapeHtml(doc.title)}</h3><p class="result-meta"><span class="result-code">${escapeHtml(doc.code)}</span>${[doc.dates,doc.provenance].filter(Boolean).map(v=>`<span>\u00b7 ${escapeHtml(v)}</span>`).join('')}</p></div><span class="source-occur">${nice(count)} match${count===1?'':'es'} \u00b7 ${compactRate(docRate)} / 10k</span></div><div class="source-actions"><button type="button" data-open>Read text</button><button type="button" data-limit>Only this text</button><button type="button" data-info>Metadata</button></div><ol class="hit-list"></ol>`;
      section.querySelector('[data-open]').onclick=()=>openText(id);
      section.querySelector('[data-limit]').onclick=()=>searchOnlyText(id);
      section.querySelector('[data-info]').onclick=()=>openText(id,null,'metadata');
      const list=section.querySelector('ol');
      for (const hit of hits) {
        ordinal++;
        const row=document.createElement('li');row.className='hit-row';
        row.innerHTML=`<span class="hit-number">${nice(ordinal)}</span><div class="context-line">${contextMarkup(body,hit)}</div><button type="button" class="hit-open" aria-label="Read occurrence ${ordinal} in ${escapeHtml(doc.title)}">In text \u2192</button>`;
        row.querySelector('.hit-open').onclick=()=>openText(id,hit.char,'text',termEnd(body,hit)-hit.char);
        list.append(row);
      }
      section.append(list);els.results.append(section);
    }
    renderPagination(pages);
  }
  function pageSize(){return Number(els.pageSizeSelect.value)||PAGE_DEFAULT;}
  function renderPagination(pages) {
    els.pagination.replaceChildren();
    if(pages<2) return;
    const btn=(label,p,active=false,disabled=false)=>{
      const b=document.createElement('button');b.type='button';b.textContent=label;
      b.disabled=disabled||active;if(active){b.className='is-current';b.setAttribute('aria-current','page');}
      if(!b.disabled)b.onclick=()=>goPage(p);
      els.pagination.append(b);
    };
    const dots=()=>{const s=document.createElement('span');s.className='page-ellipsis';s.textContent='…';els.pagination.append(s);};
    btn('Previous',currentPage-1,false,currentPage===1);
    btn('1',1,currentPage===1);
    const a=Math.max(2,currentPage-2),z=Math.min(pages-1,currentPage+2);
    if(a>2)dots();
    for(let n=a;n<=z;n++)btn(String(n),n,n===currentPage);
    if(z<pages-1)dots();
    btn(String(pages),pages,currentPage===pages);
    btn('Next',currentPage+1,false,currentPage===pages);
    const jump=document.createElement('form');jump.className='page-jump';
    jump.innerHTML=`<label>Page <input type="number" min="1" max="${pages}" value="${currentPage}" aria-label="Go to page"></label><button type="submit">Go</button>`;
    jump.onsubmit=e=>{e.preventDefault();goPage(Math.max(1,Math.min(pages,Number(jump.querySelector('input').value)||1)));};
    els.pagination.append(jump);
  }
  function goPage(n) {currentPage=n;syncSearchUrl(true);renderResults();scrollResults();}
  function scrollResults(){els.resultHeading.scrollIntoView({behavior:'smooth',block:'start'});}
  async function searchOnlyText(id){els.textFilter.value=String(id);updateFilterCount();showView('search');await runSearch(true);window.scrollTo(0,0);}
  function updateFilterCount(){
    const count=[els.textFilter.value,els.centuryFilter.value,els.provenanceFilter.value.trim(),els.sortFilter.value!=='corpus',els.looseMatch.checked].filter(Boolean).length;
    els.filterCount.textContent=count?`${count} filter${count===1?'':'s'} applied`:'';
    els.mobileFilterCount.textContent=count?`(${count} active)`:'';
  }
  function searchUrl() {
    const q=new URLSearchParams();
    if(els.query.value.trim())q.set('q',els.query.value.trim());
    if(els.modeSelect.value!=='word')q.set('mode',els.modeSelect.value);
    if(els.textFilter.value)q.set('text',els.textFilter.value);
    if(els.centuryFilter.value)q.set('century',els.centuryFilter.value);
    if(els.provenanceFilter.value.trim())q.set('prov',els.provenanceFilter.value.trim());
    if(els.sortFilter.value!=='corpus')q.set('sort',els.sortFilter.value);
    if(els.looseMatch.checked)q.set('loose','1');
    if(els.formFilter.value)q.set('form',els.formFilter.value);
    if(currentPage>1)q.set('page',String(currentPage));
    if(pageSize()!==PAGE_DEFAULT)q.set('per',String(pageSize()));
    if(els.contextSize.value!=='24')q.set('context',els.contextSize.value);
    if(els.resultView.value!=='context')q.set('display',els.resultView.value);
    if(els.resultView.value==='kwic' && els.kwicSort.value!=='corpus')q.set('kwic',els.kwicSort.value);
    return `${location.pathname}${q.toString()?'?'+q.toString():''}`;
  }
  function syncSearchUrl(push) {
    lastSearchUrl=searchUrl();
    history[push?'pushState':'replaceState'](null,'',lastSearchUrl);
  }
  function resetFormFromUrl() {
    const p=routeParams();
    els.query.value=p.get('q')||'';
    const mode=p.get('mode')||'word';els.modeSelect.value=[...els.modeSelect.options].some(x=>x.value===mode)?mode:'word';
    const text=p.get('text')||(p.get('texts')||'').split(',')[0];
    els.textFilter.value=text&&[...els.textFilter.options].some(o=>o.value===text)?text:'';
    els.centuryFilter.value=p.get('century')||'';
    els.provenanceFilter.value=p.get('prov')||'';
    els.sortFilter.value=p.get('sort')||'corpus';
    els.looseMatch.checked=p.get('loose')==='1';
    els.pageSizeSelect.value=['25','50','100'].includes(p.get('per'))?p.get('per'):'50';
    els.contextSize.value=['12','24','42'].includes(p.get('context'))?p.get('context'):'24';
    els.resultView.value=p.get('display')==='kwic'?'kwic':'context';
    els.kwicSort.value=['corpus','l1','l2','r1','r2'].includes(p.get('kwic'))?p.get('kwic'):'corpus';
    els.kwicSortLabel.hidden=els.resultView.value!=='kwic';
    els.contextSize.closest('label').hidden=els.resultView.value==='kwic';
    currentPage=Math.max(1,Math.floor(numeric(p.get('page'),1)));
    els.formFilter.replaceChildren(new Option('All forms',''));
    els.formFilter.value=p.get('form')||'';
    els.modeHelp.textContent=modeHints[els.modeSelect.value];updateFilterCount();
  }
  function showView(name) {
    currentView=name;
    document.querySelectorAll('.view').forEach(x=>x.classList.toggle('is-active',x.id===`${name}View`));
    document.querySelectorAll('[data-view-link]').forEach(a=>{
      const selected=a.dataset.viewLink===(name==='reader'?'texts':name);
      a.classList.toggle('is-active',selected);
      if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
  }
  function goView(name) {
    let url=name==='search'?lastSearchUrl:`${location.pathname}?view=${encodeURIComponent(name)}`;
    history.pushState(null,'',url);handleRoute();window.scrollTo(0,0);
  }
  function switchToSearch(){if(currentView!=='search')goView('search');}
  async function handleRoute() {
    const p=routeParams();const view=p.get('view')||'search';
    if(view==='reader') {
      showView('reader');await loadReaderFromRoute(p);return;
    }
    showView(['search','texts','help','about'].includes(view)?view:'search');
    if(view==='texts')renderTextCatalogue();
    if(view==='search') {
      resetFormFromUrl();lastSearchUrl=`${location.pathname}${location.search}`;
      if(els.query.value.trim())await runSearch(false);
      else {
        ++activeSearch;searchResult=null;
        els.resultHeading.textContent='Ready to search';setStatus('');els.resultStats.textContent='';
        els.results.innerHTML='<div class="empty-state">Enter a word or expression above to search the full corpus.</div>';
        els.resultsControls.hidden=true;els.pagination.innerHTML='';
        els.analysisPanel.hidden=true;
        els.distribution.innerHTML='<p class="muted">Search to see the distribution.</p>';
        els.copySearchLink.disabled=true;els.exportCsv.disabled=true;
      }
    }
  }
  async function exportCSV() {
    const hits=displayedHits();if(!hits.length)return;
    els.exportCsv.disabled=true;const old=els.exportCsv.textContent;
    els.exportCsv.textContent='Preparing…';
    try {
      const ids=[...new Set(hits.map(x=>x.doc))];
      // Load sequentially to avoid congesting the connection on large exports.
      const docs=new Map();for(const id of ids)docs.set(id,(await loadText(id)).body);
      const rows=[['query','mode','code','title','dates','provenance','token_position','character_position','matched_form','context']];
      for(const hit of hits){
        const d=manifest.documents[hit.doc],body=docs.get(hit.doc);
        const {start,end,matchedEnd}=contextRange(body,hit,24);
        rows.push([searchResult.query,searchResult.mode,d.code,d.title,d.dates,d.provenance,hit.token,hit.char,body.slice(hit.char,matchedEnd),body.slice(start,end).replace(/\s+/g,' ').trim()]);
      }
      const csv=rows.map(row=>row.map(s=>`"${String(s??'').replaceAll('"','""')}"`).join(',')).join('\r\n');
      const blob=new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=`malay-concordance-${fold(searchResult.query).slice(0,50)||'results'}.csv`;document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
    }catch(e){setStatus(`CSV export failed: ${e.message}`,true);}finally{els.exportCsv.disabled=false;els.exportCsv.textContent=old;}
  }
  async function copyUrl(button) {
    const old=button.textContent;
    try {await navigator.clipboard.writeText(location.href);button.textContent='Copied';}
    catch(e) {window.prompt('Copy this URL:',location.href);}
    setTimeout(()=>button.textContent=old,1300);
  }
  function renderTextCatalogue() {
    if(!manifest)return;
    const query=fold(els.textBrowserSearch.value), sort=els.textBrowserSort.value;
    let docs=manifest.documents.filter(d=>!query||fold([d.title,d.code,d.dates,d.provenance].join(' ')).includes(query));
    docs=[...docs];
    if(sort==='title')docs.sort((a,b)=>a.title.localeCompare(b.title));
    else if(sort==='date')docs.sort((a,b)=>(a.year_min||9999)-(b.year_min||9999)||a.title.localeCompare(b.title));
    else if(sort==='words')docs.sort((a,b)=>(b.word_count||b.indexed_tokens)-(a.word_count||a.indexed_tokens));
    els.textBrowserCount.textContent=`${nice(docs.length)} of ${nice(manifest.documents.length)} texts`;
    els.textBrowser.replaceChildren();
    for (const d of docs){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td><button type="button" class="text-title-button">${escapeHtml(d.title)}</button><br><span class="text-code-inline">${escapeHtml(d.code)}</span></td><td>${escapeHtml(d.dates||'—')}</td><td>${escapeHtml(d.provenance||'—')}</td><td class="numeric">${nice(d.word_count||d.indexed_tokens)}</td><td><button type="button" class="table-open">Open →</button></td>`;
      tr.querySelectorAll('button').forEach(b=>b.onclick=()=>openText(d.id));
      els.textBrowser.append(tr);
    }
  }
  function openText(id,pos=null,tab='text',length=null) {
    const d=manifest.documents[id];if(!d)return;
    const p=new URLSearchParams({view:'reader',doc:d.code});
    if(pos!==null)p.set('pos',String(pos));
    if(tab!=='text')p.set('tab',tab);
    if(length&&length>1)p.set('len',String(length));
    history.pushState(null,'',`${location.pathname}?${p}`);
    handleRoute();window.scrollTo(0,0);
  }
  function findDoc(code) {
    return manifest.documents.find(d=>d.code===code) || manifest.documents.find(d=>d.file_id===code) || null;
  }
  async function loadReaderFromRoute(p) {
    const d=findDoc(p.get('doc'));if(!d){els.readerTitle.textContent='Text not found';els.readerContent.textContent='The requested text is not in this corpus.';return;}
    currentReader=d.id;
    els.readerCode.textContent=d.code;els.readerTitle.textContent=d.title;
    els.readerSubtitle.textContent=[d.dates,d.provenance].filter(Boolean).join(' · ');
    els.readerDetails.replaceChildren();
    const fields=[['MCP code',d.code],['Dates',d.dates],['Provenance',d.provenance],['Words',nice(d.word_count||d.indexed_tokens)],['Reference scheme',d.reference_scheme]];
    for(const [label,value] of fields)if(value){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;els.readerDetails.append(dt,dd);}
    readerPosition=p.has('pos')?Math.max(0,Math.floor(numeric(p.get('pos'),0))):null;
    readerTab=['text','metadata','vocabulary'].includes(p.get('tab'))?p.get('tab'):'text';
    els.readerFind.value='';readerFindMatches=[];readerFindIndex=0;
    els.readerContent.textContent='Loading text…';
    const doc=await loadText(d.id);
    if(currentReader!==d.id||currentView!=='reader')return;
    readerDoc=doc;
    await showReaderTab(readerTab,true);
  }
  async function showReaderTab(tab,fromRoute=false) {
    readerTab=tab;
    for(const [name,id] of Object.entries({text:'readerText',metadata:'readerMeta',vocabulary:'readerVocab'})){
      const b=els[id];b.classList.toggle('is-active',name===tab);b.setAttribute('aria-selected',String(name===tab));
    }
    els.readerFindBar.hidden=tab!=='text';
    if(!fromRoute){const params=routeParams();if(tab==='text')params.delete('tab');else params.set('tab',tab);history.replaceState(null,'',`${location.pathname}?${params}`);}
    if(tab==='metadata') {
      const d=manifest.documents[currentReader];
      const fields=[['Title',d.title],['MCP code',d.code],['Edition',d.edition],['Manuscript',d.manuscript],['Dates',d.dates],['Provenance',d.provenance],['MCP word count',d.word_count_raw],['Reference scheme',d.reference_scheme],['Source file',d.source_file]];
      els.readerContent.className='reader-content metadata-view';
      els.readerContent.innerHTML=`<dl class="metadata-list">${fields.filter(([,v])=>v).map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><details><summary>Complete archival editorial record</summary><div class="metadata-raw">${escapeHtml(d.metadata_raw)}</div></details>`;
    } else if (tab==='vocabulary') {
      els.readerContent.className='reader-content metadata-view';
      els.readerContent.innerHTML='<p>Loading vocabulary…</p>';
      await renderVocabulary();
    } else {showReaderText(readerPosition);}
  }
  function showReaderText(pos=null,len=null) {
    if(!readerDoc)return;
    const body=readerDoc.body;
    els.readerContent.className='reader-content';els.readerContent.replaceChildren();
    if(pos===null||pos<0||pos>=body.length){els.readerContent.textContent=body;return;}
    const param=routeParams();len=len||Math.max(1,Math.floor(numeric(param.get('len'),0)))||wordLength(body,pos);
    els.readerContent.append(document.createTextNode(body.slice(0,pos)));
    const mark=document.createElement('mark');mark.id='currentMatch';mark.textContent=body.slice(pos,pos+len);
    els.readerContent.append(mark,document.createTextNode(body.slice(pos+len)));
    requestAnimationFrame(()=>mark.scrollIntoView({behavior:'instant',block:'center'}));
  }
  function findWithinReader() {
    if(!readerDoc||readerTab!=='text')return;
    const word=els.readerFind.value.trim();readerFindMatches=[];readerFindIndex=0;
    if(!word){els.readerFindCount.textContent='';return;}
    const body=readerDoc.body.toLocaleLowerCase(),target=word.toLocaleLowerCase();
    let from=0;
    while(from<body.length&&readerFindMatches.length<20000){const at=body.indexOf(target,from);if(at<0)break;readerFindMatches.push(at);from=at+Math.max(1,target.length);}
    els.readerFindCount.textContent=readerFindMatches.length?`${nice(readerFindMatches.length)} matches`:'No matches';
    if(readerFindMatches.length)moveReaderMatch(0);
  }
  function moveReaderMatch(index) {
    if(!readerFindMatches.length)return;
    readerFindIndex=(index+readerFindMatches.length)%readerFindMatches.length;
    readerPosition=readerFindMatches[readerFindIndex];
    const p=routeParams();p.set('pos',String(readerPosition));p.set('len',String(els.readerFind.value.length));
    history.replaceState(null,'',`${location.pathname}?${p}`);
    showReaderText(readerPosition,els.readerFind.value.length);
    els.readerFindCount.textContent=`${nice(readerFindIndex+1)} / ${nice(readerFindMatches.length)}`;
  }
  async function renderVocabulary() {
    if(currentReader==null)return;
    const vocab=await loadVocabulary(currentReader);
    if(readerTab!=='vocabulary')return;
    const wrapper=document.createElement('div');
    wrapper.innerHTML='<div class="vocab-toolbar"><input id="vocabQuery" type="search" placeholder="Filter word forms" aria-label="Filter vocabulary"><select id="vocabSort" aria-label="Vocabulary order"><option value="freq">Most frequent</option><option value="alpha">Alphabetical</option></select></div><table class="vocab-table"><tbody id="vocabBody"></tbody></table><div class="vocab-footer"><span id="vocabCount"></span><button class="button-secondary" id="vocabMore" type="button">Show more</button></div>';
    els.readerContent.replaceChildren(wrapper);
    const input=wrapper.querySelector('#vocabQuery'),sort=wrapper.querySelector('#vocabSort'),tbody=wrapper.querySelector('#vocabBody'),counter=wrapper.querySelector('#vocabCount'),more=wrapper.querySelector('#vocabMore');
    function paint(){
      let rows=vocab.filter(([form])=>!input.value||fold(form).includes(fold(input.value)));
      rows=[...rows];
      if(sort.value==='alpha')rows.sort((a,b)=>a[0].localeCompare(b[0]));else rows.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
      tbody.replaceChildren();
      for(const [term,count] of rows.slice(0,vocabPage*100)){
        const tr=document.createElement('tr');const td=document.createElement('td'),num=document.createElement('td'),button=document.createElement('button');
        button.textContent=term;button.onclick=()=>{els.query.value=term;els.modeSelect.value='word';els.textFilter.value=String(currentReader);showView('search');runSearch(true);window.scrollTo(0,0);};
        td.append(button);num.textContent=nice(count);tr.append(td,num);tbody.append(tr);
      }
      counter.textContent=`Showing ${nice(Math.min(rows.length,vocabPage*100))} of ${nice(rows.length)} forms`;
      more.hidden=rows.length<=vocabPage*100;
    }
    input.addEventListener('input',()=>{vocabPage=1;paint();});sort.addEventListener('change',()=>{vocabPage=1;paint();});
    more.onclick=()=>{vocabPage++;paint();};vocabPage=1;paint();
  }
  function onFilterUpdate() {updateFilterCount();if(els.query.value.trim())runSearch(true);}
  function setupEvents() {
    els.searchForm.addEventListener('submit',e=>{e.preventDefault();switchToSearch();runSearch(true);});
    document.querySelectorAll('[data-view-link]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();goView(a.dataset.viewLink);}));
    document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{els.query.value=button.dataset.example;els.modeSelect.value=button.dataset.exampleMode;els.modeHelp.textContent=modeHints[els.modeSelect.value];switchToSearch();runSearch(true);}));
    els.modeSelect.addEventListener('change',()=>els.modeHelp.textContent=modeHints[els.modeSelect.value]);
    for(const x of [els.textFilter,els.centuryFilter,els.sortFilter,els.looseMatch])x.addEventListener('change',onFilterUpdate);
    let provenanceTimer;els.provenanceFilter.addEventListener('input',()=>{clearTimeout(provenanceTimer);provenanceTimer=setTimeout(onFilterUpdate,450);});
    els.clearFilters.addEventListener('click',()=>{els.textFilter.value='';els.centuryFilter.value='';els.provenanceFilter.value='';els.sortFilter.value='corpus';els.looseMatch.checked=false;els.formFilter.value='';onFilterUpdate();});
    els.formFilter.addEventListener('change',()=>{currentPage=1;syncSearchUrl(true);renderResults();});
    els.resultView.addEventListener('change',()=>{currentPage=1;els.kwicSortLabel.hidden=els.resultView.value!=='kwic';els.contextSize.closest('label').hidden=els.resultView.value==='kwic';syncSearchUrl(true);renderResults();});
    els.kwicSort.addEventListener('change',()=>{currentPage=1;syncSearchUrl(true);renderResults();});
    els.pageSizeSelect.addEventListener('change',()=>{currentPage=1;syncSearchUrl(true);renderResults();});
    els.contextSize.addEventListener('change',()=>{syncSearchUrl(true);renderResults();});
    els.timelineRate.addEventListener('click',()=>{timelineMode='rate';els.timelineRate.classList.add('is-active');els.timelineRaw.classList.remove('is-active');if(searchResult)renderTimeline(displayedHits());});
    els.timelineRaw.addEventListener('click',()=>{timelineMode='raw';els.timelineRaw.classList.add('is-active');els.timelineRate.classList.remove('is-active');if(searchResult)renderTimeline(displayedHits());});
    els.collocationWindow.addEventListener('change',()=>{if(searchResult)renderCollocations(displayedHits(),activeSearch);});
    els.exportCsv.onclick=exportCSV;els.copySearchLink.onclick=()=>copyUrl(els.copySearchLink);
    els.showAllSources.onclick=()=>{allDistribution=!allDistribution;renderDistribution(displayedHits());};
    els.textBrowserSearch.addEventListener('input',renderTextCatalogue);els.textBrowserSort.addEventListener('change',renderTextCatalogue);
    els.readerBack.onclick=()=>{if(history.length>1)history.back();else goView('texts');};
    els.readerText.onclick=()=>showReaderTab('text');els.readerMeta.onclick=()=>showReaderTab('metadata');els.readerVocab.onclick=()=>showReaderTab('vocabulary');
    els.readerSearch.onclick=()=>{els.textFilter.value=String(currentReader);showView('search');syncSearchUrl(true);els.query.focus();window.scrollTo(0,0);};
    els.copyReaderLink.onclick=()=>copyUrl(els.copyReaderLink);
    let findTimer;els.readerFind.addEventListener('input',()=>{clearTimeout(findTimer);findTimer=setTimeout(findWithinReader,280);});
    els.readerFindNext.onclick=()=>moveReaderMatch(readerFindIndex+1);els.readerFindPrev.onclick=()=>moveReaderMatch(readerFindIndex-1);
    window.addEventListener('popstate',()=>{handleRoute();});
    document.addEventListener('keydown',e=>{
      if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){
        e.preventDefault();goView('search');els.query.focus();
      }
    });
  }
  async function init() {
    setupEvents();
    try{
      manifest=await json(`${DATA}manifest.json`);
      const smallScreen=window.matchMedia('(max-width: 800px)');
      els.mobileFilters.open=!smallScreen.matches;
      smallScreen.addEventListener('change',event=>{els.mobileFilters.open=!event.matches;});
      els.corpusSummary.textContent=`${nice(manifest.document_count)} texts · ${nice(manifest.indexed_tokens)} indexed words`;
      for(const d of manifest.documents)els.textFilter.add(new Option(`${d.code} · ${d.title}`,String(d.id)));
      renderTextCatalogue();await handleRoute();
    }catch(e){
      els.corpusSummary.textContent='Corpus data could not be loaded.';
      els.results.innerHTML='<div class="empty-state">The search index is unavailable. Please try again later.</div>';
      setStatus(e.message||String(e),true);
    }
  }
  init();
})();
