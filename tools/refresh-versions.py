#!/usr/bin/env python3
"""
Обновляет метки версий у файлов js/ и css/ в index.html.

Зачем: подключения выглядят так — <script src="js/11-zakazy.js?v=d953c90e">.
Кусок ?v=... это короткий отпечаток содержимого файла. Пока он не меняется,
браузер имеет право отдавать пользователю старую версию файла из кеша.

ЗАПУСКАТЬ ПОСЛЕ ЛЮБОЙ ПРАВКИ в js/ или css/, перед коммитом:

    python3 tools/refresh-versions.py

Скрипт ничего не ломает: он только пересчитывает отпечатки и, если они
изменились, правит index.html. Если менять нечего — так и напишет.
"""
import hashlib
import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def fingerprint(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:8]


def main() -> int:
    if not INDEX.exists():
        print(f"не найден {INDEX}", file=sys.stderr)
        return 1

    src = io.open(INDEX, encoding="utf-8", newline="").read()
    changed, missing = [], []

    def replace(m: re.Match) -> str:
        rel, old = m.group(1), m.group(2)
        target = ROOT / rel
        if not target.exists():
            missing.append(rel)
            return m.group(0)
        new = fingerprint(target)
        if new != old:
            changed.append(rel)
            return m.group(0).replace(f"?v={old}", f"?v={new}")
        return m.group(0)

    out = re.sub(r'(?:src|href)="((?:js|css)/[^"?]+)\?v=([0-9a-f]+)"', replace, src)

    # подключён ли каждый файл из js/ и css/
    linked = set(re.findall(r'(?:src|href)="((?:js|css)/[^"?]+)\?v=[0-9a-f]+"', src))
    on_disk = {
        str(p.relative_to(ROOT))
        for p in list((ROOT / "js").glob("*.js")) + list((ROOT / "css").glob("*.css"))
    }
    forgotten = sorted(on_disk - linked)

    if changed:
        io.open(INDEX, "w", encoding="utf-8", newline="").write(out)
        print("обновлены версии:")
        for rel in changed:
            print(f"  {rel}")
    else:
        print("версии актуальны, менять нечего")

    problems = 0
    if missing:
        print("\nПОДКЛЮЧЕНЫ, НО ОТСУТСТВУЮТ НА ДИСКЕ:", file=sys.stderr)
        for rel in missing:
            print(f"  {rel}", file=sys.stderr)
        problems += 1
    if forgotten:
        print("\nЛЕЖАТ НА ДИСКЕ, НО НЕ ПОДКЛЮЧЕНЫ В index.html:", file=sys.stderr)
        for rel in forgotten:
            print(f"  {rel}", file=sys.stderr)
        print("Добавьте <script src=\"...\"> в нужное место по порядку.", file=sys.stderr)
        problems += 1

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
