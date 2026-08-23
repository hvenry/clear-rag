#!/usr/bin/env python
"""Ingest a song-lyrics dataset as one document per song, for theme-search experiments.

Usage:
    python scripts/ingest_lyrics.py --limit 500                # balanced across artists
    python scripts/ingest_lyrics.py --artists ColdPlay,Khalid  # only these
    python scripts/ingest_lyrics.py --dry-run                  # count, don't post

Reads the Kaggle dataset `deepshah16/song-lyrics-dataset` (downloaded on demand via
kagglehub into its own cache) and posts each song to a running clear-rag server as
`Artist — Title.md`. Nothing is written into the repository: lyrics are copyrighted,
so the dataset lives in the kagglehub cache and the indexed copy in the gitignored
workspace, for personal local experimentation only. Do not publish the indexed corpus.

Why this corpus is interesting for a RAG project: a theme query ("a sad ride home
alone at night") shares almost no vocabulary with the lyrics that match it. Keyword
search goes nearly blind, and retrieval quality becomes almost purely a property of
the embedding space -- the opposite regime from a technical corpus full of exact
identifiers. Compare retrieval modes in the Lab on this corpus and the difference is
stark in a way no documentation corpus shows.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import httpx

#: Variant recordings add near-duplicate lyrics that clutter every ranking.
_VARIANT = re.compile(
    r"\b(live|remix|demo|acoustic|instrumental|edit|version|mix|tour|remaster(ed)?|"
    r"radio|karaoke|extended|reprise|a cappella|acapella|vip|sped.?up)\b",
    re.IGNORECASE,
)
_MIN_LYRIC_CHARS = 200


def load_songs(base: Path, artists: set[str] | None) -> dict[str, list[dict]]:
    """Songs per artist, variants and near-empty lyrics dropped, deduped by title."""
    by_artist: dict[str, list[dict]] = {}
    for path in sorted(base.rglob("*.csv")):
        if artists and path.stem.lower() not in artists:
            continue
        seen: set[str] = set()
        songs: list[dict] = []
        with path.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                title = (row.get("Title") or "").strip()
                lyric = (row.get("Lyric") or "").strip()
                key = re.sub(r"[^a-z0-9]", "", title.lower())
                if (
                    not title
                    or len(lyric) < _MIN_LYRIC_CHARS
                    or _VARIANT.search(title)
                    or key in seen
                ):
                    continue
                seen.add(key)
                songs.append(
                    {
                        "artist": (row.get("Artist") or path.stem).strip(),
                        "title": title,
                        "album": (row.get("Album") or "").strip(),
                        "year": (row.get("Year") or "").strip().removesuffix(".0"),
                        "lyric": lyric,
                    }
                )
        if songs:
            by_artist[path.stem] = songs
    return by_artist


def pick_balanced(by_artist: dict[str, list[dict]], limit: int) -> list[dict]:
    """Round-robin across artists so one prolific catalogue can't crowd out the rest."""
    picked: list[dict] = []
    queues = {artist: list(songs) for artist, songs in sorted(by_artist.items())}
    while queues and len(picked) < limit:
        for artist in sorted(queues):
            if len(picked) >= limit:
                break
            queue = queues[artist]
            picked.append(queue.pop(0))
            if not queue:
                del queues[artist]
    return picked


def to_document(song: dict) -> tuple[str, str]:
    """(filename, markdown body). The metadata header keeps artist and era retrievable."""
    safe = re.sub(r'[/\\:*?"<>|]', "-", f"{song['artist']} — {song['title']}")
    header = " · ".join(x for x in (song["artist"], song["album"], song["year"]) if x)
    body = f"# {song['title']}\n\n{header}\n\n{song['lyric']}\n"
    return f"{safe}.md", body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--path", type=Path, default=None, help="Dataset dir (else kagglehub).")
    parser.add_argument("--url", default="http://127.0.0.1:8100", help="clear-rag server.")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--artists", default=None, help="Comma-separated csv stems to include.")
    parser.add_argument("--batch", type=int, default=20, help="Songs per upload request.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    base = args.path
    if base is None:
        import kagglehub

        base = Path(kagglehub.dataset_download("deepshah16/song-lyrics-dataset"))

    artists = {a.strip().lower() for a in args.artists.split(",")} if args.artists else None
    by_artist = load_songs(base, artists)
    songs = pick_balanced(by_artist, args.limit)
    print(
        f"{sum(len(s) for s in by_artist.values())} usable songs from {len(by_artist)} artists; "
        f"ingesting {len(songs)}"
    )
    if args.dry_run:
        return 0

    indexed = unchanged = failed = 0
    with httpx.Client(timeout=600.0) as client:
        for start in range(0, len(songs), args.batch):
            batch = songs[start : start + args.batch]
            files = [
                ("files", (name, body.encode(), "text/markdown"))
                for name, body in (to_document(song) for song in batch)
            ]
            try:
                response = client.post(f"{args.url}/api/documents", files=files)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                print(f"  batch at {start} failed: {exc}", file=sys.stderr)
                failed += len(batch)
                continue
            for result in response.json()["results"]:
                status = result.get("status")
                indexed += status == "indexed"
                unchanged += status == "unchanged"
                failed += status not in ("indexed", "unchanged")
            done = min(start + args.batch, len(songs))
            print(f"  {done}/{len(songs)}  (+{indexed} indexed, {unchanged} unchanged)")

    print(f"done: {indexed} indexed, {unchanged} unchanged, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
