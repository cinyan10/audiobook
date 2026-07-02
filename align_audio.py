from __future__ import annotations

import argparse

from app.alignment import generate_part_alignment
from app.db import get_connection


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate word alignment JSON for existing part audio.")
    parser.add_argument("book_id", type=int)
    parser.add_argument("--chapter-index", type=int, required=True)
    parser.add_argument("--part-index", type=int, action="append", required=True)
    parser.add_argument("--model", default="small.en")
    args = parser.parse_args()

    with get_connection() as connection:
        for part_index in args.part_index:
            payload = generate_part_alignment(
                connection,
                args.book_id,
                args.chapter_index,
                part_index,
                model_name=args.model,
            )
            print(
                f"aligned book {args.book_id} chapter {args.chapter_index} part {part_index}: "
                f"{len(payload['tokens'])} tokens"
            )


if __name__ == "__main__":
    main()
