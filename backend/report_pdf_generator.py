#!/usr/bin/env python3
import io
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def register_font():
    candidates = [
        os.environ.get("PDF_FONT_PATH", ""),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for font_path in candidates:
        if font_path and os.path.exists(font_path):
            try:
                pdfmetrics.registerFont(TTFont("ReportCN", font_path, subfontIndex=0))
                return "ReportCN"
            except Exception:
                continue
    return "Helvetica"


FONT = register_font()


def format_shanghai_datetime(value):
    if not value:
        return ""
    text = str(value)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
        return parsed.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return text
BLUE = colors.HexColor("#173B6C")
ORANGE = colors.HexColor("#D97706")
PRIMARY = colors.HexColor("#155EEF")
TEXT = colors.HexColor("#172033")
MUTED = colors.HexColor("#667085")
LINE = colors.HexColor("#D9DEE7")
LIGHT = colors.HexColor("#F6F7F9")


def para(text, style):
    escaped = str(text if text is not None else "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Paragraph(escaped, style)


def section_title(text, styles):
    return [Spacer(1, 4 * mm), para(text, styles["section"]), Spacer(1, 2 * mm)]


def comparison_table(report, styles):
    current = report.get("currentDayMetrics") or {}
    monthly = report.get("monthlyMetrics") or {}
    cumulative = report.get("metrics") or {}
    columns = [
        ("新增候选人", "candidateCount"),
        ("到面人数", "arrivedCount"),
        ("通过人数", "passedCount"),
        ("入职人数", "joinedCount"),
        ("离职人数", "leftCount"),
    ]
    data = [[para(label, styles["card_title"]) for label, _ in columns]]
    data.append([para(f"今日  {current.get(key, 0)}", styles["card_value_white"]) for _, key in columns])
    if report.get("monthlyMetrics"):
        data.append([para(f"本月  {monthly.get(key, 0)}", styles["card_value_white"]) for _, key in columns])
    data.append([para(f"累计  {cumulative.get(key, 0)}", styles["card_value_white"]) for _, key in columns])
    row_heights = [9 * mm] + [11 * mm] * (len(data) - 1)
    table = Table(data, colWidths=[51 * mm] * 5, rowHeights=row_heights)
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("BACKGROUND", (0, 1), (-1, 1), BLUE),
        ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#0F8A5F") if report.get("monthlyMetrics") else ORANGE),
        *([("BACKGROUND", (0, 3), (-1, 3), ORANGE)] if report.get("monthlyMetrics") else []),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    return table


def metrics_table(report, styles):
    metrics = report.get("metrics") or {}
    fields = [
        ("当前培训中人数", "trainingCount", ""),
        ("当前在岗人数", "onboardCount", ""),
        ("当前剩余缺口", "remainingGap", ""),
        ("总通过率", "passRate", "%"),
        ("目标完成率", "hcCompletionRate", "%"),
    ]
    data = []
    for label, key, suffix in fields:
        data.append(para(label, styles["metric_label"]))
        data.append(para(f"{metrics.get(key, 0)}{suffix}", styles["metric_value"]))
    table = Table([data], colWidths=[25 * mm, 25 * mm] * 5, rowHeights=[18 * mm])
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    return table


def line_chart(points):
    width, height = 252 * mm, 55 * mm
    drawing = Drawing(width, height)
    left, bottom, top = 12 * mm, 10 * mm, 7 * mm
    usable_w, usable_h = width - 18 * mm, height - bottom - top
    maximum = max([int(item.get("count", 0) or 0) for item in points] + [1])
    drawing.add(Line(left, bottom, left + usable_w, bottom, strokeColor=LINE))
    drawing.add(Line(left, bottom + usable_h, left + usable_w, bottom + usable_h, strokeColor=LINE, strokeDashArray=[3, 3]))
    coords = []
    for index, item in enumerate(points):
        x = left + (usable_w / max(1, len(points) - 1)) * index
        y = bottom + usable_h * int(item.get("count", 0) or 0) / maximum
        coords.extend([x, y])
        drawing.add(Circle(x, y, 1.2 * mm, fillColor=colors.white, strokeColor=PRIMARY, strokeWidth=1.2))
        if index == 0 or index == len(points) - 1 or index % 5 == 0:
            drawing.add(String(x, 2 * mm, str(item.get("date", ""))[5:], fontName=FONT, fontSize=6.5, textAnchor="middle", fillColor=MUTED))
    if len(coords) >= 4:
        drawing.add(PolyLine(coords, strokeColor=PRIMARY, strokeWidth=2, fillColor=None))
    drawing.add(String(left - 2 * mm, bottom + usable_h - 1 * mm, str(maximum), fontName=FONT, fontSize=7, textAnchor="end", fillColor=MUTED))
    drawing.add(String(left - 2 * mm, bottom - 1 * mm, "0", fontName=FONT, fontSize=7, textAnchor="end", fillColor=MUTED))
    return drawing


def distribution_tables(report, styles):
    labels = {"education": "学历分布", "gender": "性别分布", "experience": "电话客服经验分布", "age": "年龄段分布"}
    blocks = []
    for key in ["education", "gender", "experience", "age"]:
        values = (report.get("distributions") or {}).get(key) or {}
        total = sum(int(value or 0) for value in values.values())
        rows = [[para(labels[key], styles["table_head"]), para("数量", styles["table_head"]), para("占比", styles["table_head"])]]
        for label, value in values.items():
            percent = (int(value or 0) / total * 100) if total else 0
            rows.append([para(label, styles["cell"]), para(value, styles["cell_center"]), para(f"{percent:.1f}%", styles["cell_center"])])
        if len(rows) == 1:
            rows.append([para("暂无数据", styles["cell"]), "0", "0.0%"])
        table = Table(rows, colWidths=[40 * mm, 18 * mm, 20 * mm], repeatRows=1)
        table.setStyle(standard_table_style())
        blocks.append(table)
    return Table([[blocks[0], blocks[1], blocks[2]], [blocks[3], "", ""]], colWidths=[84 * mm] * 3, hAlign="LEFT")


def standard_table_style():
    return TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ])


