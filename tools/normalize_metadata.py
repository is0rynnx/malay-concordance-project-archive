#!/usr/bin/env python3
"""Generate normalized chronology and provenance fields for the corpus manifest."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTES = json.loads((Path(__file__).with_name('catalogue.json')).read_text(encoding='utf-8'))

YEAR = re.compile(r'(?<!\d)(1[0-9]{3}|20[0-9]{2})(s)?(?!\d)')
ROLE = re.compile(r'\b(?:manuscripts?|mss?|lithograph|print(?:ed)?\s+(?:edition|source)|edition)\s*:', re.I)
UNKNOWN = re.compile(r'^(?:\??\s*(?:unknown|not\s+known|undated|none|\?))\b', re.I)

# Corpus-specific cases where the archival field alone does not support a
# single compositional date or place.
EXCEPTIONS = {
    'BS': {'year': 1638, 'date': 'Begun in 1638', 'date_note': 'Completed before 1643', 'quality': 'document', 'periodable': True},
    'Perb': {'year': 1835, 'date': '1835', 'date_note': 'Manuscript: 1835', 'origin': 'Singapore', 'origin_note': 'Manuscript: Melaka', 'quality': 'document', 'periodable': True},
    'BBT': {'year': 1303, 'date': '1303 or 1308', 'date_note': 'Dating disputed', 'origin': 'Kuala Berang, Terengganu', 'quality': 'disputed', 'periodable': False},
    'SM': {'year': 1612, 'date': 'Revised in 1612', 'date_note': 'Earlier composition dates remain uncertain; manuscript: 1808', 'quality': 'revision', 'periodable': True},
    'PandL': {'year': None, 'date': 'Date disputed', 'date_note': 'Proposals range from the fourteenth to eighteenth centuries', 'quality': 'disputed', 'periodable': False},
    'KS': {'year': 1879, 'date': '1879 and 1935', 'date_note': 'Different editions', 'quality': 'collection', 'periodable': False},
    'UKJ': {'year': 1887, 'date': '1887', 'date_note': 'Printed later', 'quality': 'document'},
    'Mpt': {'year': 1884, 'date': 'After 1883', 'date_note': 'Manuscript: 1887', 'origin': 'Batavia (Jakarta)', 'quality': 'lower_bound', 'periodable': True},
    'PRO': {'quality': 'collection', 'periodable': False},
    'Gold': {'quality': 'collection', 'periodable': False},
    'Wrkh': {'quality': 'collection', 'periodable': False},
    'VN': {'quality': 'collection', 'periodable': False},
    'Banten': {'quality': 'collection', 'periodable': False},
    'UU': {'quality': 'collection', 'periodable': False},
    'PK': {'quality': 'collection', 'periodable': False},
    'PBali': {'quality': 'collection', 'periodable': False},
    'PBanj': {'quality': 'collection', 'periodable': False},
    'PRiau': {'quality': 'collection', 'periodable': False},
    'VdW': {'quality': 'collection', 'periodable': False},
    'PiagM': {'quality': 'collection', 'periodable': False},
    'PiagS': {'quality': 'collection', 'periodable': False},
    'Pah': {'year': 1883, 'date': '1883 and 1932', 'quality': 'collection', 'periodable': False},
    'WBima': {'quality': 'collection', 'periodable': False},
    'WBrn': {'quality': 'collection', 'periodable': False},
    'WButon': {'quality': 'collection', 'periodable': False},
    'WSln': {'quality': 'collection', 'periodable': False},
    'WTgn': {'quality': 'collection', 'periodable': False},
    'WSumB': {'quality': 'collection', 'periodable': False},
    'SITS': {'quality': 'collection', 'periodable': False},
    'Farq': {'quality': 'collection', 'periodable': False},
    'M': {'quality': 'collection', 'periodable': False},
    'MG': {'quality': 'collection', 'periodable': False},
    'WM': {'quality': 'collection', 'periodable': False},
    'S': {'quality': 'collection', 'periodable': False},
    'Imam': {'quality': 'collection', 'periodable': False},
    'SRN': {'year': None, 'date': 'Date not established', 'quality': 'unknown', 'periodable': False},
    'QB': {'year': None, 'date': 'Malay translation undated', 'date_note': 'Manuscript: before 1604; Arabic original: thirteenth century', 'quality': 'unknown', 'periodable': False},
    'TW': {'origin': 'Not established'},
    'Anb': {'origin': 'Not established', 'origin_note': 'Manuscript: Melaka'},
    'ABS': {'origin': 'Not established', 'origin_note': 'Manuscript copied in Batavia'},
    'Iblis': {'origin': 'Not established', 'origin_note': 'Manuscript: Java'},
    'HS': {'origin': 'Aceh', 'origin_note': 'Manuscript copying place unknown'},
    'HF': {'origin': 'Aceh'},
    'Bayan': {'quality': 'estimated', 'periodable': False},
}

GENRES = {
    'Periodical': set('Imam M MG S WM VN'.split()),
    'Correspondence': set('Banten Farq Gold PBali PBanj PRiau PRO Pwng SITS SRN WBrn WBima WButon Wrkh WSln WSumB WTgn VdW'.split()),
    'Law and administration': set('BBT BT IMTS PiagM PiagS PTgn UU Minto'.split()),
    'Religious prose': set('AA AN Anb BS HAR HS JM KS MN Munt QB R RS RT SA ST Tkbr TM TS.K TS.R TW'.split()),
    'Poetry': set('Abd.S Awai BayB Bid Buah Das DBB Dmsy.S Fansur HF Hemop K&M KBima Kmt Kosta KT KTS Kumb Kupu LKrm Maul Mekah MSiamB Mwr NasTgn Nuri NurP Nymk PG PJ PK PSL Pung Raksi RJoh SAB SBod Srg SSiti Sunur T&K TZA Ungg Wangk Zub'.split()),
    'History and chronicles': set('ARM Bangka Banj Barus CPK EPut Hitu J&P Kel Kutai M&B Misa NJoh NMuda Pah Pasai Perak PPRiau Siak Sikka SKel SM TBarus TN'.split()),
}


def clean(text: str) -> str:
    return re.sub(r'\s+', ' ', text or '').strip(' .;,')


def show_date(s: str) -> str:
    s = clean(s)
    s = re.sub(r'(?<!\w)(?:~|±)\s*(?=\d)', 'c. ', s)
    s = re.sub(r'\b(?:ca\.|circa)\s*(?=\d)', 'c. ', s, flags=re.I)
    s = re.sub(r'(?<!\w)<\s*(?=\d)', 'Before ', s)
    s = re.sub(r'(?<!\w)>\s*(?=\d)', 'After ', s)
    s = re.sub(r'(?<=\d)\s*[-–]\s*(?=\d)', '–', s)
    s = re.sub(r'\bas below\b|\bsee below\b', '', s, flags=re.I)
    return clean(s)


def extract_dates(raw: str) -> tuple[str, str, int | None, str, bool]:
    if not clean(raw):
        return 'Date not established', '', None, 'unknown', False
    text = clean(raw)
    text = re.sub(r'^extracts from\s+', '', text, flags=re.I)
    joined = re.match(r'^(?:texts?\s*&\s*\??\s*manuscripts?|text\s*&\s*print(?:ed)?\s+(?:edition|source))\s*:\s*(.*)', text, re.I)
    main = (joined.group(1).split(';', 1)[0] if joined else ROLE.split(text, maxsplit=1)[0]).strip(' ;,')
    main = re.sub(r'^(?:text(?:s)?\s*(?:&|and)\s*\??\s*manuscripts?|texts?|documents?|manuscripts?)\s*:\s*', '', main, flags=re.I)
    # Records may append a manuscript note without punctuation.
    main = re.split(r'\bmanuscripts?\s*:', main, flags=re.I)[0].strip(' ;,')
    witness = re.search(r'\b(manuscripts?|print(?:ed)?\s+(?:source|edition)|edition|lithograph)\s*:\s*(.*)', text, re.I)
    note = ''
    witness_year = None
    if witness:
        label = witness.group(1)
        val = re.split(r';\s*(?:manuscripts?|print|edition)\s*:', witness.group(2), maxsplit=1, flags=re.I)[0]
        val = show_date(val)
        label = 'Manuscript' if label.lower().startswith(('m', 'ms')) else ('Print' if 'print' in label.lower() else label.capitalize())
        note = f'{label}: {val}' if val else ''
        years = [int(m.group(1)) for m in YEAR.finditer(val)]
        witness_year = min(years) if years else None
        if len(note) > 100:
            note = 'See source metadata'
    numbers = [int(m.group(1)) for m in YEAR.finditer(main)]
    # Century expressions, when not accompanied by a calendar year.
    if not numbers:
        century = re.search(r'\b(1[3-9]|20)(?:st|nd|rd|th)[- ]century\b', main, re.I)
        if century:
            numbers = [(int(century.group(1))-1)*100]
    label = show_date(main)
    if not label or UNKNOWN.match(label):
        label = 'Date not established'
    if label.lower() in {'?', 'not known'}:
        label = 'Date not established'
    if label and label[0].islower():
        label = label[0].upper() + label[1:]
    year = numbers[0] if numbers else witness_year
    quality = 'document'
    if numbers:
        if re.search(r'(?i)\b(?:before|after|predat|<|>)', main):
            quality = 'bound'
        elif re.search(r'(?i)\b(?:perhaps|probably|possibly|about|circa|c\.|~|±|\?|estimated|between|late|early|mid)', main) or re.search(r'\d{3}0s\b', main):
            quality = 'estimated'
        if not main or UNKNOWN.match(main):
            year = witness_year
            quality = 'witness' if witness_year is not None else 'unknown'
    elif year is not None:
        quality = 'witness'
    else:
        quality = 'unknown'
    if label == 'Date not established' and witness_year is not None:
        note = note or f'Manuscript: {witness_year}'
    return label, note, year, quality, bool(numbers and quality in {'document', 'estimated'})


def extract_origin(raw: str) -> tuple[str, str]:
    text = clean(raw)
    if not text:
        return 'Not established', ''
    # Source roles are distinct: original composition versus manuscript copying.
    fragments = re.split(r';\s*(?=(?:text(?:s)?|manuscripts?|prints?|published|printed)\s*:)', text, flags=re.I)
    main = re.sub(r'^(?:text(?:s)?|text\s*&\s*manuscripts?|texts\s*&\s*manuscripts?|manuscripts?|printed?\s+source)\s*:\s*', '', fragments[0], flags=re.I)
    main = re.sub(r'^(?:published|printed|collected)\s+in\s+', '', main, flags=re.I)
    main = re.split(r'\s+>\s+|\s+→\s+', main)[0]
    main = re.split(r',\s*(?:written|copied|composed|collected|authored|including|formerly|held|prepared|in the possession)\b', main, flags=re.I)[0]
    main = clean(main)
    proposed = re.match(r'^\?\s+(.+)$', main)
    if proposed:
        main = 'Possibly ' + proposed.group(1)
    elif re.match(r'^(?:unknown|not known|\?|\[as indicated)', main, flags=re.I):
        main = 'Not established'
    if main.lower().startswith('probably '):
        main = 'Probably ' + main[9:]
    main = re.sub(r'\bMekkah\b|\bMekah\b', 'Mecca', main, flags=re.I)
    main = re.sub(r'\bBatavia\b(?!\s*\()', 'Batavia (Jakarta)', main, flags=re.I)
    note = ''
    for fragment in fragments[1:]:
        if re.match(r'^manuscripts?\s*:', fragment, flags=re.I):
            val = re.sub(r'^manuscripts?\s*:\s*', '', fragment, flags=re.I)
            val = re.split(r'\s+>\s+|\s+→\s+|,\s*(?:copied|collected|formerly)', val, flags=re.I)[0]
            val = clean(val)
            if val and len(val) < 55 and val.casefold() != main.casefold() and not re.match(r'^(unknown|not known|\?)',val,re.I):
                note = f'Manuscript: {val}'
            break
    if len(main)>100:
        main = clean(main[:100].rsplit(' ',1)[0])+'…'
    return main or 'Not established', note


def genre_of(d: dict) -> str:
    code = d['code']
    for category, values in GENRES.items():
        if code in values:
            return category
    t = d['title'].casefold()
    if t.startswith(('syair', 'puisi')):
        return 'Poetry'
    if t.startswith(('surat ', 'warkah ', 'perjanjian ')) and code!='Anb':
        return 'Correspondence'
    if t.startswith(('hikayat', 'cerita', 'ceretera', 'carita')):
        return 'Narrative prose'
    return 'Other'


def normalize_document(d: dict) -> dict:
    code = d['code']
    annot = NOTES.get(code, {})
    extra = EXCEPTIONS.get(code, {})
    date, date_note, year, quality, periodable = extract_dates(d.get('dates', ''))
    origin, origin_note = extract_origin(d.get('provenance', ''))
    if annot.get('dates'):
        date, date_note = (annot['dates']+[''])[:2]
    if annot.get('origin'):
        origin, origin_note = (annot['origin']+[''])[:2]
    year = extra.get('year', year)
    date = extra.get('date', date)
    date_note = extra.get('date_note', date_note)
    origin = extra.get('origin', origin)
    origin_note = extra.get('origin_note', origin_note)
    quality = extra.get('quality', quality)
    periodable = extra.get('periodable', periodable)
    if quality in {'bound', 'witness', 'unknown', 'disputed'}:
        periodable = False
    if quality == 'collection':
        years = [int(m.group(1)) for m in YEAR.finditer(re.split(r';\s*(?:manuscripts?|mss?)\s*:', d.get('dates',''), maxsplit=1, flags=re.I)[0])]
        periodable = bool(years and len(years)>1 and min(years)//100 == max(years)//100)
    # Grouped corpora spanning several decades must not be assigned entirely
    # to their earliest year in temporal frequency calculations.
    source_years = [int(m.group(1)) for m in YEAR.finditer(re.split(r'\bmanuscripts?\s*:', d.get('dates',''), flags=re.I)[0])]
    if len(source_years)>1 and min(source_years)//100 != max(source_years)//100 and re.search(r'(?i)\b(?:as below|extracts|letters|various items|from)\b', d.get('dates','')):
        periodable = False
        if quality=='document': quality='collection'
    result = dict(d)
    result.update({
        'display_title': annot.get('title') or clean(d['title']),
        'description': annot.get('description',''),
        'display_date': date,
        'date_note': date_note,
        'chronology_year': year,
        'date_quality': quality,
        'period_eligible': bool(periodable and year is not None),
        'display_origin': origin,
        'origin_note': origin_note,
        'genre': genre_of(d),
        'source_dates': d.get('dates',''),
        'source_provenance': d.get('provenance',''),
        # Preserve the existing field for compatibility with earlier URLs.
        'year_min': year,
    })
    return result


def enrich_manifest(out: Path) -> list[dict]:
    path = out/'data'/'manifest.json'
    manifest = json.loads(path.read_text(encoding='utf-8'))
    documents = [normalize_document(d) for d in manifest['documents']]
    missing = [d['code'] for d in documents if not d['description']]
    if missing:
        raise ValueError(f'Missing catalogue descriptions: {missing}')
    manifest['documents'] = documents
    manifest['normalization_version'] = 2
    manifest['period_eligible_document_count'] = sum(d['period_eligible'] for d in documents)
    path.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    columns = ['code','display_title','description','chronology_year','date_quality','period_eligible','display_date','date_note','display_origin','origin_note','genre','indexed_tokens','source_dates','source_provenance']
    with (out/'data'/'catalogue.csv').open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(documents)
    # Reader JSON holds the archival record unmodified; catalogue reads manifest.
    return documents


if __name__ == '__main__':
    docs = enrich_manifest(ROOT/'public')
    print(f'Normalized {len(docs)} corpus records')
