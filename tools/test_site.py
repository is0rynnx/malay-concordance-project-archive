#!/usr/bin/env python3
"""Build-time integrity checks for the Malay Concordance static index."""
from __future__ import annotations
import json
from pathlib import Path
from build_site import ROOT, bucket_for, normalize_token, tokenize


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def check() -> None:
    out = ROOT / "public"
    manifest = read_json(out / "data" / "manifest.json")
    sources = sorted((ROOT / "texts").glob("*.txt"))
    docs = manifest["documents"]
    assert len(docs) == len(sources), "Manifest and source-file count differ"
    assert len(docs) >= 2, "Source corpus is empty"
    assert len({d["code"] for d in docs}) == len(docs), "Duplicate MCP codes"
    assert manifest["document_count"] == len(docs)
    assert manifest["indexed_tokens"] == sum(d["indexed_tokens"] for d in docs)
    assert len(list((out / "data" / "postings").glob("*.json"))) == 64
    assert (out / "index.html").exists() and (out / "app.js").exists()

    shard_cache = {}
    candidates = [0, len(docs)//2, len(docs)-1]
    checked = 0
    for i in candidates:
        d = docs[i]
        body = read_json(out / "data" / "texts" / f"{d['file_id']}.json")["body"]
        vocab = read_json(out / "data" / "vocab" / f"{d['file_id']}.json")
        assert isinstance(body, str) and len(body)>0
        assert vocab, f"Missing vocabulary for {d['code']}"
        samples = list(tokenize(body))[:12]
        assert samples, f"Missing tokens in {d['code']}"
        for term, token, char in samples:
            js_char = len(body[:char].encode('utf-16-le')) // 2
            assert normalize_token(body[char:char+max(100,len(term)*4)]).startswith(term), f"Offset mismatch in {d['code']}"
            shard = bucket_for(term)
            if shard not in shard_cache:
                shard_cache[shard] = read_json(out / "data" / "postings" / f"{shard}.json")
            rows = shard_cache[shard][term]
            row = next((r for r in rows if r[0] == i), None)
            assert row is not None, f"Missing posting for {d['code']} {term}"
            pos = ch = 0
            found = False
            for j in range(0, len(row[1]), 2):
                pos += row[1][j]
                ch += row[1][j+1]
                if pos == token and ch == js_char:
                    found = True
                    break
            assert found, f"Wrong posting offset in {d['code']} {term}"
            checked += 1
    print(f"Index checks passed: {len(docs)} texts, {manifest['indexed_tokens']:,} tokens, {checked} source offsets checked")


if __name__ == "__main__":
    check()