def project_table(items, styles, today=False, monthly=False):
    if today:
        headers = ["项目", "日期", "新增", "到面", "通过", "入职", "离职", "培训中", "当前在职"]
        keys = ["projectName", "date", "newCandidateCount", "arrivedCount", "passedCount", "joinedCount", "leftCount", "trainingCount", "onboardCount"]
        widths = [46, 24, 20, 20, 20, 20, 20, 22, 25]
    else:
        prefix = "本月" if monthly else "累计"
        headers = ["项目", f"{prefix}候选人", "到面", "通过", "入职", "离职", "培训中", "在岗", "缺口", "通过率", "目标完成率"]
        keys = ["projectName", "candidateCount", "arrivedCount", "passedCount", "joinedCount", "leftCount", "trainingCount", "onboardCount", "remainingGap", "passRate", "hcCompletionRate"]
        widths = [43, 25, 19, 19, 19, 19, 21, 19, 19, 23, 27]
    rows = [[para(header, styles["table_head"]) for header in headers]]
    for item in items:
        values = []
        for key in keys:
            value = item.get(key, 0)
            if key in ["passRate", "hcCompletionRate"]:
                value = f"{value}%"
            values.append(para(value, styles["cell_center"] if key != "projectName" else styles["cell"]))
        rows.append(values)
    if len(rows) == 1:
        rows.append([para("暂无数据", styles["cell"])] + [""] * (len(headers) - 1))
    table = Table(rows, colWidths=[value * mm for value in widths], repeatRows=1)
    table.setStyle(standard_table_style())
    return table


def project_bar_chart(items):
    width, height = 252 * mm, 58 * mm
    drawing = Drawing(width, height)
    maximum = max([int(item.get("joinedCount", 0) or 0) for item in items] + [1])
    count = max(1, len(items))
    slot = width / count
    baseline = 13 * mm
    max_height = 35 * mm
    for index, item in enumerate(items):
        value = int(item.get("joinedCount", 0) or 0)
        bar_height = max(1.5, max_height * value / maximum)
        x = index * slot + slot * 0.31
        drawing.add(Rect(x, baseline, slot * 0.38, bar_height, fillColor=ORANGE, strokeColor=None))
        drawing.add(String(index * slot + slot / 2, baseline + bar_height + 2 * mm, str(value), fontName=FONT, fontSize=8, textAnchor="middle", fillColor=TEXT))
        name = str(item.get("projectName", ""))
        if len(name) > 10:
            name = name[:9] + "…"
        drawing.add(String(index * slot + slot / 2, 4 * mm, name, fontName=FONT, fontSize=7, textAnchor="middle", fillColor=MUTED))
    drawing.add(Line(0, baseline, width, baseline, strokeColor=LINE))
    return drawing


