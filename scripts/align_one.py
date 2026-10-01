"""Force-align one take against its canonical transcript.

Thin wrapper around src.alignment (equivalent to `python -m src.alignment`).

    python scripts/align_one.py                         # speech_01/good_01
    python scripts/align_one.py --speech speech_02 --take good_03
    python scripts/align_one.py --all --quiet
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.alignment import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
