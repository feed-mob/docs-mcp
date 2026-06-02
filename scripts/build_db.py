#!/usr/bin/env python3
"""Build docs.sqlite from scraped/*.md with FTS5 index."""
import sqlite3
import os
import glob
import re
from pathlib import Path

DB_DIR = Path("data/db")
DB_PATH = DB_DIR / "docs.sqlite"
SCRAPED_DIR = Path("scraped")

def init_db():
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
            title,
            content,
            content_rowid='id',
            content='docs'
        )
    """)
    conn.commit()
    return conn

def extract_title(content):
    match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    return match.group(1).strip() if match else "Untitled"

def build():
    conn = init_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM docs")
    cursor.execute("DELETE FROM docs_fts")

    md_files = sorted(glob.glob(str(SCRAPED_DIR / "*.md")))
    if not md_files:
        print(f"Warning: no .md files found in {SCRAPED_DIR}")

    for filepath in md_files:
        path = Path(filepath).relative_to(SCRAPED_DIR).as_posix()
        raw = Path(filepath).read_text(encoding='utf-8')
        title = extract_title(raw)
        cursor.execute(
            "INSERT INTO docs (path, title, content) VALUES (?, ?, ?)",
            (path, title, raw)
        )

    cursor.execute("INSERT INTO docs_fts(rowid, title, content) SELECT id, title, content FROM docs")
    conn.commit()
    conn.close()
    print(f"Built {DB_PATH} with {len(md_files)} documents")

if __name__ == "__main__":
    build()
