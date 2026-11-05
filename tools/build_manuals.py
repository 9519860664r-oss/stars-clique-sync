"""Build the English and Russian manuals with ReportLab and Windows Segoe UI."""

import math
import os
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "lite" / "build" / "icon.png"
AUTHOR = "Mikhail Mikhalchenko (Goth Angel)"
W, H = A4
M = 48
CONTENT = W - 2 * M
BLACK = "#050506"
INK = "#181721"
PAPER = "#F8F7FB"
WHITE = "#FFFFFF"
MUTED = "#514D60"
LINE = "#DDD8E7"
PURPLE = "#5630AD"
LIGHT_PURPLE = "#D8C3FF"

COPY = {
    "en": {
        "manual": "USER GUIDE", "subtitle": "Time lyrics line by line. Review by ear. Export to TTML or LRC.",
        "edition": "LITE + AUTO  /  V1", "project": "A Stars Clique project",
        "developer": "Developed by", "timing": "Time lyrics by hand",
        "timing_intro": "The manual workflow is available in both editions.",
        "steps": [
            ("Load the track", "In <b>In</b>, choose an audio file. Paste one lyric phrase per line. In Auto, choose <b>Manual</b>. Select <b>Continue</b>."),
            ("Hold Space on the phrase", "Press <b>Play</b>. Hold <b>Space</b> when the highlighted phrase starts and release it when the phrase ends. The next line moves to the top of the list."),
            ("Replay and correct", "Click the waveform to seek. In Lite, selecting an untimed line starts playback at the previous timed line's end. Click outside a text field before using keyboard shortcuts."),
        ],
        "down": "PRESS SPACE", "up": "RELEASE SPACE",
        "keys": [("Esc", "Undo timing"), ("↑ / ↓", "Select a line"), ("Enter", "Replay the line")],
        "review": "Review and export", "review_intro": "Choose the starting point that matches what you already have.",
        "lite": ("Import existing timing", "In <b>In</b>, add your audio and use <b>Import LRC / TTML for edit</b>. Select <b>Continue</b> to open Edit with the imported timing."),
        "auto": ("Recognize or align", "Choose <b>English</b>, <b>Russian</b>, or <b>Auto</b> under <b>Language hint</b>. Select <b>Recognize from audio</b> or paste your own lyrics. Choose the <b>Auto</b> timing mode and select <b>Continue</b>."),
        "draft_title": "CHECK THE AUTO DRAFT BY EAR",
        "draft": "Whisper can miss, confuse, or invent words and shift timestamps. Dense mixes and effects make singing harder to recognize. The first run may download the model.",
        "edit_title": "Make the final pass", "edit": "In <b>Edit</b>, correct the text and the <b>Start</b> and <b>End</b> times in seconds. In Lite, use <b>Split</b> or <b>Reset</b> and retime with Space. In Auto, use <b>Match timing</b> to resume manual timing at the selected line. Select <b>Save</b> to open <b>Out</b>.",
        "formats": [("TTML", "Text with a start and end time per line"), ("LRC", "Text with line start times"), ("JSON", "Project data for inspection or integration")],
    },
    "ru": {
        "manual": "РУКОВОДСТВО", "subtitle": "Синхронизируйте текст с треком, проверьте на слух и экспортируйте в TTML или LRC.",
        "edition": "LITE + AUTO  /  V1", "project": "Проект Stars Clique",
        "developer": "Разработчик", "timing": "Ручная синхронизация",
        "timing_intro": "Ручная разметка доступна в обеих версиях.",
        "steps": [
            ("Загрузите трек", "На экране <b>In</b> выберите аудиофайл. Вставьте текст: одна фраза на строку. В Auto выберите <b>Manual</b>. Нажмите <b>Continue</b>."),
            ("Держите пробел на фразе", "Нажмите <b>Play</b>. Зажмите <b>Space</b> в начале выделенной фразы и отпустите в конце. Следующая строка поднимется к верху списка."),
            ("Переслушайте и поправьте", "Щёлкните по волне, чтобы перемотать трек. В Lite выбор строки без тайминга запускает трек с конца предыдущей размеченной строки. Перед использованием клавиш выйдите из поля ввода."),
        ],
        "down": "ЗАЖАТЬ ПРОБЕЛ", "up": "ОТПУСТИТЬ ПРОБЕЛ",
        "keys": [("Esc", "Отменить тайминг"), ("↑ / ↓", "Выбрать строку"), ("Enter", "Переслушать строку")],
        "review": "Правка и экспорт", "review_intro": "Начните с готовых таймингов, текста или самого трека.",
        "lite": ("Импорт таймингов", "На экране <b>In</b> добавьте аудио и выберите <b>Import LRC / TTML for edit</b>. Нажмите <b>Continue</b>, чтобы открыть Edit с импортированными таймингами."),
        "auto": ("Распознавание и разметка", "В <b>Language hint</b> выберите <b>English</b>, <b>Russian</b> или <b>Auto</b>. Нажмите <b>Recognize from audio</b> или вставьте готовый текст. Выберите режим <b>Auto</b> и нажмите <b>Continue</b>."),
        "draft_title": "ПРОВЕРЬТЕ АВТОЧЕРНОВИК НА СЛУХ",
        "draft": "Whisper может пропускать, путать или выдумывать слова и сдвигать тайминги. Плотный микс и эффекты усложняют распознавание. При первом запуске может скачаться модель.",
        "edit_title": "Проверьте результат", "edit": "В <b>Edit</b> поправьте текст и значения <b>Start</b> и <b>End</b> в секундах. В Lite используйте <b>Split</b> или <b>Reset</b> и заново разметьте строку пробелом. В Auto кнопка <b>Match timing</b> возвращает к ручной разметке с выбранной строки. Нажмите <b>Save</b>, чтобы перейти в <b>Out</b>.",
        "formats": [("TTML", "Текст с началом и концом каждой строки"), ("LRC", "Текст с временем начала каждой строки"), ("JSON", "Данные проекта для просмотра или интеграции")],
    },
}


