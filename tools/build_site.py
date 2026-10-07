#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import unicodedata
from array import array
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXTS = ROOT / "texts"
SITE = ROOT / "site"
OUT = ROOT / "public"
BUCKETS = 64
CONNECTORS = {"'", "’", "`", "´", "-"}


def dump_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def normalize_token(token: str) -> str:
    token = unicodedata.normalize("NFKC", token).casefold()
    return token.replace("’", "'").replace("´", "'")


def fold_token(token: str) -> str:
    token = normalize_token(token)
    token = "".join(ch for ch in unicodedata.normalize("NFKD", token) if unicodedata.category(ch) != "Mn")
    return "".join(ch for ch in token if ch.isalnum())


def is_word_char(ch: str) -> bool:
    return unicodedata.category(ch)[:1] in {"L", "M", "N"}


def tokenize(text: str):
    i, n, ordinal = 0, len(text), 0
    while i < n:
        if not is_word_char(text[i]):
            i += 1
            continue
        start = i
        i += 1
        while i < n:
            ch = text[i]
            if is_word_char(ch):
                i += 1
                continue
            if ch in CONNECTORS and i + 1 < n and is_word_char(text[i + 1]):
                i += 1
                continue
            break
        raw = text[start:i]
        term = normalize_token(raw)
        if term:
            yield term, ordinal, start
            ordinal += 1


def fnv1a(text: str) -> int:
    h = 2166136261
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def bucket_for(term: str) -> str:
    return f"{fnv1a(term) % BUCKETS:02x}"


def field(meta: str, label: str) -> str:
    m = re.search(rf"^{re.escape(label)}:\s*(.*)$", meta, re.MULTILINE)
    return m.group(1).strip() if m else ""


def infer_genre(title: str) -> str:
    t = title.casefold()
    rules = [
        ("Syair", ("syair", "shair")),
        ("Hikayat", ("hikayat", "cerita", "ceretera", "carita")),
        ("Letters", ("warkah", "surat", "letters")),
        ("Law / treaty", ("undang", "perjanjian", "piagam", "proclamation", "takzir")),
        ("Periodical", ("majalah", "warta", "newspaper", "editorial", "saudara", "al-imam")),
        ("Religious", ("aqā", "tawhid", "tafsir", "qasidah", "sufi", "kitab suci", "burdah", "nasaf", "sharāb", "hujjat")),
        ("Chronicle / history", ("sejarah", "silsilah", "salasilah", "tambo", "tawarikh", "kerajaan", "raja ")),
    ]
    for name, words in rules:
        if any(w in t for w in words):
            return name
    return "Other"


def parse_file(path: Path):
    raw = path.read_text(encoding="utf-8", errors="replace")
    start = raw.find("[MCP TEXT METADATA]")
    end = raw.find("[END MCP TEXT METADATA]")
    if start >= 0 and end >= 0:
        meta = raw[start + len("[MCP TEXT METADATA]"):end].strip()
        body = raw[end + len("[END MCP TEXT METADATA]"):].lstrip("\r\n")
    else:
        meta, body = "", raw
    code = field(meta, "MCP code") or path.stem
    title = field(meta, "Title") or code
    dates = field(meta, "Dates") or field(meta, "Date")
    years = [int(x) for x in re.findall(r"(?<!\d)(1[0-9]{3}|20[0-9]{2})(?!\d)", dates)]
    words_raw = field(meta, "MCP word count")
    wm = re.search(r"([0-9][0-9,]*)", words_raw)
    declared_words = int(wm.group(1).replace(",", "")) if wm else None
    info = {
        "code": code,
        "title": title,
        "edition": field(meta, "Edition"),
        "manuscript": field(meta, "Manuscript"),
        "dates": dates,
        "provenance": field(meta, "Provenance"),
        "word_count": declared_words,
        "word_count_raw": words_raw,
        "reference_scheme": field(meta, "MCP reference scheme"),
        "genre": infer_genre(title),
        "year_min": min(years) if years else None,
        "year_max": max(years) if years else None,
        "metadata_raw": meta,
        "source_file": path.name,
    }
    return info, body


def delta_pairs(values: array) -> list[int]:
    out = []
    pt = pc = 0
    for i in range(0, len(values), 2):
        t, c = int(values[i]), int(values[i + 1])
        out.extend((t - pt, c - pc))
        pt, pc = t, c
    return out


def main() -> None:
    if not TEXTS.exists():
        raise SystemExit("texts/ directory not found")
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE, OUT)
    (OUT / ".nojekyll").write_text("", encoding="utf-8")

    files = sorted(TEXTS.glob("*.txt"), key=lambda p: p.name.casefold())
    docs = []
    postings = defaultdict(lambda: defaultdict(lambda: array("I")))
    lexicon = Counter()
    total_tokens = 0

    for doc_id, path in enumerate(files):
        info, body = parse_file(path)
        file_id = f"{doc_id:03d}"
        info["id"] = doc_id
        info["file_id"] = file_id
        vocab = Counter()
        token_count = 0
        # JavaScript positions are UTF-16 code units, not Python code points.
        # Convert offsets while scanning once so reader links remain exact even
        # when a transcription contains characters outside the BMP.
        scanned = 0
        astral_before = 0
        for term, pos, char in tokenize(body):
            while scanned < char:
                if ord(body[scanned]) > 0xFFFF:
                    astral_before += 1
                scanned += 1
            js_char = char + astral_before
            arr = postings[term][doc_id]
            arr.append(pos)
            arr.append(js_char)
            vocab[term] += 1
            lexicon[term] += 1
            token_count += 1
        total_tokens += token_count
        info["indexed_tokens"] = token_count
        docs.append(info)
        dump_json(OUT / "data" / "texts" / f"{file_id}.json", {"meta": info, "body": body})
        dump_json(OUT / "data" / "vocab" / f"{file_id}.json", sorted(vocab.items()))
        print(f"[{doc_id + 1:3d}/{len(files)}] {info['code']}: {token_count:,} tokens")

    by_bucket = defaultdict(list)
    for term in postings:
        by_bucket[bucket_for(term)].append(term)

    for b in [f"{i:02x}" for i in range(BUCKETS)]:
        packed = {}
        for term in sorted(by_bucket.get(b, [])):
            packed[term] = [[doc_id, delta_pairs(vals)] for doc_id, vals in sorted(postings[term].items())]
        dump_json(OUT / "data" / "postings" / f"{b}.json", packed)
        print(f"wrote postings/{b}.json ({len(packed):,} terms)")

    manifest = {
        "version": 1,
        "documents": docs,
        "document_count": len(docs),
        "indexed_tokens": total_tokens,
        "declared_words": sum(d.get("word_count") or 0 for d in docs),
        "bucket_count": BUCKETS,
    }
    dump_json(OUT / "data" / "manifest.json", manifest)
    dump_json(OUT / "data" / "lexicon.json", [[term, count] for term, count in sorted(lexicon.items())])
    print(f"Built {len(docs)} documents, {total_tokens:,} indexed tokens, {len(lexicon):,} unique forms")


if __name__ == "__main__":
    main()
