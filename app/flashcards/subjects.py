"""科目（国試の9区分）。並び順は表示順。"""

SUBJECTS: tuple[str, ...] = (
    "物理", "化学", "生物", "衛生", "薬理", "薬剤",
    "病態・薬物治療", "法規・制度・倫理", "実務",
)


def check_subject(subject: str) -> str:
    subject = (subject or "").strip()
    if subject not in SUBJECTS:
        raise ValueError(f"科目が正しくありません: {subject!r}（{'・'.join(SUBJECTS)} のいずれか）")
    return subject