def text(pdf, value, x, y, size, color=INK, font="Segoe"):
    pdf.setFillColor(HexColor(color))
    pdf.setFont(font, size)
    pdf.drawString(x, H - y - size, value)


def block(pdf, value, x, y, width, size=12, color=MUTED, limit=None):
    style = ParagraphStyle("body", fontName="Segoe", fontSize=size, leading=size * 1.36,
                           textColor=HexColor(color), alignment=TA_LEFT)
    para = Paragraph(value, style)
    _, height = para.wrap(width, H)
    if limit is not None and y + height > limit:
        raise ValueError(f"Text exceeds its bounds: {value}")
    para.drawOn(pdf, x, H - y - height)


def rect(pdf, x, y, width, height, color):
    pdf.setFillColor(HexColor(color))
    pdf.rect(x, H - y - height, width, height, fill=1, stroke=0)


def rule(pdf, x1, y, x2, color=LINE):
    pdf.setStrokeColor(HexColor(color))
    pdf.setLineWidth(0.7)
    pdf.line(x1, H - y, x2, H - y)


def header(pdf, copy, lang, number):
    rect(pdf, 0, 0, W, H, PAPER)
    text(pdf, "STARS CLIQUE / SYNC", M, 39, 10, INK, "Mono")
    text(pdf, copy["manual"], W - M - 103, 39, 9, PURPLE, "Segoe-Bold")
    rule(pdf, M, 65, W - M)
    rule(pdf, M, 788, W - M)
    text(pdf, "STARS CLIQUE", M, 803, 9, MUTED, "Mono")
    text(pdf, f"{lang.upper()}  /  {number:02d}", W - M - 59, 803, 9, PURPLE, "Mono")


def cover(pdf, copy, lang):
    rect(pdf, 0, 0, W, H, "#000000")
    text(pdf, "STARS CLIQUE", M, 45, 11, WHITE, "Mono")
    text(pdf, f"{copy['manual']} / {lang.upper()}", W - M - 139, 45, 11, LIGHT_PURPLE, "Segoe-Bold")
    rule(pdf, M, 73, W - M, "#352E47")
    size = 474
    pdf.drawImage(str(ICON), (W - size) / 2, H - 76 - size, size, size)
    text(pdf, copy["edition"], M, 503, 11, LIGHT_PURPLE, "Mono")
    text(pdf, "Stars Clique", M, 519, 69, WHITE, "Segoe-Bold")
    text(pdf, "Sync", M, 591, 69, WHITE, "Segoe-Bold")
    block(pdf, escape(copy["subtitle"]), M, 687, CONTENT - 90, 15, "#DBD6E6", 742)
    rule(pdf, M, 755, W - M, "#352E47")
    text(pdf, copy["project"], M, 770, 10, LIGHT_PURPLE)
    text(pdf, f"{copy['developer']} {AUTHOR}", M, 786, 10, WHITE)
    text(pdf, "t.me/starsclique", W - M - 92, 786, 10, LIGHT_PURPLE, "Mono")
    pdf.linkURL("https://t.me/starsclique", (W - M - 92, H - 803, W - M, H - 783))
    pdf.showPage()