def build_pdf(report):
    output = io.BytesIO()
    doc = SimpleDocTemplate(
        output, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=13 * mm, bottomMargin=13 * mm, title=f"{report.get('date', '')} 招聘日报"
    )
    base = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle("title", parent=base["Title"], fontName=FONT, fontSize=20, leading=26, textColor=TEXT, alignment=TA_CENTER, spaceAfter=3 * mm),
        "meta": ParagraphStyle("meta", parent=base["Normal"], fontName=FONT, fontSize=9, leading=13, textColor=MUTED, alignment=TA_CENTER),
        "section": ParagraphStyle("section", parent=base["Heading2"], fontName=FONT, fontSize=13, leading=18, textColor=TEXT, spaceAfter=2 * mm),
        "card_title": ParagraphStyle("card_title", parent=base["Normal"], fontName=FONT, fontSize=9, leading=12, alignment=TA_CENTER, textColor=TEXT),
        "card_value_white": ParagraphStyle("card_value_white", parent=base["Normal"], fontName=FONT, fontSize=13, leading=16, alignment=TA_CENTER, textColor=colors.white),
        "metric_label": ParagraphStyle("metric_label", parent=base["Normal"], fontName=FONT, fontSize=8, leading=11, alignment=TA_CENTER, textColor=MUTED),
        "metric_value": ParagraphStyle("metric_value", parent=base["Normal"], fontName=FONT, fontSize=15, leading=18, alignment=TA_CENTER, textColor=TEXT),
        "table_head": ParagraphStyle("table_head", parent=base["Normal"], fontName=FONT, fontSize=7.5, leading=10, textColor=MUTED, alignment=TA_CENTER),
        "cell": ParagraphStyle("cell", parent=base["Normal"], fontName=FONT, fontSize=7.5, leading=10, textColor=TEXT),
        "cell_center": ParagraphStyle("cell_center", parent=base["Normal"], fontName=FONT, fontSize=7.5, leading=10, textColor=TEXT, alignment=TA_CENTER),
    }
    story = [
        para(f"{report.get('projectName', '招聘')}招聘日报", styles["title"]),
        para(f"统计日期：{report.get('date', '-')}　生成时间：{format_shanghai_datetime(report.get('generatedAt')) or '-'}", styles["meta"]),
        Spacer(1, 5 * mm), comparison_table(report, styles), Spacer(1, 4 * mm), metrics_table(report, styles),
    ]
    story += section_title(f"{report.get('reportMonth', '')} 每日入职人数", styles)
    story.append(line_chart(report.get("dailyJoinTrend") or []))
    story += section_title("候选人分布", styles)
    story.append(distribution_tables(report, styles))
    story.append(PageBreak())
    has_monthly_projects = bool(report.get("monthlyByProject"))
    story += section_title("本月按项目统计" if has_monthly_projects else "按项目累计统计", styles)
    story.append(project_table(report.get("monthlyByProject") or report.get("byProject") or [], styles, monthly=has_monthly_projects))
    story += section_title("当日各项目入职对比", styles)
    story.append(project_bar_chart(report.get("todayByProject") or []))
    story += section_title("当日各项目招聘数据", styles)
    story.append(project_table(report.get("todayByProject") or [], styles, today=True))

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont(FONT, 7)
        canvas.setFillColor(MUTED)
        canvas.drawCentredString(landscape(A4)[0] / 2, 6 * mm, f"内部管理资料 · 第 {document.page} 页")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def main():
    payload = json.load(sys.stdin)
    report = payload.get("report") or {}
    sys.stdout.buffer.write(build_pdf(report))


if __name__ == "__main__":
    main()
