#!/usr/bin/env python3
"""Справка по ШПИ у Казпочты — БЕЗ траты номеров и без ключа.

У сервиса есть два метода только на чтение, оба не требуют ключа и ничего не
расходуют из диапазона договора:

  GetBarCodeFromOrderNum(ordernum) — какой ШПИ выдан по нашему номеру заказа
  GetBarcodeInfo(Barcode)          — что записано по самому ШПИ

Запрашиваем ОБА контура сразу: `postratesprod` (выдаёт AP) и `postratesws`
(в сентябре выдал единственный QS). Смысл именно в сравнении — у контуров
разные базы, и номер, выданный одним, другой может не знать вовсе.

    python3 tools/kazpost-lookup.py 2514200 AP081985585KZ

Номер из 13 знаков с буквами считается ШПИ, остальное — номером заказа.
"""
import re, sys, urllib.request

CONTOURS = ("postratesprod", "postratesws")
NS = 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sch="http://webservices.kazpost.kz/postratesws"'


def call(contour, body):
    env = f'<?xml version="1.0" encoding="UTF-8"?><soap:Envelope {NS}><soap:Body>{body}</soap:Body></soap:Envelope>'
    req = urllib.request.Request(
        f"http://rates.kazpost.kz:80/{contour}/endpoints",
        data=env.encode(),
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""},
    )
    try:
        return urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "replace")
    except Exception as e:                      # сеть, таймаут, 500 — показываем как есть
        return f"ОШИБКА ЗАПРОСА: {e}"


def show(xml):
    if xml.startswith("ОШИБКА"):
        print("   ", xml)
        return
    xml = re.sub(r"<ns2:ResponseGenTime>.*?</ns2:ResponseGenTime>", "", xml)
    fields = re.findall(r"<ns2:(\w+)>([^<]*)</ns2:\1>", xml)
    if not fields:
        print("    (пустой ответ)", xml[:200])
        return
    for k, v in fields:
        if k == "AddrLetPdf":
            v = f"<pdf, {len(v)} символов base64>"
        print(f"    {k:<18} {v[:100]}")


def main(args):
    if not args:
        print(__doc__)
        return 1
    for value in args:
        is_barcode = bool(re.fullmatch(r"[A-Za-z]{2}\d{9}[A-Za-z]{2}", value))
        body = (f"<sch:GetBarcodeInfoRequest><sch:Barcode>{value}</sch:Barcode></sch:GetBarcodeInfoRequest>"
                if is_barcode else
                f"<sch:GetBarCodeFromOrderNumRequest><sch:ordernum>{value}</sch:ordernum></sch:GetBarCodeFromOrderNumRequest>")
        what = "ШПИ" if is_barcode else "номер заказа"
        for contour in CONTOURS:
            print(f"=== {contour} · {what} {value}")
            show(call(contour, body))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