def step(pdf, number, label, description, top, limit):
    text(pdf, f"{number:02d}", M, top + 1, 14, PURPLE, "Mono")
    text(pdf, label, M + 46, top, 18, INK, "Segoe-Bold")
    block(pdf, description, M + 46, top + 30, CONTENT - 52, limit=limit)


def waveform(pdf, copy):
    top = 365
    rect(pdf, M, top, CONTENT, 111, BLACK)
    x1, x2 = M + CONTENT * 0.27, M + CONTENT * 0.72
    rect(pdf, x1, top + 28, x2 - x1, 47, "#251940")
    for i in range(121):
        x = M + 18 + i * (CONTENT - 36) / 120
        envelope = 0.35 + 0.65 * abs(math.sin(i * 0.112))
        height = 2 + 37 * envelope * abs(math.sin(i * 1.71))
        rect(pdf, x, top + 52 - height / 2, 1.5, height,
             "#C09AFF" if x1 <= x <= x2 else "#665B7D")
    for x, key in ((x1, "down"), (x2, "up")):
        rect(pdf, x, top + 21, 1.1, 60, LIGHT_PURPLE)
        text(pdf, copy[key], x - 6, top + 86, 8, LIGHT_PURPLE, "Segoe-Bold")


def manual(pdf, copy, lang):
    header(pdf, copy, lang, 2)
    text(pdf, copy["timing"], M, 88, 33, INK, "Segoe-Bold")
    block(pdf, copy["timing_intro"], M, 143, CONTENT, limit=171)
    step(pdf, 1, *copy["steps"][0], 184, 266)
    rule(pdf, M + 46, 270, W - M)
    step(pdf, 2, *copy["steps"][1], 283, 362)
    waveform(pdf, copy)
    step(pdf, 3, *copy["steps"][2], 511, 622)
    rect(pdf, M, 654, CONTENT, 73, "#EEE9F8")
    for index, (key, meaning) in enumerate(copy["keys"]):
        x = M + 17 + index * CONTENT / 3
        text(pdf, key, x, 667, 15, PURPLE, "Segoe-Bold")
        text(pdf, meaning, x, 693, 10, INK)
    pdf.showPage()


def review(pdf, copy, lang):
    header(pdf, copy, lang, 3)
    text(pdf, copy["review"], M, 88, 33, INK, "Segoe-Bold")
    block(pdf, copy["review_intro"], M, 143, CONTENT, limit=171)
    gap = 18
    width = (CONTENT - gap) / 2
    for index, key in enumerate(("lite", "auto")):
        x = M + index * (width + gap)
        title, description = copy[key]
        rect(pdf, x, 180, width, 182, WHITE)
        rect(pdf, x, 180, width, 2, PURPLE)
        text(pdf, key.upper(), x + 15, 195, 11, PURPLE, "Mono")
        text(pdf, title, x + 15, 219, 14, INK, "Segoe-Bold")
        block(pdf, description, x + 15, 248, width - 30, 11, limit=347)
    rect(pdf, M, 387, CONTENT, 89, "#EEE9F8")
    text(pdf, copy["draft_title"], M + 16, 399, 10, PURPLE, "Segoe-Bold")
    block(pdf, copy["draft"], M + 16, 422, CONTENT - 32, 11, INK, 472)
    text(pdf, copy["edit_title"], M, 513, 21, INK, "Segoe-Bold")
    block(pdf, copy["edit"], M, 550, CONTENT, 11, limit=616)
    for index, (name, detail) in enumerate(copy["formats"]):
        y = 628 + index * 37
        rule(pdf, M, y, W - M)
        text(pdf, name, M + 1, y + 8, 12, PURPLE, "Mono")
        text(pdf, detail, M + 81, y + 8, 12)
    rule(pdf, M, 739, W - M)
    pdf.showPage()


def main():
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for name, filename in (("Segoe", "segoeui.ttf"), ("Segoe-Bold", "segoeuib.ttf"), ("Mono", "consola.ttf")):
        pdfmetrics.registerFont(TTFont(name, fonts / filename))
    pdfmetrics.registerFontFamily("Segoe", normal="Segoe", bold="Segoe-Bold")
    for lang, copy in COPY.items():
        path = ROOT / "docs" / f"stars-clique-sync-guide-{lang}.pdf"
        pdf = canvas.Canvas(str(path), pagesize=A4, pageCompression=1, lang=lang)
        pdf.setTitle(f"Stars Clique Sync - {copy['manual']}")
        pdf.setAuthor(AUTHOR)
        pdf.setSubject("Stars Clique Sync v1 / Lite + Auto")
        cover(pdf, copy, lang)
        manual(pdf, copy, lang)
        review(pdf, copy, lang)
        pdf.save()


if __name__ == "__main__":
    main()
