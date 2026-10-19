#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собрать справочник отделений Казпочты в компактную таблицу «индекс → отделение».

Зачем: менеджер заказов вписывает индекс получателя, и ему нужно СРАЗУ видеть, что это за
пункт — область, город, улица, выдают ли там посылки. Спрашивать Казпочту на каждую
набранную цифру нельзя: их SOAP отвечает секундами и ПО ИНДЕКСУ НЕ ИЩЕТ ВООБЩЕ
(`SearchCity2` принимает только название отделения, проверено 19.10.2026 — на `080007`
отвечает «no data»). Поэтому таблица собирается здесь, один раз, и кладётся в
`assets/kazpost-index.json`, откуда CRM читает её мгновенно и без сети.

Как добывается. Поиск у них — подстрока по названию отделения, и общая буква выдаёт почти
весь справочник разом: на «а» приходит 2667 записей. Поэтому гоняем несколько частых букв и
склеиваем по `DepId`.

Что в таблице: область, район, тип населённого пункта («г.», «с.»), сам населённый пункт,
улица с домом и признак «выдают ли тут посылки». Координаты и тип отделения не храним:
подсказку с картой и типом убрали 19.10.2026 по просьбе владельца — в карточке из этого
собирается строка адреса, а не справка.

Запуск:  python3 tools/kazpost-offices.py
Потом:   python3 tools/refresh-versions.py   (у файлов в assets/ тоже есть метка версии)
"""
import json, re, sys, urllib.request
from pathlib import Path

EP = "http://rates.kazpost.kz:80/postratesprod/endpoints"
NS = "http://webservices.kazpost.kz/postratesws"
# Буквы подобраны так, чтобы перекрыть названия и по-русски, и по-казахски. Каждая отдаёт
# пару тысяч записей, пересечение огромное — склеиваем по DepId, лишнего не будет.
LETTERS = ["а", "е", "и", "о", "у", "ы", "я", "л", "н", "р", "ы", "қ", "ә", "ө"]

def ask(dep):
    body = (f'<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
            f'xmlns:sch="{NS}"><soapenv:Body><sch:SearchCity2Request>'
            f'<sch:depname>{dep}</sch:depname>'
            f'</sch:SearchCity2Request></soapenv:Body></soapenv:Envelope>').encode()
    req = urllib.request.Request(EP, data=body, headers={
        "Content-Type": "text/xml;charset=UTF-8", "SOAPAction": '""'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8", "replace")

FIELDS = ("DepId", "States", "Area", "City", "Street", "House", "GeoMaps",
          "DepName", "Status", "PstIndex", "TypePo", "Vydacha")

def parse(xml):
    out = []
    for block in re.findall(r"<ns2:depList2>(.*?)</ns2:depList2>", xml, re.S):
        rec = {}
        for f in FIELDS:
            m = re.search(rf"<ns2:{f}>(.*?)</ns2:{f}>", block, re.S)
            rec[f] = (m.group(1).strip() if m else "")
        out.append(rec)
    return out

def clean(v):
    # «улица Толе би» → «Толе би»: слово «улица» в адресе только занимает место.
    v = re.sub(r"^(улица|проспект|микрорайон|переулок)\s+", "", v, flags=re.I)
    return re.sub(r"\s+", " ", v).strip()

# Тип населённого пункта храним ОТДЕЛЬНО и сокращённым: в адресе должно стоять
# «г. Жанаозен», «с. Шортанды» — так его пишут на конверте (просьба владельца 19.10.2026).
CITY_TYPE = [
    (r"^город\s+",            "г."),
    (r"^(посёлок|поселок)\s+", "п."),
    (r"^село\s+",             "с."),
    (r"^станция\s+",          "ст."),
    (r"^(аул|ауыл)\s+",        "а."),
    (r"^(разъезд)\s+",        "рзд."),
]
def split_city(v):
    v = re.sub(r"\s+", " ", (v or "")).strip()
    for rx, short in CITY_TYPE:
        if re.match(rx, v, flags=re.I):
            return short, re.sub(rx, "", v, flags=re.I).strip()
    return "", v

def main():
    seen = {}
    for i, L in enumerate(LETTERS, 1):
        try:
            recs = parse(ask(L))
        except Exception as e:
            print(f"  «{L}»: не ответил — {e}", file=sys.stderr); continue
        new = 0
        for r in recs:
            if r["DepId"] and r["DepId"] not in seen:
                seen[r["DepId"]] = r; new += 1
        print(f"  «{L}»: {len(recs)} записей, новых {new}, всего {len(seen)}")

    # Один индекс — несколько отделений (отделение, банкомат, автомат выдачи). Для подсказки
    # выбираем ЛУЧШЕЕ: действующее, с выдачей, и не банкомат — именно туда придёт посылка.
    def score(r):
        s = 0
        if r["Status"].lower().startswith("действ"): s += 4
        if r["Vydacha"].lower().startswith("да"): s += 2
        if "банкомат" not in r["TypePo"].lower(): s += 1
        return s

    by_index = {}
    skipped = 0
    for r in seen.values():
        idx = re.sub(r"\D", "", r["PstIndex"])
        if len(idx) != 6: continue
        # В реестре есть мусорная запись: индекс 123456, адрес главпочтамта Алматы и ПУСТАЯ
        # область. На пробный индекс CRM показывала бы «г. Алматы» как ни в чём не бывало,
        # поэтому записи без области выбрасываем — у настоящих отделений она заполнена всегда
        # (проверено: такая запись ровно одна на 3676).
        if not r["States"].strip():
            skipped += 1; continue
        cur = by_index.get(idx)
        if cur is None or score(r) > score(cur["_src"]):
            ct, city = split_city(r["City"])
            by_index[idx] = {
                "_src": r,
                "o": clean(r["States"]),                       # область
                "r": clean(r["Area"]),                         # район
                "ct": ct,                                      # «г.», «с.», «п.» — перед городом
                "c": city,                                     # населённый пункт без типа
                "a": " ".join(x for x in (clean(r["Street"]), clean(r["House"])) if x),
                "v": 1 if r["Vydacha"].lower().startswith("да") else 0,
            }
    for v in by_index.values(): v.pop("_src", None)

    out = Path("assets/kazpost-index.json")
    out.write_text(json.dumps({"n": len(by_index), "i": by_index}, ensure_ascii=False,
                              separators=(",", ":")), encoding="utf-8")
    print(f"\n{out}: индексов {len(by_index)}, {out.stat().st_size//1024} КБ"
          + (f" · выброшено записей без области: {skipped}" if skipped else ""))

main()
