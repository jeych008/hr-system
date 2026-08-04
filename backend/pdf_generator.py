import html
import io
import json
import os
import sys
import unicodedata

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.graphics.shapes import Circle, Drawing, String
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


BLUE = colors.HexColor("#155EEF")
TEXT = colors.HexColor("#101828")
MUTED = colors.HexColor("#667085")
LINE = colors.HexColor("#D0D5DD")
HEADER_BG = colors.HexColor("#EEF4FF")
CELL_BG = colors.HexColor("#FCFDFF")
WORK_BG = colors.HexColor("#FAFAFA")


def find_font():
    candidates = [
        os.environ.get("PDF_FONT_PATH"),
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for font_path in candidates:
        if not font_path or not os.path.isfile(font_path):
            continue
        try:
            pdfmetrics.registerFont(TTFont("ResumeCJK", font_path, subfontIndex=0))
            return "ResumeCJK"
        except Exception:
            continue
    # ReportLab cannot register some CFF-based Noto CJK collections as TTFont.
    # Keep PDF export available with its built-in Simplified Chinese CID font.
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


FONT = find_font()


def normalized(value, fallback="-"):
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    return text or fallback


def escaped(value, fallback="-"):
    return html.escape(normalized(value, fallback)).replace("\n", "<br/>")


BODY = ParagraphStyle(
    "ResumeBody", fontName=FONT, fontSize=9, leading=13, textColor=TEXT,
    wordWrap="CJK", splitLongWords=True,
)
LABEL = ParagraphStyle(
    "ResumeLabel", parent=BODY, fontSize=8, leading=12, textColor=MUTED,
)
NAME = ParagraphStyle(
    "ResumeName", parent=BODY, fontSize=20, leading=25, textColor=TEXT,
)
SUBTITLE = ParagraphStyle(
    "ResumeSubtitle", parent=BODY, fontSize=9, leading=13, textColor=MUTED,
)
DATE = ParagraphStyle(
    "ResumeDate", parent=BODY, fontSize=8, leading=11, textColor=MUTED, alignment=TA_RIGHT,
)
SECTION = ParagraphStyle(
    "ResumeSection", parent=BODY, fontSize=13, leading=19, textColor=TEXT,
)
FOOTER = ParagraphStyle(
    "ResumeFooter", parent=BODY, fontSize=8, leading=10, textColor=MUTED, alignment=TA_CENTER,
)


def paragraph(value, style=BODY, fallback="-"):
    return Paragraph(escaped(value, fallback), style)


def field(label, value, width):
    table = Table(
        [[paragraph(label, LABEL, ""), paragraph(value)]],
        colWidths=[25 * mm, max(width - 25 * mm, 10 * mm)],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return table


def section_title(title, width):
    table = Table([[paragraph(title, SECTION, "")]], colWidths=[width])
    table.setStyle(TableStyle([
        ("LINEBEFORE", (0, 0), (0, 0), 4, BLUE),
        ("LINEBELOW", (0, 0), (0, 0), 0.7, LINE),
        ("LEFTPADDING", (0, 0), (0, 0), 9),
        ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("TOPPADDING", (0, 0), (0, 0), 1),
        ("BOTTOMPADDING", (0, 0), (0, 0), 5),
    ]))
    return [Spacer(1, 5 * mm), table, Spacer(1, 3 * mm)]


def field_grid(items, width):
    cell_width = width / 2
    rows = []
    for index in range(0, len(items), 2):
        row = [field(*items[index], cell_width)]
        if index + 1 < len(items):
            row.append(field(*items[index + 1], cell_width))
        else:
            row.append("")
        rows.append(row)
    table = Table(rows, colWidths=[cell_width, cell_width], repeatRows=0)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), CELL_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def note_box(label, value, width):
    table = Table([[[paragraph(label, LABEL, ""), Spacer(1, 2 * mm), paragraph(value)]]], colWidths=[width])
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def work_box(work, width):
    half = (width - 12) / 2
    details = Table(
        [[field("公司名称", work.get("companyName"), half), field("职位", work.get("position"), half)]],
        colWidths=[half, half],
    )
    details.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    period = f"{normalized(work.get('startDate'))} 至 {normalized(work.get('endDate'))}"
    content = [
        details,
        Spacer(1, 2 * mm),
        field("起止时间", period, width - 16),
        Spacer(1, 2 * mm),
        paragraph("工作描述", LABEL, ""),
        Spacer(1, 1.5 * mm),
        paragraph(work.get("description")),
    ]
    table = Table([[content]], colWidths=[width])
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), WORK_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def header(candidate, width, generated_date):
    initial = normalized(candidate.get("name"), "简")[0]
    avatar_size = 13 * mm
    avatar = Drawing(avatar_size, avatar_size)
    avatar.add(Circle(avatar_size / 2, avatar_size / 2, avatar_size / 2, fillColor=colors.HexColor("#D0D5DD"), strokeColor=None))
    avatar.add(String(avatar_size / 2, avatar_size / 2 - 5, initial, fontName=FONT, fontSize=17, textAnchor="middle", fillColor=colors.HexColor("#344054")))
    expected = candidate.get("expectedLocation") or " ".join(filter(None, [candidate.get("expectedProvince"), candidate.get("expectedCity")]))
    identity = [
        paragraph(candidate.get("name") or "候选人", NAME),
        Spacer(1, 1.5 * mm),
        paragraph(f"应聘简历 | {normalized(candidate.get('education'))} | {normalized(expected)}", SUBTITLE),
    ]
    table = Table(
        [[avatar, identity, paragraph(f"生成时间：{generated_date}", DATE)]],
        colWidths=[18 * mm, width - 18 * mm - 40 * mm, 40 * mm],
    )
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#C8D7F5")),
        ("BACKGROUND", (0, 0), (-1, -1), HEADER_BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return table


def build_candidate(story, candidate, width, generated_date):
    experience = "是" if candidate.get("phoneCustomerServiceExperience", candidate.get("hasCustomerServiceExperience")) else "否"
    expected = candidate.get("expectedLocation") or " ".join(filter(None, [candidate.get("expectedProvince"), candidate.get("expectedCity")]))
    residence = candidate.get("currentResidence") or " ".join(filter(None, [candidate.get("currentResidenceProvince"), candidate.get("currentResidenceCity")]))
    source = "候选人自助" if candidate.get("source") == "SELF" else "HR录入"
    story.append(header(candidate, width, generated_date))
    story.extend(section_title("基础信息", width))
    story.append(field_grid([
        ("姓名", candidate.get("name")), ("性别", candidate.get("gender")),
        ("出生日期", candidate.get("birthDate")), ("学历", candidate.get("education")),
        ("手机号", candidate.get("phone")), ("邮箱", candidate.get("email")),
        ("身份证号", candidate.get("idCard")), ("电话客服经验", experience),
        ("婚姻状况", candidate.get("maritalStatus")), ("子女情况", candidate.get("childrenStatus")),
        ("毕业院校", candidate.get("graduationSchool")), ("所学专业", candidate.get("major")),
        ("普通话等级", candidate.get("mandarinLevel")), ("毕业时间", candidate.get("graduationTime")),
    ], width))
    story.extend(section_title("地点与求职信息", width))
    story.append(field_grid([
        ("当前居住地", residence), ("期望工作地点", expected),
        ("招聘渠道", candidate.get("recruitmentChannel")), ("应聘岗位", candidate.get("appliedPosition")),
        ("可到岗时间", candidate.get("availableDate")), ("资料来源", source),
    ], width))
    story.append(note_box("上一份工作离职原因", candidate.get("lastLeaveReason"), width))
    story.extend(section_title("工作经历", width))
    works = sorted(candidate.get("workExperiences") or [], key=lambda item: normalized(item.get("endDate"), ""), reverse=True)
    if not works:
        story.append(paragraph("暂无工作经历", SUBTITLE))
    for work in works:
        story.append(work_box(work, width))
        story.append(Spacer(1, 3 * mm))


def footer(canvas, document):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#F2F4F7"))
    canvas.rect((A4[0] - 52 * mm) / 2, 10 * mm, 52 * mm, 7 * mm, fill=1, stroke=0)
    canvas.setFont(FONT, 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(A4[0] / 2, 12.2 * mm, "内部保密资料")
    canvas.restoreState()


def main():
    payload = json.load(sys.stdin)
    candidates = payload.get("candidates") or []
    generated_date = normalized(payload.get("generatedDate"), "")
    output = io.BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=12 * mm,
        bottomMargin=22 * mm,
        title="候选人简历",
        author="人力资源管理平台",
        pageCompression=1,
    )
    story = []
    for index, candidate in enumerate(candidates):
        if index:
            story.append(PageBreak())
        build_candidate(story, candidate, document.width, generated_date)
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    sys.stdout.buffer.write(output.getvalue())


if __name__ == "__main__":
    main()
